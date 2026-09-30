import { NextRequest, NextResponse } from 'next/server';
import { cookies } from 'next/headers';
import { logger } from '@/lib/logger';
import {
  refreshTokenCookieName,
  refreshTokenServerCookieName,
  accessTokenCookieName,
  encodeCachedAccessToken,
  decodeCachedAccessToken,
} from '@/lib/oauth/tokens';
import {
  exchangeCodeForTokens,
  buildOAuthParams,
  getMetadata,
  getRequiredConfig,
  getTokenEndpoint,
  DEFAULT_CLIENT_ID,
} from '@/lib/oauth/token-exchange';
import type { OAuthMetadata } from '@/lib/oauth/discovery';
import { getCookieOptions } from '@/lib/oauth/cookie-config';
import {
  buildEndSessionUrl,
  clearIdToken,
  getPostLogoutRedirectUri,
  idTokenCookieName,
  isEndSessionEnabled,
  storeIdToken,
} from '@/lib/oauth/end-session';
import { MAX_ACCOUNT_SLOTS } from '@/lib/account-utils';
import { rejectCrossOriginRequest } from '@/lib/security/same-origin';

function parseSlot(raw: string | null): number | null {
  if (raw === null) return null;
  const slot = parseInt(raw, 10);
  if (isNaN(slot) || slot < 0 || slot >= MAX_ACCOUNT_SLOTS) return null;
  return slot;
}

function getSlot(request: NextRequest): number {
  return parseSlot(request.nextUrl.searchParams.get('slot')) ?? 0;
}

// Sign-out waits for this route, so an unresponsive revocation endpoint must
// not hold it up for long.
const REVOCATION_TIMEOUT_MS = 3000;

async function revokeRefreshToken(token: string, serverId: string | null, metadata: OAuthMetadata | null): Promise<void> {
  if (!metadata?.revocation_endpoint) return;
  const params = buildOAuthParams({
    token,
    token_type_hint: 'refresh_token',
  }, serverId, { fallbackClientId: DEFAULT_CLIENT_ID });

  try {
    // Never follow a redirect with the refresh token and client secret in
    // the body: the endpoint was validated, its redirect target was not.
    const revocationResponse = await fetch(metadata.revocation_endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: params.toString(),
      signal: AbortSignal.timeout(REVOCATION_TIMEOUT_MS),
      redirect: 'error',
    });
    if (!revocationResponse.ok) {
      logger.warn('Token revocation returned error', { status: revocationResponse.status });
    }
  } catch (err) {
    logger.error('Token revocation network error', { error: err instanceof Error ? err.message : 'Unknown error' });
  }
}

/** The provider logout URL for a slot being signed out, or null when there is none to visit. */
function endSessionUrlFor(metadata: OAuthMetadata | null, serverId: string | null, idToken: string | undefined): string | null {
  if (!metadata?.end_session_endpoint || !isEndSessionEnabled()) return null;
  let clientId: string;
  try {
    ({ clientId } = getRequiredConfig(serverId));
  } catch {
    return null;
  }
  return buildEndSessionUrl({
    endpoint: metadata.end_session_endpoint,
    clientId,
    idToken,
    postLogoutRedirectUri: getPostLogoutRedirectUri(),
  });
}

type CookieStore = Awaited<ReturnType<typeof cookies>>;

/**
 * Cache the access token for the slot so a page reload can resume with it.
 *
 * Scoped to the token's own lifetime - once it expires the cookie is worthless
 * and should not linger. A token too large to store is simply not cached.
 * Returns the cookie value written, or null.
 */
function cacheAccessToken(
  cookieStore: CookieStore,
  slot: number,
  accessToken: string,
  expiresIn: number,
): string | null {
  const name = accessTokenCookieName(slot);
  const value = encodeCachedAccessToken(accessToken, expiresIn);
  if (!value) {
    // Oversized token: drop any stale entry rather than leaving a mismatch.
    cookieStore.delete(name);
    return null;
  }
  cookieStore.set(name, value, { ...getCookieOptions(), maxAge: expiresIn });
  return value;
}

export async function POST(request: NextRequest) {
  // CSRF gate (GHSA-qvr9-m8cq-7wvg): cookies written here are SameSite=Lax,
  // so a cross-site top-level POST would otherwise reach this handler.
  const crossOrigin = rejectCrossOriginRequest(request);
  if (crossOrigin) return crossOrigin;
  try {
    const { code, code_verifier, redirect_uri, slot: bodySlot, server_id: bodyServerId } = await request.json();

    if (!code || !code_verifier || !redirect_uri) {
      return NextResponse.json({ error: 'Missing required parameters' }, { status: 400 });
    }

    const slot = typeof bodySlot === 'number' && bodySlot >= 0 && bodySlot < MAX_ACCOUNT_SLOTS ? bodySlot : getSlot(request);
    const serverId = typeof bodyServerId === 'string' && bodyServerId ? bodyServerId : null;

    const tokens = await exchangeCodeForTokens(code, code_verifier, redirect_uri, serverId);

    const response = NextResponse.json({
      access_token: tokens.access_token,
      expires_in: tokens.expires_in,
    });

    const cookieStore = await cookies();
    if (tokens.refresh_token) {
      const cookieName = refreshTokenCookieName(slot);
      cookieStore.set(cookieName, tokens.refresh_token, getCookieOptions());
    }
    const cachedAccessToken = cacheAccessToken(cookieStore, slot, tokens.access_token, tokens.expires_in || 3600);
    storeIdToken(cookieStore, slot, tokens.id_token, request.nextUrl.basePath, [tokens.refresh_token, cachedAccessToken, serverId]);
    // Persist which server entry minted this refresh token so the PUT/DELETE
    // handlers can route the refresh/revocation calls to the right token
    // endpoint without the client having to track it across page loads.
    const serverCookieName = refreshTokenServerCookieName(slot);
    if (serverId) {
      cookieStore.set(serverCookieName, serverId, getCookieOptions());
    } else {
      cookieStore.delete(serverCookieName);
    }

    return response;
  } catch (error) {
    logger.error('Token exchange error', { error: error instanceof Error ? error.message : 'Unknown error' });
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}

export async function PUT(request: NextRequest) {
  // CSRF gate (GHSA-qvr9-m8cq-7wvg): cookies written here are SameSite=Lax,
  // so a cross-site top-level POST would otherwise reach this handler.
  const crossOrigin = rejectCrossOriginRequest(request);
  if (crossOrigin) return crossOrigin;
  try {
    const slot = getSlot(request);
    const cookieName = refreshTokenCookieName(slot);
    const cookieStore = await cookies();
    const refreshToken = cookieStore.get(cookieName)?.value;
    const serverId = cookieStore.get(refreshTokenServerCookieName(slot))?.value || null;

    if (!refreshToken) {
      cookieStore.delete(accessTokenCookieName(slot));
      return NextResponse.json({ error: 'No refresh token' }, { status: 401 });
    }

    // A session restore calls this to get its token back, not because the
    // current one expired. Serving the cached token avoids spending a refresh
    // the IdP may legitimately reject: Rauthy stamps refresh tokens with
    // nbf = iat + access_token_lifetime - 60, so refreshing early fails with
    // "Token is not valid yet" for most of the access token's life (#552).
    //
    // `force=true` means the caller was told the current token is no good (a
    // 401 from JMAP, or a scheduled renewal), so the cache must be skipped.
    const force = request.nextUrl.searchParams.get('force') === 'true';
    if (!force) {
      const cached = decodeCachedAccessToken(cookieStore.get(accessTokenCookieName(slot))?.value);
      if (cached) {
        return NextResponse.json({
          access_token: cached.accessToken,
          expires_in: cached.expiresIn,
        });
      }
    }

    // The refresh token may have been minted by the password+TOTP login route,
    // which works without a configured OAuth client by falling back to the
    // default client id - refreshing must fall back the same way (#873).
    const tokenEndpoint = await getTokenEndpoint(serverId, { fallbackClientId: DEFAULT_CLIENT_ID });

    const params = buildOAuthParams({
      grant_type: 'refresh_token',
      refresh_token: refreshToken,
    }, serverId, { fallbackClientId: DEFAULT_CLIENT_ID });

    const tokenResponse = await fetch(tokenEndpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: params.toString(),
      // See revokeRefreshToken: the body holds the refresh token.
      redirect: 'error',
    });

    if (!tokenResponse.ok) {
      const errorText = await tokenResponse.text();
      logger.error('Token refresh failed', { status: tokenResponse.status, error: errorText });
      // Drop the refresh token only when the server definitively rejected it
      // (invalid/expired/revoked grant). A 5xx or 429 is an outage - keeping
      // the cookie lets the session resume once the server is back.
      const status = tokenResponse.status;
      if (status === 400 || status === 401 || status === 403) {
        cookieStore.delete(cookieName);
        cookieStore.delete(refreshTokenServerCookieName(slot));
        cookieStore.delete(accessTokenCookieName(slot));
        clearIdToken(cookieStore, slot, request.nextUrl.basePath);
        return NextResponse.json({ error: 'Refresh failed' }, { status: 401 });
      }
      return NextResponse.json({ error: 'Token endpoint unavailable' }, { status: 503 });
    }

    const tokens = await tokenResponse.json();

    if (!tokens.access_token) {
      logger.error('Refresh response missing access_token', { response: JSON.stringify(tokens).substring(0, 500) });
      return NextResponse.json({ error: 'Invalid token response' }, { status: 502 });
    }

    if (tokens.refresh_token) {
      cookieStore.set(cookieName, tokens.refresh_token, getCookieOptions());
    }

    const expiresIn = tokens.expires_in || 3600;
    const cachedAccessToken = cacheAccessToken(cookieStore, slot, tokens.access_token, expiresIn);
    // Providers may reissue the id token on refresh. Only a slot signed in
    // through the provider keeps one; a password login's slot gains none here.
    if (typeof tokens.id_token === 'string' && cookieStore.get(idTokenCookieName(slot))) {
      storeIdToken(cookieStore, slot, tokens.id_token, request.nextUrl.basePath, [tokens.refresh_token, cachedAccessToken]);
    }

    return NextResponse.json({
      access_token: tokens.access_token,
      expires_in: expiresIn,
    });
  } catch (error) {
    logger.error('Token refresh error', { error: error instanceof Error ? error.message : 'Unknown error' });
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}

/**
 * Revoke a slot's refresh token and clear its token cookies. With
 * `endSession`, also returns the URL that ends the provider's session, or null
 * when the provider has no usable end_session_endpoint.
 */
async function signOutSlot(
  cookieStore: CookieStore,
  slot: number,
  basePath: string | undefined,
  endSession: boolean,
): Promise<string | null> {
  const cookieName = refreshTokenCookieName(slot);
  const refreshToken = cookieStore.get(cookieName)?.value;
  const serverId = cookieStore.get(refreshTokenServerCookieName(slot))?.value || null;
  const idToken = cookieStore.get(idTokenCookieName(slot))?.value;

  let endSessionUrl: string | null = null;
  if (refreshToken || endSession) {
    const metadata = await getMetadata(serverId, { fallbackClientId: DEFAULT_CLIENT_ID }).catch((err) => {
      logger.warn('Failed to discover OAuth metadata during logout', {
        error: err instanceof Error ? err.message : 'Unknown error',
      });
      return null;
    });
    if (refreshToken) await revokeRefreshToken(refreshToken, serverId, metadata);
    if (endSession) endSessionUrl = endSessionUrlFor(metadata, serverId, idToken);
  }

  // Cleared whether or not revocation worked: the browser must not be able
  // to resume a session the user ended. Only cookies the browser sent are
  // cleared - signing out of every slot would otherwise answer with a
  // Set-Cookie header per slot and cookie, too large for some proxies.
  for (const name of [cookieName, refreshTokenServerCookieName(slot), accessTokenCookieName(slot)]) {
    if (cookieStore.get(name)) cookieStore.delete(name);
  }
  if (idToken !== undefined) clearIdToken(cookieStore, slot, basePath);
  return endSessionUrl;
}

export async function DELETE(request: NextRequest) {
  // CSRF gate (GHSA-qvr9-m8cq-7wvg): cookies written here are SameSite=Lax,
  // so a cross-site top-level POST would otherwise reach this handler.
  const crossOrigin = rejectCrossOriginRequest(request);
  if (crossOrigin) return crossOrigin;
  try {
    const params = request.nextUrl.searchParams;
    const basePath = request.nextUrl.basePath;
    const cookieStore = await cookies();

    if (params.get('all') === 'true') {
      // One top-level navigation can end only one provider session, so the
      // caller names the slot whose provider should be signed out, if any.
      const endSessionSlot = parseSlot(params.get('end_session_slot'));
      const slots = Array.from({ length: MAX_ACCOUNT_SLOTS }, (_, i) => i);
      const urls = await Promise.all(
        slots.map((i) => signOutSlot(cookieStore, i, basePath, i === endSessionSlot)),
      );
      const endSessionUrl = endSessionSlot === null ? null : urls[endSessionSlot];
      return NextResponse.json({ ok: true, ...(endSessionUrl && { end_session_url: endSessionUrl }) });
    }

    const endSessionUrl = await signOutSlot(cookieStore, getSlot(request), basePath, params.get('end_session') === 'true');
    return NextResponse.json({ ok: true, ...(endSessionUrl && { end_session_url: endSessionUrl }) });
  } catch (error) {
    logger.error('Token revocation error', { error: error instanceof Error ? error.message : 'Unknown error' });
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
