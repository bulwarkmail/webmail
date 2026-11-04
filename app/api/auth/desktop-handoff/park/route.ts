import { NextRequest, NextResponse } from 'next/server';
import { logger } from '@/lib/logger';
import { configManager } from '@/lib/admin/config-manager';
import { findServerById, findServerByUrl, parseJmapServers, resolveTrustedJmapUrl } from '@/lib/admin/jmap-servers';
import { loginClientAddress } from '@/lib/auth/client-address';
import { isHandoffCodeChallenge, reserveHandoffCreate, stashHandoff } from '@/lib/auth/handoff-store';
import { isStoreUnavailable, storeUnavailableResponse } from '@/lib/auth/store-unavailable';
import { stalwartPasswordLogin } from '@/lib/auth/stalwart-password-login';
import { LOGIN_BUDGET_RETRY_AFTER_SECONDS, reserveLoginAttempt } from '@/lib/auth/verify-budget';
import { JmapAuthVerificationError, verifyJmapAuth } from '@/lib/auth/verify-jmap-auth';
import { IS_DESKTOP_BUILD } from '@/lib/desktop/flag';
import { readFileEnv } from '@/lib/read-file-env';
import { DEFAULT_CLIENT_ID } from '@/lib/oauth/token-exchange';
import { rejectCrossOriginRequest } from '@/lib/security/same-origin';
import { isPublicHttpUrl } from '@/lib/security/url-guard';

// The desktop app's "Sign in with your browser", on the browser's side. The app opened
// this instance's login page with a PKCE challenge. The page posts the password here
// instead of signing the browser in: the user came to sign the app in, and a session
// left in their default browser is something they didn't ask for. So nothing here
// writes a cookie. The password is checked against the mail server and parked, and the
// page takes the code to the app's loopback listener once the user has confirmed.
//
// With a two-factor code the code is spent here, so what's parked is the tokens it gets,
// not the password: the app could never present that code a second time.

const NO_STORE = { 'Cache-Control': 'no-store' };

function bounded(value: unknown, max: number): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= max;
}

function answer(error: string, status: number) {
  return NextResponse.json({ error }, { status, headers: NO_STORE });
}

export async function POST(request: NextRequest) {
  if (IS_DESKTOP_BUILD) return answer('Not found', 404);
  const crossOrigin = rejectCrossOriginRequest(request);
  if (crossOrigin) return crossOrigin;
  try {
    const body = await request.json().catch(() => null);
    const challenge = body?.code_challenge;
    const state = typeof body?.state === 'string' ? body.state : '';
    const totp = typeof body?.totp === 'string' && body.totp ? body.totp : undefined;
    const requestedServerId = typeof body?.server_id === 'string' && body.server_id ? body.server_id : null;
    if (
      !isHandoffCodeChallenge(challenge)
      || !state
      || state.length > 512
      || !bounded(body?.server_url, 2048)
      || !bounded(body?.username, 512)
      || !bounded(body?.password, 4096)
      || (totp !== undefined && totp.length > 16)
    ) {
      return answer('invalid_request', 400);
    }

    await configManager.ensureLoaded();
    if (configManager.get<boolean>('oauthEnabled', false) && configManager.get<boolean>('oauthOnly', false)) {
      return answer('oauth_only', 403);
    }

    // The same pinning as the sign-in routes.
    const serverUrl: string = body.server_url;
    // This route is the browser's. It has no business with the device's policy.
    const configured =
      configManager.get<string>('jmapServerUrl', '') || process.env.JMAP_SERVER_URL || process.env.NEXT_PUBLIC_JMAP_SERVER_URL || '';
    const list = parseJmapServers(configManager.get<unknown>('jmapServers', []));
    const allowCustom = configManager.get<boolean>('allowCustomJmapEndpoint', false);
    const entry = findServerById(list, requestedServerId) || findServerByUrl(list, serverUrl);
    // What's checked is what's parked: the app signs in to this one, whatever the body said.
    let resolved: string;
    let trusted = true;
    if (entry) {
      resolved = entry.url;
    } else {
      const pinned = resolveTrustedJmapUrl(serverUrl, configured, list);
      if (pinned) {
        resolved = pinned;
      } else if (allowCustom && (await isPublicHttpUrl(serverUrl))) {
        resolved = serverUrl;
        trusted = false;
      } else {
        return answer('invalid_server_url', 400);
      }
    }
    const upstream = resolved.replace(/\/+$/, '');

    const clientIp = loginClientAddress(request, upstream);
    const refund = await reserveLoginAttempt(clientIp);
    if (!refund) {
      return NextResponse.json(
        { error: 'too_many_attempts' },
        { status: 429, headers: { ...NO_STORE, 'Retry-After': String(LOGIN_BUDGET_RETRY_AFTER_SECONDS) } },
      );
    }

    let parked: Parameters<typeof stashHandoff>[0];
    if (totp) {
      const configuredClientId =
        entry?.oauth?.clientId || configManager.get<string>('oauthClientId', '') || process.env.OAUTH_CLIENT_ID;
      const clientSecret =
        entry?.oauth?.clientSecret
        || configManager.get<string>('oauthClientSecret', '')
        || process.env.OAUTH_CLIENT_SECRET
        || readFileEnv(process.env.OAUTH_CLIENT_SECRET_FILE)
        || '';
      const redirectUri = typeof body?.redirect_uri === 'string' && /^https?:\/\//.test(body.redirect_uri) ? body.redirect_uri : upstream;
      const result = await stalwartPasswordLogin({
        serverUrl: upstream,
        username: body.username,
        password: body.password,
        totp,
        clientId: configuredClientId || DEFAULT_CLIENT_ID,
        clientSecret,
        redirectUri,
        trusted,
        clientIp,
        registerUnknownClient: !configuredClientId,
      });
      if (result.ok || result.error !== 'invalid_credentials') await refund();
      if (!result.ok) {
        if (result.error === 'invalid_credentials') return answer('invalid_credentials', 401);
        if (result.error === 'totp_required') return answer('totp_required', 401);
        return answer('login_failed', 502);
      }
      parked = {
        flow: 'desktop-tokens',
        server_url: resolved,
        server_id: entry?.id ?? null,
        access_token: result.tokens.access_token,
        refresh_token: result.tokens.refresh_token,
        expires_in: result.tokens.expires_in ?? 3600,
        signed_in_at: Date.now(),
      };
    } else {
      try {
        await verifyJmapAuth(upstream, `Basic ${Buffer.from(`${body.username}:${body.password}`).toString('base64')}`, { trusted, clientIp });
        await refund();
      } catch (error) {
        const status = error instanceof JmapAuthVerificationError ? error.upstreamStatus : undefined;
        if (status === 401) return answer('invalid_credentials', 401);
        await refund();
        // Stalwart: the right password on an account with a second factor.
        if (status === 402) return answer('totp_required', 401);
        return answer('login_failed', 502);
      }
      parked = { flow: 'desktop-password', server_url: resolved, server_id: entry?.id ?? null, username: body.username, password: body.password };
    }

    if (!(await reserveHandoffCreate(clientIp))) return answer('too_many_requests', 429);
    const code = await stashHandoff(parked, { challenge, state, awaitConfirm: true });
    logger.info('Desktop hand-off parked', { flow: parked.flow });
    return NextResponse.json({ code }, { headers: NO_STORE });
  } catch (error) {
    if (isStoreUnavailable(error)) return storeUnavailableResponse(NO_STORE);
    logger.error('Desktop hand-off park error', { error: error instanceof Error ? error.message : 'Unknown error' });
    return answer('Internal server error', 500);
  }
}
