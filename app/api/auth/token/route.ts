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
import { exchangeCodeForTokens, buildOAuthParams, getMetadata, getTokenEndpoint, DEFAULT_CLIENT_ID } from '@/lib/oauth/token-exchange';
import { getCookieOptions } from '@/lib/oauth/cookie-config';
import { MAX_ACCOUNT_SLOTS } from '@/lib/account-utils';

function getSlot(request: NextRequest): number {
  const raw = request.nextUrl.searchParams.get('slot');
  if (raw === null) return 0;
  const slot = parseInt(raw, 10);
  if (isNaN(slot) || slot < 0 || slot >= MAX_ACCOUNT_SLOTS) return 0;
  return slot;
}

type CookieStore = Awaited<ReturnType<typeof cookies>>;

/**
 * Cache the access token for the slot so a page reload can resume with it.
 *
 * Scoped to the token's own lifetime - once it expires the cookie is worthless
 * and should not linger. A token too large to store is simply not cached.
 */
function cacheAccessToken(
  cookieStore: CookieStore,
  slot: number,
  accessToken: string,
  expiresIn: number,
): void {
  const name = accessTokenCookieName(slot);
  const value = encodeCachedAccessToken(accessToken, expiresIn);
  if (!value) {
    // Oversized token: drop any stale entry rather than leaving a mismatch.
    cookieStore.delete(name);
    return;
  }
  cookieStore.set(name, value, { ...getCookieOptions(), maxAge: expiresIn });
}

export async function POST(request: NextRequest) {
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
    cacheAccessToken(cookieStore, slot, tokens.access_token, tokens.expires_in || 3600);
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
    cacheAccessToken(cookieStore, slot, tokens.access_token, expiresIn);

    return NextResponse.json({
      access_token: tokens.access_token,
      expires_in: expiresIn,
    });
  } catch (error) {
    logger.error('Token refresh error', { error: error instanceof Error ? error.message : 'Unknown error' });
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}

export async function DELETE(request: NextRequest) {
  try {
    const all = request.nextUrl.searchParams.get('all') === 'true';

    if (all) {
      // Revoke and delete all refresh token cookies across every slot.
      const cookieStore = await cookies();
      for (let i = 0; i < MAX_ACCOUNT_SLOTS; i++) {
        const name = refreshTokenCookieName(i);
        const serverCookieName = refreshTokenServerCookieName(i);
        const token = cookieStore.get(name)?.value;
        const slotServerId = cookieStore.get(serverCookieName)?.value || null;
        if (token) {
          // Best-effort revocation
          try {
            const metadata = await getMetadata(slotServerId, { fallbackClientId: DEFAULT_CLIENT_ID }).catch(() => null);
            if (metadata?.revocation_endpoint) {
              const params = buildOAuthParams({ token, token_type_hint: 'refresh_token' }, slotServerId, { fallbackClientId: DEFAULT_CLIENT_ID });
              await fetch(metadata.revocation_endpoint, {
                method: 'POST',
                headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
                body: params.toString(),
              }).catch(() => {});
            }
          } catch { /* best effort */ }
          cookieStore.delete(name);
        }
        cookieStore.delete(serverCookieName);
        cookieStore.delete(accessTokenCookieName(i));
      }
      return NextResponse.json({ ok: true });
    }

    const slot = getSlot(request);
    const cookieName = refreshTokenCookieName(slot);
    const cookieStore = await cookies();
    const refreshToken = cookieStore.get(cookieName)?.value;
    const slotServerId = cookieStore.get(refreshTokenServerCookieName(slot))?.value || null;
    const metadata = await getMetadata(slotServerId, { fallbackClientId: DEFAULT_CLIENT_ID }).catch((err) => {
      logger.warn('Failed to discover OAuth metadata during logout', {
        error: err instanceof Error ? err.message : 'Unknown error',
      });
      return null;
    });

    if (refreshToken) {
      if (metadata?.revocation_endpoint) {
        const params = buildOAuthParams({
          token: refreshToken,
          token_type_hint: 'refresh_token',
        }, slotServerId, { fallbackClientId: DEFAULT_CLIENT_ID });

        try {
          const revocationResponse = await fetch(metadata.revocation_endpoint, {
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            body: params.toString(),
          });
          if (!revocationResponse.ok) {
            logger.warn('Token revocation returned error', { status: revocationResponse.status });
          }
        } catch (err) {
          logger.error('Token revocation network error', { error: err instanceof Error ? err.message : 'Unknown error' });
        }
      }

      cookieStore.delete(cookieName);
    }
    cookieStore.delete(refreshTokenServerCookieName(slot));
    cookieStore.delete(accessTokenCookieName(slot));

    let end_session_url: string | undefined;
    if (metadata?.end_session_endpoint) {
      try {
        const parsed = new URL(metadata.end_session_endpoint);
        if (parsed.protocol === 'https:') {
          end_session_url = metadata.end_session_endpoint;
        } else {
          logger.warn('Ignoring non-HTTPS end_session_endpoint', { url: metadata.end_session_endpoint });
        }
      } catch {
        logger.warn('Invalid end_session_endpoint URL', { url: metadata.end_session_endpoint });
      }
    }

    return NextResponse.json({ ok: true, ...(end_session_url && { end_session_url }) });
  } catch (error) {
    logger.error('Token revocation error', { error: error instanceof Error ? error.message : 'Unknown error' });
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
