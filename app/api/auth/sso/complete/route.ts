import { NextRequest, NextResponse } from 'next/server';
import { cookies } from 'next/headers';
import { logger } from '@/lib/logger';
import { decryptPayload } from '@/lib/auth/crypto';
import {
  exchangeCodeForTokens,
  getRequiredConfig,
  getTokenEndpoint,
} from '@/lib/oauth/token-exchange';
import { refreshTokenCookieName, refreshTokenServerCookieName } from '@/lib/oauth/tokens';
import { getCookieOptions } from '@/lib/oauth/cookie-config';
import { MAX_ACCOUNT_SLOTS } from '@/lib/account-utils';

const SSO_PENDING_COOKIE = 'sso_pending';
const SSO_PENDING_MAX_AGE_MS = 5 * 60 * 1000; // 5 minutes

export async function POST(request: NextRequest) {
  const cookieStore = await cookies();

  try {
    const { code, state, slot: bodySlot } = await request.json();

    if (!code || !state) {
      return NextResponse.json({ error: 'Missing code or state' }, { status: 400 });
    }

    // Default to 0 for back-compat with any caller that omits slot. An
    // out-of-range slot must never fall back to 0 either: the client records
    // the slot it asked for, so writing elsewhere strands this login and
    // overwrites another account's refresh token.
    const slot = typeof bodySlot === 'number' && bodySlot >= 0 && bodySlot < MAX_ACCOUNT_SLOTS ? bodySlot : 0;

    // Read and decrypt the pending SSO cookie
    const pendingCookie = cookieStore.get(SSO_PENDING_COOKIE)?.value;
    if (!pendingCookie) {
      logger.warn('SSO complete: no pending cookie found');
      return NextResponse.json({ error: 'No pending SSO session. Please start the login flow again.' }, { status: 400 });
    }

    const pending = decryptPayload(pendingCookie);
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

    const codeVerifier = pending.code_verifier as string;
    const redirectUri = pending.redirect_uri as string;
    const pendingServerId = typeof pending.server_id === 'string' ? pending.server_id : null;
    const mobileRedirectUri =
      typeof pending.mobile_redirect_uri === 'string' ? pending.mobile_redirect_uri : null;
    const mobileState = typeof pending.mobile_state === 'string' ? pending.mobile_state : null;
    const isMobileFlow = Boolean(mobileRedirectUri);

    if (!codeVerifier || !redirectUri) {
      cookieStore.delete(SSO_PENDING_COOKIE);
      return NextResponse.json({ error: 'Invalid SSO session data' }, { status: 400 });
    }

    // Exchange code for tokens
    const tokens = await exchangeCodeForTokens(code, codeVerifier, redirectUri, pendingServerId);

    // For the mobile handoff flow the tokens are handed back to the app
    // verbatim - we deliberately don't write any cookies on the webmail
    // origin (the mobile browser tab disposes of the session after the
    // redirect anyway, but the cookie would still get committed to the
    // user's main webmail session if they happened to be logged in there).
    if (!isMobileFlow) {
      if (tokens.refresh_token) {
        const cookieName = refreshTokenCookieName(slot);
        cookieStore.set(cookieName, tokens.refresh_token, getCookieOptions());
      }
      const serverCookieName = refreshTokenServerCookieName(slot);
      if (pendingServerId) {
        cookieStore.set(serverCookieName, pendingServerId, getCookieOptions());
      } else {
        cookieStore.delete(serverCookieName);
      }
    }

    // Delete pending cookie
    cookieStore.delete(SSO_PENDING_COOKIE);

    if (isMobileFlow) {
      // The mobile client needs the bits it can't re-derive: the refresh
      // token, the token endpoint it should hit to refresh later, and the
      // client_id the IdP expects on that refresh call. The server URL is
      // returned so the app knows which JMAP host to connect to.
      const { clientId, serverUrl } = getRequiredConfig(pendingServerId);
      const tokenEndpoint = await getTokenEndpoint(pendingServerId);
      return NextResponse.json({
        access_token: tokens.access_token,
        expires_in: tokens.expires_in,
        refresh_token: tokens.refresh_token,
        token_endpoint: tokenEndpoint,
        client_id: clientId,
        server_url: serverUrl,
        mobile_redirect_uri: mobileRedirectUri,
        mobile_state: mobileState,
      });
    }

    return NextResponse.json({
      access_token: tokens.access_token,
      expires_in: tokens.expires_in,
    });
  } catch (error) {
    // Clean up pending cookie on any error
    cookieStore.delete(SSO_PENDING_COOKIE);
    logger.error('SSO complete error', { error: error instanceof Error ? error.message : 'Unknown error' });
    return NextResponse.json({ error: 'Token exchange failed' }, { status: 401 });
  }
}
