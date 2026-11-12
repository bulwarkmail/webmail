import { NextRequest, NextResponse } from 'next/server';
import { cookies } from 'next/headers';
import { logger } from '@/lib/logger';
import { decryptPayload } from '@/lib/auth/crypto';
import {
  exchangeCodeForTokens,
  getRequiredConfig,
  getTokenEndpoint,
  hasClientSecret,
} from '@/lib/oauth/token-exchange';
import { buildRedeemBundle } from '@/lib/auth/pair-bundle';
import { isHandoffCodeChallenge, stashHandoff } from '@/lib/auth/handoff-store';
import { desktopHandoffTarget } from '@/lib/auth/mobile-handoff';
import { isStoreUnavailable, storeUnavailableResponse } from '@/lib/auth/store-unavailable';
import { refreshTokenCookieName, refreshTokenServerCookieName } from '@/lib/oauth/tokens';
import { getCookieOptions, getSignInCookieOptions } from '@/lib/oauth/cookie-config';
import { storeIdToken } from '@/lib/oauth/end-session';
import { rejectCrossOriginRequest } from '@/lib/security/same-origin';
import { rejectNonJsonBody } from '@/app/api/auth/json-request';
import { MAX_ACCOUNT_SLOTS } from '@/lib/account-utils';
import { writeSignInStamp } from '@/lib/auth/session-age';
import { callbackIssuerAccepted } from '@/lib/oauth/discovery';

const SSO_PENDING_COOKIE = 'sso_pending';
const SSO_PENDING_MAX_AGE_MS = 5 * 60 * 1000; // 5 minutes

/**
 * The webmail's public base (origin + mount path) from the callback URL the
 * flow started with (`<base>/<locale>/auth/callback`, same-origin checked at
 * /sso/start): where a phone renews through the token proxy.
 */
function webmailBaseFromCallback(redirectUri: string): string | null {
  try {
    const url = new URL(redirectUri);
    return `${url.origin}${url.pathname.replace(/\/[^/]+\/auth\/callback\/?$/, '').replace(/\/+$/, '')}`;
  } catch {
    return null;
  }
}

/**
 * Who just signed in, for the question the desktop app's hand-off asks: the id token says, as
 * it came straight from the provider, and otherwise the mail server's session does.
 */
async function accountName(serverUrl: string, accessToken: string, idToken: string | undefined): Promise<string> {
  try {
    const claims = JSON.parse(Buffer.from((idToken ?? '').split('.')[1] ?? '', 'base64url').toString('utf8')) as Record<string, unknown>;
    for (const claim of ['email', 'preferred_username', 'name']) {
      if (typeof claims[claim] === 'string' && claims[claim]) return claims[claim] as string;
    }
  } catch {
    // Not a JWT, or none: the server can say.
  }
  try {
    const session = await fetch(`${serverUrl.replace(/\/+$/, '')}/.well-known/jmap`, {
      headers: { Authorization: `Bearer ${accessToken}` },
      redirect: 'error',
      signal: AbortSignal.timeout(5000),
    });
    const body = (await session.json()) as { username?: unknown };
    return typeof body.username === 'string' ? body.username : '';
  } catch {
    return '';
  }
}

export async function POST(request: NextRequest) {
  // CSRF gate (GHSA-qvr9-m8cq-7wvg): cookies written here are SameSite=Lax,
  // so a cross-site top-level POST would otherwise reach this handler.
  const crossOrigin = rejectCrossOriginRequest(request);
  if (crossOrigin) return crossOrigin;
  const notJson = rejectNonJsonBody(request);
  if (notJson) return notJson;
  const cookieStore = await cookies();

  try {
    const { code, state, slot: bodySlot, iss } = await request.json();

    if (!code || !state) {
      return NextResponse.json({ error: 'Missing code or state' }, { status: 400 });
    }

    // Per-account refresh-token cookie slot. Without this the route hardcoded
    // slot 0, so the "+ Add Account" flow overwrote the first account's
    // refresh-token cookie. Default to 0 for back-compat with any caller that
    // omits slot. Mirrors the validation in /api/auth/token POST: slots run
    // up to MAX_ACCOUNT_SLOTS, so a sixth account must not land on slot 0.
    const slot = typeof bodySlot === 'number' && Number.isInteger(bodySlot)
      && bodySlot >= 0 && bodySlot < MAX_ACCOUNT_SLOTS ? bodySlot : 0;

    // Read and decrypt the pending SSO cookie
    const pendingCookie = cookieStore.get(SSO_PENDING_COOKIE)?.value;
    if (!pendingCookie) {
      logger.warn('SSO complete: no pending cookie found');
      return NextResponse.json({ error: 'No pending SSO session. Please start the login flow again.' }, { status: 400 });
    }

    const pending = decryptPayload(pendingCookie, 'sso-pending');
    if (!pending) {
      cookieStore.delete(SSO_PENDING_COOKIE);
      return NextResponse.json({ error: 'Invalid SSO session' }, { status: 400 });
    }

    // Validate state
    if (pending.state !== state) {
      logger.warn('SSO complete: state mismatch');
      cookieStore.delete(SSO_PENDING_COOKIE);
      return NextResponse.json({ error: 'State mismatch' }, { status: 400 });
    }

    // Validate TTL
    const createdAt = pending.created_at as number;
    if (!createdAt || Date.now() - createdAt > SSO_PENDING_MAX_AGE_MS) {
      logger.warn('SSO complete: pending session expired');
      cookieStore.delete(SSO_PENDING_COOKIE);
      return NextResponse.json({ error: 'SSO session expired. Please try again.' }, { status: 400 });
    }

    // A step-up for device pairing completes at /api/auth/reauth/sso/complete
    // only; here it would sign this browser in as whoever answered the prompt.
    if (pending.purpose === 'reauth') {
      logger.warn('SSO complete: refused a pairing re-auth session');
      cookieStore.delete(SSO_PENDING_COOKIE);
      return NextResponse.json({ error: 'Not a login session' }, { status: 400 });
    }

    const codeVerifier = pending.code_verifier as string;
    const redirectUri = pending.redirect_uri as string;
    const pendingServerId = typeof pending.server_id === 'string' ? pending.server_id : null;
    const mobileRedirectUri =
      typeof pending.mobile_redirect_uri === 'string' ? pending.mobile_redirect_uri : null;
    const mobileState = typeof pending.mobile_state === 'string' ? pending.mobile_state : null;
    const isMobileFlow = Boolean(mobileRedirectUri);
    const mobileCodeChallenge = isHandoffCodeChallenge(pending.mobile_code_challenge)
      ? pending.mobile_code_challenge
      : null;
    const remember = pending.remember !== false;

    if (!codeVerifier || !redirectUri) {
      cookieStore.delete(SSO_PENDING_COOKIE);
      return NextResponse.json({ error: 'Invalid SSO session data' }, { status: 400 });
    }

    // RFC 9207: a code answered by another issuer than the one this sign-in
    // was sent to is refused before the code or the verifier goes anywhere.
    // The callback page passes `iss` on; a missing one is refused when the
    // provider says it always sends it.
    if (!callbackIssuerAccepted(iss, pending.issuer, pending.iss_required === true)) {
      logger.warn('SSO complete: the answer came from another issuer than the one asked');
      cookieStore.delete(SSO_PENDING_COOKIE);
      return NextResponse.json({ error: 'Issuer mismatch' }, { status: 400 });
    }

    // Exchange code for tokens
    const tokens = await exchangeCodeForTokens(code, codeVerifier, redirectUri, pendingServerId);
    const signedInAt = Date.now();

    // For the mobile handoff flow the tokens are handed back to the app
    // verbatim - we deliberately don't write any cookies on the webmail
    // origin (the mobile browser tab disposes of the session after the
    // redirect anyway, but the cookie would still get committed to the
    // user's main webmail session if they happened to be logged in there).
    if (!isMobileFlow) {
      if (tokens.refresh_token) {
        const cookieName = refreshTokenCookieName(slot);
        // Without "Remember me" the sign-in ends with the browser session.
        const options = getSignInCookieOptions(remember);
        cookieStore.set(cookieName, tokens.refresh_token, options);
        // A sign-in: the maximum session length counts from here (lib/auth/session-age.ts),
        // and the token is renewed and revoked only at this server.
        writeSignInStamp(cookieStore, slot, { signedInAt, refreshToken: tokens.refresh_token, serverId: pendingServerId }, options);
      }
      const serverCookieName = refreshTokenServerCookieName(slot);
      if (pendingServerId) {
        cookieStore.set(serverCookieName, pendingServerId, getCookieOptions());
      } else {
        cookieStore.delete(serverCookieName);
      }
      storeIdToken(cookieStore, slot, tokens.id_token, request.nextUrl.basePath, [tokens.refresh_token, pendingServerId], remember);
    }

    // Delete pending cookie
    cookieStore.delete(SSO_PENDING_COOKIE);

    if (isMobileFlow) {
      // The mobile client needs the bits it can't re-derive: the refresh
      // token, the token endpoint it should hit to refresh later, and the
      // client_id the IdP expects on that refresh call. The server URL is
      // returned so the app knows which JMAP host to connect to. A phone
      // cannot renew with a confidential client's secret, and current app
      // builds refuse a provider on another host, so those renew through
      // this webmail - the same bundle a paired phone gets.
      const { clientId, serverUrl } = getRequiredConfig(pendingServerId);
      if (mobileRedirectUri && desktopHandoffTarget(mobileRedirectUri)) {
        // The desktop app on this instance: its redeem writes its own cookies, the way
        // the code below would have for this browser. sso/start made sure of a challenge.
        if (!mobileCodeChallenge) throw new Error('desktop hand-off without a challenge');
        const handoffCode = await stashHandoff({
          flow: 'desktop-tokens',
          server_url: serverUrl,
          server_id: pendingServerId,
          custom: false,
          access_token: tokens.access_token,
          refresh_token: tokens.refresh_token,
          id_token: tokens.id_token,
          expires_in: tokens.expires_in ?? 3600,
          signed_in_at: signedInAt,
        }, { challenge: mobileCodeChallenge, state: mobileState ?? '', awaitConfirm: true });
        logger.info('Desktop hand-off parked', { flow: 'desktop-tokens' });
        return NextResponse.json({
          mobile_handoff_code: handoffCode,
          server_url: serverUrl,
          account: await accountName(serverUrl, tokens.access_token, tokens.id_token),
          mobile_redirect_uri: mobileRedirectUri,
          mobile_state: mobileState,
        });
      }
      const bundle = buildRedeemBundle({
        flow: 'oauth',
        serverUrl,
        serverId: pendingServerId,
        accessToken: tokens.access_token,
        refreshToken: tokens.refresh_token,
        expiresIn: tokens.expires_in,
        issuedAt: Date.now(),
        tokenEndpoint: await getTokenEndpoint(pendingServerId),
        clientId,
        confidential: hasClientSecret(pendingServerId),
        trusted: true,
      }, webmailBaseFromCallback(redirectUri));
      if (bundle.flow !== 'oauth') throw new Error('unexpected bundle');
      if (mobileCodeChallenge) {
        // The app sent a PKCE challenge: park the tokens and give the browser
        // only a one-time code for the link (lib/auth/handoff-store.ts). The
        // tokens never reach the page. The code starts working when the user
        // confirms the hand-off (/api/auth/handoff/confirm).
        const handoffCode = await stashHandoff(bundle, {
          challenge: mobileCodeChallenge,
          state: mobileState ?? '',
          awaitConfirm: true,
        });
        logger.info('Mobile hand-off parked', { flow: 'oauth' });
        return NextResponse.json({
          mobile_handoff_code: handoffCode,
          server_url: bundle.server_url,
          mobile_redirect_uri: mobileRedirectUri,
          mobile_state: mobileState,
        });
      }
      return NextResponse.json({
        access_token: bundle.access_token,
        expires_in: bundle.expires_in,
        refresh_token: bundle.refresh_token,
        token_endpoint: bundle.token_endpoint,
        client_id: bundle.client_id,
        server_url: bundle.server_url,
        mobile_redirect_uri: mobileRedirectUri,
        mobile_state: mobileState,
      });
    }

    return NextResponse.json({
      access_token: tokens.access_token,
      expires_in: tokens.expires_in,
      signed_in_at: signedInAt,
      remember,
    });
  } catch (error) {
    // Clean up pending cookie on any error
    cookieStore.delete(SSO_PENDING_COOKIE);
    // The mobile hand-off can't be parked without the shared store.
    if (isStoreUnavailable(error)) return storeUnavailableResponse();
    logger.error('SSO complete error', { error: error instanceof Error ? error.message : 'Unknown error' });
    return NextResponse.json({ error: 'Token exchange failed' }, { status: 401 });
  }
}
