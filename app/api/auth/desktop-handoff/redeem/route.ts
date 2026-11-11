import { NextRequest, NextResponse } from 'next/server';
import { cookies } from 'next/headers';
import { logger } from '@/lib/logger';
import { MAX_ACCOUNT_SLOTS } from '@/lib/account-utils';
import { loginClientAddress } from '@/lib/auth/client-address';
import { desktopHandoffEnabled } from '@/lib/auth/desktop-handoff-server';
import { revokeParkedTokens } from '@/lib/auth/desktop-handoff-revoke';
import { configManager } from '@/lib/admin/config-manager';
import { isHandoffCode, isHandoffCodeVerifier, redeemHandoff, reserveHandoffRedeem } from '@/lib/auth/handoff-store';
import { writeSignInStamp } from '@/lib/auth/session-age';
import { hasSessionSecret } from '@/lib/auth/session-secret';
import { isStoreUnavailable, storeUnavailableResponse } from '@/lib/auth/store-unavailable';
import type { BudgetRefund } from '@/lib/auth/verify-budget';
import { IS_DESKTOP_BUILD } from '@/lib/desktop/flag';
import { jmapServerAllowed } from '@/lib/desktop/policy-schema';
import { getCookieOptions, getSignInCookieOptions } from '@/lib/oauth/cookie-config';
import { storeIdToken } from '@/lib/oauth/end-session';
import { refreshTokenCookieName, refreshTokenServerCookieName } from '@/lib/oauth/tokens';
import { writeCustomUpstream } from '@/lib/oauth/custom-upstream';
import { DEFAULT_CLIENT_ID } from '@/lib/oauth/token-exchange';
import { stalwartDefaultClientId } from '@/lib/auth/stalwart-password-login';
import { rejectCrossOriginRequest } from '@/lib/security/same-origin';

// The desktop app's side of "Sign in with your browser", on an instance. The app's own
// page posts the code its loopback listener received, with the PKCE verifier behind the
// challenge it opened the browser with. Same origin as the page, so an instance's cookies
// set here work under SameSite=Strict. Every attempt spends the code.
//
// The device's rules are the page's to send: only it knows the OS policy, and the browser
// the user signed in with knows nothing of it. That's its list of servers, and whether it
// may use a server of the user's own. A refused server gets nothing written, and a token
// minted for it is revoked.

const NO_STORE = { 'Cache-Control': 'no-store' };

function answer(error: string, status: number, extra: Record<string, unknown> = {}) {
  return NextResponse.json({ error, ...extra }, { status, headers: NO_STORE });
}

export async function POST(request: NextRequest) {
  if (IS_DESKTOP_BUILD) return answer('Not found', 404);
  const crossOrigin = rejectCrossOriginRequest(request);
  if (crossOrigin) return crossOrigin;
  await configManager.ensureLoaded();
  if (!desktopHandoffEnabled()) return answer('disabled', 403);
  let refund: BudgetRefund | null = null;
  try {
    refund = await reserveHandoffRedeem(loginClientAddress(request));
    if (!refund) return answer('too_many_requests', 429);

    const body = await request.json().catch(() => null);
    const code = body?.code;
    const verifier = body?.code_verifier;
    if (!isHandoffCode(code)) return answer('invalid_request', 400);
    if (!isHandoffCodeVerifier(verifier)) {
      await redeemHandoff(code, '');
      return answer('invalid_verifier', 400);
    }
    const slot = typeof body?.slot === 'number' && Number.isInteger(body.slot) && body.slot >= 0 && body.slot < MAX_ACCOUNT_SLOTS ? body.slot : 0;
    const remember = body?.remember !== false;
    const allowedServers = Array.isArray(body?.allowed_servers) ? (body.allowed_servers as string[]) : null;

    const result = await redeemHandoff(code, verifier);
    if (!result.ok) {
      logger.warn('Desktop hand-off redeem refused', { reason: result.reason });
      return answer(result.reason === 'verifier_mismatch' ? 'invalid_verifier' : `${result.reason}_code`, 400);
    }
    const parked = result.bundle;
    // A code the mobile path parked isn't one of ours.
    if (parked.flow !== 'desktop-password' && parked.flow !== 'desktop-tokens') return answer('invalid_code', 400);
    if (!jmapServerAllowed(allowedServers, parked.server_url) || (parked.custom && body?.custom_servers_allowed !== true)) {
      await revokeParkedTokens(parked);
      return answer('blocked_by_policy', 403, { code: 'blocked_by_policy' });
    }

    await refund();
    logger.info('Desktop hand-off redeemed', { flow: parked.flow });

    if (parked.flow === 'desktop-password') {
      // Down the app's normal login path, from the page, like a typed password.
      return NextResponse.json(
        { flow: 'password', server_url: parked.server_url, username: parked.username, password: parked.password },
        { headers: NO_STORE },
      );
    }

    const cookieStore = await cookies();
    // A typed server's token is only kept where it can be sealed to that
    // server: without a session secret its renewal would go to the configured one.
    const refreshToken = parked.custom && !hasSessionSecret() ? undefined : parked.refresh_token;
    if (refreshToken) {
      const options = getSignInCookieOptions(remember);
      cookieStore.set(refreshTokenCookieName(slot), refreshToken, options);
      // A server the user typed is in no configured list: the refresh is told
      // where the token belongs and which client it was issued to, as the
      // park route signed in (lib/oauth/custom-upstream.ts).
      const upstream = parked.custom
        ? {
            serverUrl: parked.server_url.replace(/\/+$/, ''),
            clientId: await stalwartDefaultClientId(
              parked.server_url,
              configManager.get<string>('oauthClientId', '') || process.env.OAUTH_CLIENT_ID || DEFAULT_CLIENT_ID,
              false,
            ),
          }
        : null;
      if (upstream) writeCustomUpstream(cookieStore, slot, upstream, remember);
      // The token is renewed and revoked only at the server that issued it.
      writeSignInStamp(cookieStore, slot, {
        signedInAt: parked.signed_in_at,
        refreshToken,
        serverId: parked.server_id,
        ...(upstream ? { customServer: upstream.serverUrl } : {}),
      }, options);
    }
    const serverCookie = refreshTokenServerCookieName(slot);
    if (parked.server_id) cookieStore.set(serverCookie, parked.server_id, getCookieOptions());
    else cookieStore.delete(serverCookie);
    storeIdToken(cookieStore, slot, parked.id_token, request.nextUrl.basePath, [parked.refresh_token, parked.server_id], remember);

    return NextResponse.json(
      {
        flow: 'tokens',
        server_url: parked.server_url,
        ...(parked.password_login && parked.username ? { password_login: true, username: parked.username } : {}),
        access_token: parked.access_token,
        expires_in: parked.expires_in,
        signed_in_at: parked.signed_in_at,
        remember,
      },
      { headers: NO_STORE },
    );
  } catch (error) {
    if (isStoreUnavailable(error)) {
      if (refund) await refund();
      return storeUnavailableResponse(NO_STORE);
    }
    logger.error('Desktop hand-off redeem error', { error: error instanceof Error ? error.message : 'Unknown error' });
    return answer('Internal server error', 500);
  }
}
