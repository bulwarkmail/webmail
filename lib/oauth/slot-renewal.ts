import type { cookies } from 'next/headers';
import { configManager } from '@/lib/admin/config-manager';
import { findServerById, parseJmapServers } from '@/lib/admin/jmap-servers';
import { observeUpstream } from '@/lib/metrics/upstream';
import { readSignInStamp, refreshTokenHash, writeSignInStamp, type SignInStamp } from '@/lib/auth/session-age';
import { hasSessionSecret } from '@/lib/auth/session-secret';
import { getCookieOptions, getSignInCookieOptions } from '@/lib/oauth/cookie-config';
import { idTokenCookieName, storeIdToken } from '@/lib/oauth/end-session';
import { fitsSetCookieBudget } from '@/lib/oauth/set-cookie-budget';
import {
  buildOAuthParams,
  defaultClientOptions,
  getTokenEndpoint,
  DEFAULT_CLIENT_ID,
} from '@/lib/oauth/token-exchange';
import {
  accessTokenCookieName,
  encodeCachedAccessToken,
  refreshTokenCookieName,
  refreshTokenServerCookieName,
} from '@/lib/oauth/tokens';
import { customUpstreamCookieName, readCustomUpstream, writeCustomUpstream, type CustomUpstream } from '@/lib/oauth/custom-upstream';
import { oauthErrorCode } from '@/lib/oauth/answer-summary';
import { IS_DESKTOP_BUILD } from '@/lib/desktop/flag';

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
  /** The token endpoint answered with an error: its OAuth `error` code, never the body. */
  | { kind: 'refused'; status: number; error: string | null }
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

/** Where a slot's refresh token belongs. */
export interface TokenServer {
  /** The `jmapServers` entry that issued it, or null. */
  serverId: string | null;
  /** The server the user typed, when it came from one (lib/oauth/custom-upstream.ts). */
  upstream: CustomUpstream | null;
}

/**
 * The server a slot's refresh token is renewed and revoked at: the one that
 * issued it, as the token's sign-in stamp records it (lib/auth/session-age.ts).
 * The stamp is sealed and bound to the token; the `jmap_rts` cookie only
 * repeats it and is not read when the stamp names the server. For a server
 * the user typed, the sealed custom-upstream record holds its address and
 * client. Null, and nothing may be sent anywhere, when:
 * - the stamp names a typed server and the record is missing, names another
 *   one, or is no longer allowed (readCustomUpstream checks on every read);
 * - the stamp names a server that is no longer listed;
 * - there is no readable stamp and the cookies name a listed entry or a typed
 *   server (without a stamp, a slot that names neither renews at the
 *   configured server, as on an instance with only that server).
 * A stamp written before it recorded the server takes the cookies' word (the
 * typed-server record only in the desktop build); the renewal then records it
 * (storeRenewedTokens). Without a session secret
 * nothing is sealed and the cookies decide.
 */
export async function refreshTokenServer(
  cookieStore: CookieStore,
  slot: number,
  refreshToken: string,
): Promise<TokenServer | null> {
  const named = cookieStore.get(refreshTokenServerCookieName(slot))?.value || null;
  const record = await readCustomUpstream(cookieStore, slot);
  if (!hasSessionSecret()) return { serverId: named, upstream: record };
  const servers = parseJmapServers(configManager.get<unknown>('jmapServers', []));
  const stamp = readSignInStamp(cookieStore, slot, refreshToken);
  let server: TokenServer;
  if (stamp?.serverId !== undefined) {
    // The stamp decides: a missing or different `jmap_rts` is ignored, and
    // the renewal writes it again (storeRenewedTokens).
    if (stamp.customServer && record?.serverUrl !== stamp.customServer) return null;
    // A record left behind by an earlier sign-in in this slot is not this token's.
    server = { serverId: stamp.serverId, upstream: stamp.customServer ? record : null };
  } else if (stamp) {
    // Only the desktop build wrote typed-server records before stamps named
    // the server; elsewhere a record next to such a stamp is not this token's.
    server = { serverId: named, upstream: IS_DESKTOP_BUILD ? record : null };
  } else {
    // No readable stamp (a sign-in from before stamps, or a stamp sealed with
    // an earlier session secret). Only the stamp could tell which listed
    // entry or typed server issued the token, so a slot whose cookies name
    // one is refused; any other renews at the configured server.
    if (named || cookieStore.get(customUpstreamCookieName(slot))) return null;
    server = { serverId: null, upstream: null };
  }
  if (server.serverId !== null && !findServerById(servers, server.serverId)) return null;
  return server;
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
  if (!response.ok) return { kind: 'refused', status: response.status, error: oauthErrorCode(await response.text()) };
  return { kind: 'issued', tokens: (await response.json()) as IssuedTokens };
}

/** How long an issued redemption is kept for requests that still carry the token it spent. */
export const REDEMPTION_KEPT_MS = 60_000;
/** How long a signed-out refresh token is remembered, longer than any redemption takes. */
const SIGNED_OUT_KEPT_MS = 10 * 60_000;

interface KeptRedemption {
  pending: Promise<Redemption>;
  /** Hash of the refresh token it spent. */
  spent: string;
  /** Hash of the refresh token it issued, once it did. */
  issued?: string;
}

const redemptions = new Map<string, KeptRedemption>();
/** Refresh token hash -> when a sign-out dropped it. */
const signedOut = new Map<string, number>();

function drop(key: string, kept: KeptRedemption): void {
  if (redemptions.get(key) === kept) redemptions.delete(key);
}

/**
 * Redeem a refresh token at the provider. Requests that hold the same token at
 * the same time share one redemption: refresh tokens rotate, and the second
 * use of a superseded one can count as a replay that revokes the whole grant
 * (Stalwart 1.0). A page's renewals queue behind a Web Lock (lib/auth/token-lock.ts);
 * the service worker's push previews can't take it, so they meet here instead.
 *
 * What a redemption issued is kept for a minute after: an answer lost on its
 * way (a proxy error, a worker that went away) leaves the browser with the
 * spent token, and its next request gets the same tokens instead of spending
 * it again. A failed one is forgotten at once. All of this is per process:
 * replicas don't share it.
 */
export function redeemRefreshToken(refreshToken: string, serverId: string | null, upstream: CustomUpstream | null): Promise<Redemption> {
  const spent = refreshTokenHash(refreshToken);
  const key = `${serverId ?? ''}\n${spent}`;
  const found = redemptions.get(key);
  if (found) return found.pending;
  const kept: KeptRedemption = { pending: redeem(refreshToken, serverId, upstream), spent };
  redemptions.set(key, kept);
  kept.pending.then((result) => {
    if (result.kind !== 'issued' || !result.tokens.access_token || wasSignedOut(refreshToken)) {
      drop(key, kept);
      return;
    }
    if (result.tokens.refresh_token) kept.issued = refreshTokenHash(result.tokens.refresh_token);
    const timer = setTimeout(() => drop(key, kept), REDEMPTION_KEPT_MS);
    (timer as { unref?: () => void }).unref?.();
  }, () => drop(key, kept));
  return kept.pending;
}

/**
 * A sign-out dropped this refresh token (DELETE /api/auth/token). A renewal
 * that spent it while the sign-out ran must not write its tokens back, and
 * nothing kept from it, or issuing it, is handed out again.
 */
export function noteSignedOut(refreshToken: string): void {
  const now = Date.now();
  for (const [hash, at] of signedOut) if (now - at > SIGNED_OUT_KEPT_MS) signedOut.delete(hash);
  const hash = refreshTokenHash(refreshToken);
  signedOut.set(hash, now);
  for (const [key, kept] of redemptions) {
    if (kept.spent === hash || kept.issued === hash) redemptions.delete(key);
  }
}

export function wasSignedOut(refreshToken: string): boolean {
  const at = signedOut.get(refreshTokenHash(refreshToken));
  return at !== undefined && Date.now() - at <= SIGNED_OUT_KEPT_MS;
}

export function resetRedemptionsForTests(): void {
  redemptions.clear();
  signedOut.clear();
}

/**
 * Keep what a renewal issued: the rotated refresh token with the sign-in
 * stamp, server cookie and typed-server record that follow it, the access
 * token cache, and a reissued id token. Each request that shared a
 * redemption writes the same values to its own response. `server` is where
 * the token was renewed (refreshTokenServer).
 */
export function storeRenewedTokens(
  cookieStore: CookieStore,
  slot: number,
  tokens: IssuedTokens & { access_token: string },
  opts: {
    remember: boolean;
    age: { signedInAt: number; stamp: SignInStamp | null } | null;
    basePath: string | undefined;
    server: TokenServer;
  },
): { accessToken: string; expiresIn: number } {
  const { remember, age, basePath, server } = opts;
  if (tokens.refresh_token) {
    const options = getSignInCookieOptions(remember);
    cookieStore.set(refreshTokenCookieName(slot), tokens.refresh_token, options);
    // The stamp follows the rotated token, with the same sign-in time, server and lifetime.
    if (age) {
      writeSignInStamp(cookieStore, slot, {
        signedInAt: age.signedInAt,
        refreshToken: tokens.refresh_token,
        ...(age.stamp?.account ? { account: age.stamp.account } : {}),
        serverId: server.serverId,
        ...(server.upstream ? { customServer: server.upstream.serverUrl } : {}),
      }, options);
    }
    // Written again with the token's lifetime, so neither runs out before it.
    const serverCookie = refreshTokenServerCookieName(slot);
    if (server.serverId) cookieStore.set(serverCookie, server.serverId, options);
    else if (cookieStore.get(serverCookie)) cookieStore.delete(serverCookie);
    if (server.upstream) writeCustomUpstream(cookieStore, slot, server.upstream, remember);
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
