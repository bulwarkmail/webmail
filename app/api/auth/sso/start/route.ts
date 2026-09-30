import { NextRequest, NextResponse } from 'next/server';
import { cookies } from 'next/headers';
import { logger } from '@/lib/logger';
import { encryptPayload } from '@/lib/auth/crypto';
import { generateCodeVerifierServer, generateCodeChallengeServer, generateStateServer } from '@/lib/oauth/pkce-server';
import { getRequiredConfig, getDiscoveryValidator } from '@/lib/oauth/token-exchange';
import { discoverOAuth } from '@/lib/oauth/discovery';
import { getOauthScopes, refreshTokenServerCookieName } from '@/lib/oauth/tokens';
import { MAX_ACCOUNT_SLOTS } from '@/lib/account-utils';
import { getCookieOptions } from '@/lib/oauth/cookie-config';
import { hasSessionSecret } from '@/lib/auth/session-secret';
import { configManager } from '@/lib/admin/config-manager';
import { rejectCrossOriginRequest } from '@/lib/security/same-origin';

const SSO_PENDING_COOKIE = 'sso_pending';
const SSO_PENDING_MAX_AGE = 300; // 5 minutes

// The mobile app's deep-link scheme. Only redirect targets starting with
// this prefix may flow through the mobile handoff path; without the guard
// the SSO complete route would be coerced into returning tokens to whatever
// caller-controlled URL the attacker chose.
const MOBILE_REDIRECT_SCHEME = 'bulwarkmobile://';

/**
 * A re-auth mints the grant a paired phone keeps using. Providers such as
 * Keycloak tie ordinary refresh tokens to the browser's login session, so
 * signing out on the desktop (RP-initiated logout) would sign the phone out
 * too; an `offline_access` token outlives that session. Only asked for when
 * the provider advertises it, as an unknown scope can fail the request.
 */
function reauthScopes(scopes: string, isReauth: boolean, supported: string[] | undefined): string {
  if (!isReauth || !supported?.includes('offline_access')) return scopes;
  const list = scopes.split(/\s+/).filter(Boolean);
  return list.includes('offline_access') ? scopes : [...list, 'offline_access'].join(' ');
}

export async function POST(request: NextRequest) {
  // CSRF gate (GHSA-qvr9-m8cq-7wvg): cookies written here are SameSite=Lax,
  // so a cross-site top-level POST would otherwise reach this handler.
  const crossOrigin = rejectCrossOriginRequest(request);
  if (crossOrigin) return crossOrigin;
  try {
    if (!hasSessionSecret()) {
      return NextResponse.json({ error: 'SESSION_SECRET is required for SSO' }, { status: 500 });
    }

    const {
      redirect_uri,
      locale,
      server_id: bodyServerId,
      mobile_redirect_uri: rawMobileRedirectUri,
      mobile_state: rawMobileState,
      purpose: rawPurpose,
      slot: rawSlot,
    } = await request.json();

    // `reauth` drives the step-up flow for device pairing: it forces a fresh
    // IdP login (prompt=login) and the /reauth/sso/complete handler sets the
    // short-lived pairing re-auth proof instead of logging the user in again.
    const isReauth = rawPurpose === 'reauth';

    if (!redirect_uri || typeof redirect_uri !== 'string') {
      return NextResponse.json({ error: 'Missing redirect_uri' }, { status: 400 });
    }

    const mobileRedirectUri =
      typeof rawMobileRedirectUri === 'string' && rawMobileRedirectUri
        ? rawMobileRedirectUri
        : null;
    const mobileState =
      typeof rawMobileState === 'string' && rawMobileState ? rawMobileState : null;
    if (mobileRedirectUri && !mobileRedirectUri.startsWith(MOBILE_REDIRECT_SCHEME)) {
      return NextResponse.json({ error: 'Invalid mobile_redirect_uri' }, { status: 400 });
    }

    const cookieStore = await cookies();

    // A re-auth must hit the IdP of the account being paired. The client
    // doesn't know that account's server id, so read it from the slot's
    // server cookie like pair/create does. Without it, deployments that only
    // configure OAuth per server (no global client/server) fail discovery.
    const reauthSlot =
      typeof rawSlot === 'number' && Number.isInteger(rawSlot) && rawSlot >= 0 && rawSlot < MAX_ACCOUNT_SLOTS ? rawSlot : 0;
    let serverId = typeof bodyServerId === 'string' && bodyServerId ? bodyServerId : null;
    if (!serverId && isReauth) {
      serverId = cookieStore.get(refreshTokenServerCookieName(reauthSlot))?.value || null;
    }

    // Validate redirect_uri origin matches the request origin to prevent open redirects
    const requestOrigin = request.headers.get('origin') || request.nextUrl.origin;
    try {
      const redirectOrigin = new URL(redirect_uri).origin;
      if (redirectOrigin !== requestOrigin) {
        logger.warn('SSO start: redirect_uri origin mismatch', { redirectOrigin, requestOrigin });
        return NextResponse.json({ error: 'Invalid redirect_uri' }, { status: 400 });
      }
    } catch {
      return NextResponse.json({ error: 'Invalid redirect_uri' }, { status: 400 });
    }

    const { clientId, discoveryUrl } = getRequiredConfig(serverId);
    const metadata = await discoverOAuth(discoveryUrl, { validateEndpoint: getDiscoveryValidator(discoveryUrl) });

    if (!metadata?.authorization_endpoint) {
      return NextResponse.json({ error: 'OAuth discovery failed' }, { status: 502 });
    }

    // Generate PKCE + state server-side
    const codeVerifier = generateCodeVerifierServer();
    const codeChallenge = generateCodeChallengeServer(codeVerifier);
    const state = generateStateServer();

    // Encrypt and store in httpOnly cookie. server_id is captured here so the
    // /complete handler reaches the same OAuth endpoint we used to authorize.
    // Mobile params are captured here so /complete knows to return tokens to
    // the caller (in the JSON response) instead of writing the usual server
    // cookies - and so the callback page can redirect back to the app.
    const pendingData = {
      state,
      code_verifier: codeVerifier,
      redirect_uri,
      created_at: Date.now(),
      ...(serverId ? { server_id: serverId } : {}),
      ...(mobileRedirectUri ? { mobile_redirect_uri: mobileRedirectUri } : {}),
      ...(mobileState ? { mobile_state: mobileState } : {}),
      // The re-auth completes into a grant for the phone paired to this slot.
      ...(isReauth ? { purpose: 'reauth', slot: reauthSlot } : {}),
    };

    const encrypted = encryptPayload(pendingData, 'sso-pending');
    const baseCookieOpts = getCookieOptions();
    cookieStore.set(SSO_PENDING_COOKIE, encrypted, {
      ...baseCookieOpts,
      maxAge: SSO_PENDING_MAX_AGE,
    });

    // Build authorize URL. OAUTH_AUTHORIZE_URL, when set, overrides only the
    // user-facing authorize endpoint (e.g. a per-brand login host). Discovery,
    // token exchange and refresh keep using the canonical discovered endpoints.
    const authorizeOverride =
      configManager.get<string>('oauthAuthorizeUrl', '') || process.env.OAUTH_AUTHORIZE_URL;
    const authUrl = new URL(authorizeOverride?.trim() || metadata.authorization_endpoint);
    authUrl.searchParams.set('response_type', 'code');
    authUrl.searchParams.set('client_id', clientId);
    authUrl.searchParams.set('redirect_uri', redirect_uri);
    authUrl.searchParams.set('scope', reauthScopes(getOauthScopes(), isReauth, metadata.scopes_supported));
    authUrl.searchParams.set('state', state);
    authUrl.searchParams.set('code_challenge', codeChallenge);
    authUrl.searchParams.set('code_challenge_method', 'S256');

    if (locale) {
      authUrl.searchParams.set('ui_locales', locale);
    }

    // Force a fresh credential entry for step-up re-auth. prompt=login asks
    // the IdP to re-authenticate even if it has an active session; honoring it
    // depends on the IdP supporting this OIDC param. Deliberately no max_age=0:
    // some IdPs (Authelia) re-evaluate max_age at the consent step and loop
    // back to login forever, and nothing on our side reads auth_time.
    if (isReauth) {
      authUrl.searchParams.set('prompt', 'login');
    }

    return NextResponse.json({
      authorize_url: authUrl.toString(),
      state,
    });
  } catch (error) {
    logger.error('SSO start error', { error: error instanceof Error ? error.message : 'Unknown error' });
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
