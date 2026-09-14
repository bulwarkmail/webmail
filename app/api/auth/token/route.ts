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

// Refresh tokens are single-use at most IdPs (PocketID, Rauthy, Keycloak with
// rotation): redeeming one rotates it, and a second redemption of the same
// value is refused with invalid_grant. Two contexts can still present the
// same token at once - a PWA and a Safari tab, or a request sent before the
// previous refresh's Set-Cookie landed - and the loser of that race must not
// be treated as revoked, or its account silently disappears.
//
// Both maps are per-process, which holds for the single-container deployment;
// running several instances would need sticky sessions for this route.

interface RefreshTokens {
  access_token: string;
  refresh_token?: string;
  expires_in?: number;
}

type RefreshOutcome =
  | { ok: true; tokens: RefreshTokens }
  | { ok: false; status: number; error: string };

// Long enough to cover a backgrounded tab resuming with a stale cookie, short
// enough that a truly revoked token is not honoured for long.
const REFRESH_GRACE_MS = 5 * 60 * 1000;
const REFRESH_GRACE_MAX_ENTRIES = 1000;
const inFlightRefreshes = new Map<string, Promise<RefreshOutcome>>();
const recentRotations = new Map<string, { outcome: RefreshOutcome; at: number }>();

function pruneRecentRotations(now: number): void {
  for (const [token, entry] of recentRotations) {
    if (now - entry.at > REFRESH_GRACE_MS) recentRotations.delete(token);
  }
  while (recentRotations.size > REFRESH_GRACE_MAX_ENTRIES) {
    const oldest = recentRotations.keys().next().value;
    if (oldest === undefined) break;
    recentRotations.delete(oldest);
  }
}

async function redeemAtIdp(refreshToken: string, serverId: string | null): Promise<RefreshOutcome> {
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
    return { ok: false, status: tokenResponse.status, error: await tokenResponse.text() };
  }

  const tokens = (await tokenResponse.json()) as RefreshTokens;
  if (!tokens.access_token) {
    logger.error('Refresh response missing access_token', { response: JSON.stringify(tokens).substring(0, 500) });
    return { ok: false, status: 502, error: 'Invalid token response' };
  }
  return { ok: true, tokens };
}

async function redeemRefreshToken(refreshToken: string, serverId: string | null): Promise<RefreshOutcome> {
  const now = Date.now();
  pruneRecentRotations(now);

  const inFlight = inFlightRefreshes.get(refreshToken);
  if (inFlight) return inFlight;

  // The IdP is asked first, deliberately. Answering a stale token from the
  // rotation record before asking would keep a lost-response straggler
  // signed in, but it would also hide a replayed (stolen) refresh token from
  // an IdP whose reuse detection exists to catch exactly that. Keeping the
  // detection signal is worth an occasional sign-out; the record below only
  // softens the loser of a race this process itself can vouch for.
  const pending = redeemAtIdp(refreshToken, serverId)
    .then((outcome) => {
      if (outcome.ok) {
        recentRotations.set(refreshToken, { outcome, at: Date.now() });
        return outcome;
      }
      // A refusal of a token this process rotated moments ago comes from a
      // straggler still holding the old value; answering with the rotation
      // result converges it on the new cookie. A refused token that was never
      // rotated here is genuinely revoked.
      const rejected = outcome.status === 400 || outcome.status === 401 || outcome.status === 403;
      const recent = recentRotations.get(refreshToken);
      if (rejected && recent && Date.now() - recent.at <= REFRESH_GRACE_MS) return recent.outcome;
      return outcome;
    })
    .finally(() => { inFlightRefreshes.delete(refreshToken); });
  inFlightRefreshes.set(refreshToken, pending);
  return pending;
}

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

    const outcome = await redeemRefreshToken(refreshToken, serverId);

    if (!outcome.ok) {
      logger.error('Token refresh failed', { status: outcome.status, error: outcome.error });
      if (outcome.status === 502) {
        return NextResponse.json({ error: 'Invalid token response' }, { status: 502 });
      }
      // Drop the refresh token only when the server definitively rejected it
      // (invalid/expired/revoked grant). A 5xx or 429 is an outage - keeping
      // the cookie lets the session resume once the server is back.
      const status = outcome.status;
      if (status === 400 || status === 401 || status === 403) {
        cookieStore.delete(cookieName);
        cookieStore.delete(refreshTokenServerCookieName(slot));
        cookieStore.delete(accessTokenCookieName(slot));
        return NextResponse.json({ error: 'Refresh failed' }, { status: 401 });
      }
      return NextResponse.json({ error: 'Token endpoint unavailable' }, { status: 503 });
    }

    const { tokens } = outcome;

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
