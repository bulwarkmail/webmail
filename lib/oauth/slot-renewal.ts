import type { cookies } from 'next/headers';
import { observeUpstream } from '@/lib/metrics/upstream';
import { refreshTokenHash, writeSignInStamp, type SignInStamp } from '@/lib/auth/session-age';
import { getCookieOptions, getSignInCookieOptions } from '@/lib/oauth/cookie-config';
import { idTokenCookieName, storeIdToken } from '@/lib/oauth/end-session';
import { fitsSetCookieBudget } from '@/lib/oauth/set-cookie-budget';
import {
  buildOAuthParams,
  defaultClientOptions,
  getTokenEndpoint,
  DEFAULT_CLIENT_ID,
} from '@/lib/oauth/token-exchange';
import { accessTokenCookieName, encodeCachedAccessToken, refreshTokenCookieName } from '@/lib/oauth/tokens';
import type { CustomUpstream } from '@/lib/oauth/custom-upstream';

/**
 * Renewing a slot's access token with the refresh token in its cookie. The
 * token route (PUT /api/auth/token) does it for a page; the push preview does
 * it for the service worker, which has no page to ask (#1509).
 */

type CookieStore = Awaited<ReturnType<typeof cookies>>;

export interface IssuedTokens {
  access_token?: string;
  refresh_token?: string;
  expires_in?: number;
  id_token?: unknown;
}

export type Redemption =
  /** Discovery or the token endpoint out of reach: an outage, not a sign-out. */
  | { kind: 'unreachable'; message: string }
  /** The token endpoint answered with an error. */
  | { kind: 'refused'; status: number; errorText: string }
  | { kind: 'issued'; tokens: IssuedTokens };

/**
 * Cache the access token for the slot so a page reload can resume with it.
 *
 * Scoped to the token's own lifetime - once it expires the cookie is worthless
 * and should not linger. A token too large to store, or one that would push
 * the response past a proxy's header buffer beside `otherCookieValues`, is
 * simply not cached: a reload then refreshes instead (#1237).
 * Returns the cookie value written, or null.
 */
export function cacheAccessToken(
  cookieStore: CookieStore,
  slot: number,
  accessToken: string,
  expiresIn: number,
  otherCookieValues: ReadonlyArray<string | null | undefined>,
  remember: boolean,
): string | null {
  const name = accessTokenCookieName(slot);
  const value = encodeCachedAccessToken(accessToken, expiresIn);
  if (!value || !fitsSetCookieBudget([...otherCookieValues, value])) {
    // Drop any stale entry rather than leaving a mismatch.
    if (cookieStore.get(name)) cookieStore.delete(name);
    return null;
  }
  // The value carries its own expiry, so a session cookie needs no maxAge.
  cookieStore.set(name, value, remember ? { ...getCookieOptions(), maxAge: expiresIn } : getSignInCookieOptions(false));
  return value;
}

async function redeem(refreshToken: string, serverId: string | null, upstream: CustomUpstream | null): Promise<Redemption> {
  // The refresh token may have been minted by the password+TOTP login route,
  // which works without a configured OAuth client by falling back to the
  // default client id - refreshing must fall back the same way (#873).
  let response: Response;
  try {
    const tokenEndpoint = await getTokenEndpoint(serverId, upstream ? { upstream } : { fallbackClientId: DEFAULT_CLIENT_ID });
    const params = buildOAuthParams({
      grant_type: 'refresh_token',
      refresh_token: refreshToken,
    }, serverId, await defaultClientOptions(serverId, upstream));
    response = await observeUpstream('oauth', () => fetch(tokenEndpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: params.toString(),
      // Never follow a redirect with the refresh token in the body: the
      // endpoint was validated, its redirect target was not.
      redirect: 'error',
    }));
  } catch (error) {
    return { kind: 'unreachable', message: error instanceof Error ? error.message : 'Unknown error' };
  }
  if (!response.ok) return { kind: 'refused', status: response.status, errorText: await response.text() };
  return { kind: 'issued', tokens: (await response.json()) as IssuedTokens };
}

const inFlight = new Map<string, Promise<Redemption>>();

/**
 * Redeem a refresh token at the provider. Requests that hold the same token at
 * the same time share one redemption: refresh tokens rotate, and the second
 * use of a superseded one can count as a replay that revokes the whole grant
 * (Stalwart 1.0). A page's renewals queue behind a Web Lock (lib/auth/token-lock.ts);
 * the service worker's push previews can't take it, so they meet here instead.
 */
export function redeemRefreshToken(refreshToken: string, serverId: string | null, upstream: CustomUpstream | null): Promise<Redemption> {
  const key = `${serverId ?? ''}\n${refreshTokenHash(refreshToken)}`;
  let pending = inFlight.get(key);
  if (!pending) {
    pending = redeem(refreshToken, serverId, upstream).finally(() => inFlight.delete(key));
    inFlight.set(key, pending);
  }
  return pending;
}

/**
 * Keep what a renewal issued: the rotated refresh token and the sign-in stamp
 * that follows it, the access token cache, and a reissued id token. Each
 * request that shared a redemption writes the same values to its own response.
 */
export function storeRenewedTokens(
  cookieStore: CookieStore,
  slot: number,
  tokens: IssuedTokens & { access_token: string },
  opts: {
    remember: boolean;
    age: { signedInAt: number; stamp: SignInStamp | null } | null;
    basePath: string | undefined;
  },
): { accessToken: string; expiresIn: number } {
  const { remember, age, basePath } = opts;
  if (tokens.refresh_token) {
    const options = getSignInCookieOptions(remember);
    cookieStore.set(refreshTokenCookieName(slot), tokens.refresh_token, options);
    // The stamp follows the rotated token, with the same sign-in time and lifetime.
    if (age) {
      writeSignInStamp(cookieStore, slot, {
        signedInAt: age.signedInAt,
        refreshToken: tokens.refresh_token,
        ...(age.stamp?.account ? { account: age.stamp.account } : {}),
      }, options);
    }
  }

  const expiresIn = tokens.expires_in || 3600;
  const cachedAccessToken = cacheAccessToken(cookieStore, slot, tokens.access_token, expiresIn, [tokens.refresh_token], remember);
  // Providers may reissue the id token on refresh. Only a slot signed in
  // through the provider keeps one; a password login's slot gains none here.
  if (typeof tokens.id_token === 'string' && cookieStore.get(idTokenCookieName(slot))) {
    storeIdToken(cookieStore, slot, tokens.id_token, basePath, [tokens.refresh_token, cachedAccessToken], remember);
  }
  return { accessToken: tokens.access_token, expiresIn };
}
