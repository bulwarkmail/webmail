import { configManager } from '@/lib/admin/config-manager';
import { logger } from '@/lib/logger';
import { getCookieOptions } from '@/lib/oauth/cookie-config';

/*
 * RP-initiated logout (OpenID Connect RP-Initiated Logout 1.0), #905.
 *
 * Revoking the refresh token ends Bulwark's grant, but not the login session
 * the identity provider keeps in its own cookies: with that session alive,
 * "Sign in with SSO" silently signs the same person back in. Signing out
 * therefore finishes with a top-level navigation to the provider's
 * end_session_endpoint, carrying the parameters it needs to identify the
 * session and the client.
 */

export const ID_TOKEN_COOKIE = 'jmap_idt';

/**
 * Most bytes the Set-Cookie headers of a response may take for it to also
 * carry the id token. nginx holds an upstream's response headers in
 * `proxy_buffer_size`, one memory page (4 KB) unless raised, as does
 * ingress-nginx, and answers 502 "upstream sent too big header" when they
 * do not fit. The route's other headers take about 300 bytes; the refresh
 * and access-token cookies beside the id token take 2-3 KB with a provider
 * that issues large JWTs such as Keycloak. Adding the id token pushed such
 * sign-ins over the limit (#1096), so it is only stored when it fits.
 * Otherwise sign-out identifies the client by `client_id` alone. This also
 * keeps the id-token cookie under the browsers' ~4096-byte cookie cap.
 */
const MAX_SET_COOKIE_BYTES = 3500;

/**
 * A Set-Cookie header's size beyond the cookie value: header and cookie
 * name, attributes (path, expiry, flags) and line break. About 120-135 bytes
 * for these cookies, rounded up.
 */
const SET_COOKIE_OVERHEAD_BYTES = 150;

/** Get the id-token cookie name for a given account slot. Slot 0 uses the bare name. */
export function idTokenCookieName(slot: number): string {
  return slot === 0 ? ID_TOKEN_COOKIE : `${ID_TOKEN_COOKIE}_${slot}`;
}

/**
 * Only the token route reads the id token (a refresh keeps it current,
 * sign-out spends it), so the cookie is scoped to that route. Sent with every
 * request, the id tokens of several signed-in accounts would push the Cookie
 * header past the server's size limit.
 */
function idTokenCookiePath(basePath: string | undefined): string {
  return `${basePath ?? ''}/api/auth/token`;
}

interface CookieWriter {
  set(name: string, value: string, options?: Record<string, unknown>): unknown;
  delete(options: { name: string; path: string }): unknown;
}

function setCookieBytes(values: ReadonlyArray<string | null | undefined>): number {
  return values.reduce((sum, value) => (value ? sum + value.length + SET_COOKIE_OVERHEAD_BYTES : sum), 0);
}

/**
 * Remember the slot's id token for sign-out, or forget a stale one.
 * `otherCookieValues` are the values of the other cookies the same response
 * sets; the id token is only stored when all of them fit the response's
 * header budget.
 */
export function storeIdToken(
  cookieStore: CookieWriter,
  slot: number,
  idToken: unknown,
  basePath: string | undefined,
  otherCookieValues: ReadonlyArray<string | null | undefined> = [],
): void {
  const name = idTokenCookieName(slot);
  const path = idTokenCookiePath(basePath);
  if (typeof idToken !== 'string' || !idToken || setCookieBytes([...otherCookieValues, idToken]) > MAX_SET_COOKIE_BYTES) {
    cookieStore.delete({ name, path });
    return;
  }
  cookieStore.set(name, idToken, { ...getCookieOptions(), path });
}

export function clearIdToken(cookieStore: CookieWriter, slot: number, basePath: string | undefined): void {
  cookieStore.delete({ name: idTokenCookieName(slot), path: idTokenCookiePath(basePath) });
}

/** Whether signing out should also end the provider's session (OAUTH_END_SESSION). */
export function isEndSessionEnabled(): boolean {
  return configManager.get<boolean>('oauthEndSession', true) !== false;
}

function isLoopbackHost(hostname: string): boolean {
  return hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '[::1]';
}

/**
 * Where the provider may send the browser after it ended its session
 * (OAUTH_POST_LOGOUT_REDIRECT_URI).
 *
 * Only ever the admin-configured value, never one derived from the request or
 * the provider's metadata, so neither can turn sign-out into an open redirect.
 * Unset means none is sent: the provider then shows its own signed-out page,
 * which works without registering anything. A value the provider does not
 * have on file makes most of them refuse the whole logout request.
 */
export function getPostLogoutRedirectUri(): string | undefined {
  const raw = configManager.get<string>('oauthPostLogoutRedirectUri', '')?.trim();
  if (!raw) return undefined;
  try {
    const url = new URL(raw);
    const secure = url.protocol === 'https:' || (url.protocol === 'http:' && isLoopbackHost(url.hostname));
    if (!secure || url.username || url.password || url.hash) {
      logger.warn('Ignoring OAUTH_POST_LOGOUT_REDIRECT_URI: must be an https URL without credentials or fragment');
      return undefined;
    }
    // Sent verbatim: providers compare it with the registered value exactly,
    // and URL normalization could add a trailing slash the admin did not register.
    return raw;
  } catch {
    logger.warn('Ignoring OAUTH_POST_LOGOUT_REDIRECT_URI: not a valid URL');
    return undefined;
  }
}

/**
 * The URL to navigate the browser to so the provider ends its session, or
 * null when the discovered endpoint is unusable.
 *
 * `client_id` is always sent: providers use it to validate the redirect URI
 * and to find the session when no id token is at hand. `id_token_hint` is sent
 * when the id token from sign-in was kept; with it, providers such as Keycloak
 * end the session without asking the user to confirm.
 */
export function buildEndSessionUrl(params: {
  endpoint: string;
  clientId: string;
  idToken?: string | null;
  postLogoutRedirectUri?: string;
}): string | null {
  let url: URL;
  try {
    url = new URL(params.endpoint);
  } catch {
    logger.warn('Invalid end_session_endpoint URL', { url: params.endpoint });
    return null;
  }
  // The browser carries the id token there, so it must not travel in clear.
  if (url.protocol !== 'https:') {
    logger.warn('Ignoring non-HTTPS end_session_endpoint', { url: params.endpoint });
    return null;
  }
  url.searchParams.set('client_id', params.clientId);
  if (params.idToken) url.searchParams.set('id_token_hint', params.idToken);
  if (params.postLogoutRedirectUri) url.searchParams.set('post_logout_redirect_uri', params.postLogoutRedirectUri);
  return url.toString();
}
