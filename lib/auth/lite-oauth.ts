import { IS_LITE_STALWART, getLiteMount } from '@/lib/lite';
import { discoverOAuth, type OAuthMetadata } from '@/lib/oauth/discovery';

/**
 * OAuth sign-in (authorization code + PKCE) for Lite served by Stalwart.
 *
 * The password form (lib/auth/lite-tokens.ts) only works for accounts Stalwart
 * can check a password for. A domain whose directory is an external OpenID
 * provider has none: Stalwart accepts that provider's bearer tokens and
 * nothing else, so those users have to be sent to the provider. This is the
 * flow Stalwart's own WebUI uses, with the same moving parts:
 *
 *   GET  <server>/api/discover/<account>   which provider signs this account in
 *   ->   <authorization_endpoint>?...      redirect, PKCE challenge
 *   <-   <mount>/oauth/callback?code=...   one locale-free URI to register
 *   POST <token_endpoint>                  code + verifier -> tokens
 *
 * The regular build does discovery and the code exchange on the server
 * (/api/auth/oauth/metadata, /api/auth/token); here both happen in the
 * browser, which an external provider has to allow with CORS on its token
 * endpoint, exactly as it does for the WebUI.
 */

/** Path of the redirect URI below the mount; the entry document boots the callback shell for it. */
export const LITE_OAUTH_CALLBACK_PATH = '/oauth/callback';

/** Whether this build can run the redirect flow at all. */
export const LITE_OAUTH_AVAILABLE = IS_LITE_STALWART;

const FLOW_KEY = 'oauth_lite_flow';
const WANTED_SCOPES = ['openid', 'email', 'profile', 'offline_access'];
const DEFAULT_SCOPE = 'openid email profile';
const DISCOVERY_TIMEOUT_MS = 4000;

/**
 * The redirect URI to register for the Application: `<origin><mount>/oauth/callback`.
 * No locale in it, so one registration covers every language.
 */
export function getLiteOAuthRedirectUri(): string {
  if (typeof window === 'undefined') return '';
  return `${window.location.origin}${getLiteMount() ?? ''}${LITE_OAUTH_CALLBACK_PATH}`;
}

export interface LiteOAuthDiscovery {
  metadata: OAuthMetadata;
  /**
   * The account signs in at a provider other than the mail server itself, so
   * the password form cannot work for it.
   */
  external: boolean;
  /** Value for the `scope` parameter. */
  scope: string;
}

interface DiscoveryDocument {
  issuer?: unknown;
  authorization_endpoint?: unknown;
  token_endpoint?: unknown;
  revocation_endpoint?: unknown;
  end_session_endpoint?: unknown;
  scopes_supported?: unknown;
}

function trimUrl(url: string): string {
  return url.replace(/\/+$/, '');
}

function isRelative(endpoint: string): boolean {
  return endpoint.startsWith('/') && !endpoint.startsWith('//');
}

function originOf(url: string): string | null {
  try {
    return new URL(url).origin;
  } catch {
    return null;
  }
}

/** Points one of the server's own endpoints at the URL the browser reaches that server under. */
function rebase(endpoint: string, serverUrl: string): string {
  const parsed = new URL(endpoint, `${serverUrl}/`);
  return `${new URL(serverUrl).origin}${parsed.pathname}${parsed.search}`;
}

function pickScope(supported: unknown): string {
  if (!Array.isArray(supported)) return DEFAULT_SCOPE;
  if (!supported.includes('openid')) return '';
  return WANTED_SCOPES.filter((scope) => supported.includes(scope)).join(' ');
}

/**
 * Whether `endpoint` belongs to `serverUrl` itself. Stalwart describes itself
 * with relative endpoints over plain HTTP and with its configured hostname
 * over TLS; behind a reverse proxy that hostname need not be the origin the
 * page uses, so the last resort is the server's own well-known document.
 */
async function isOwnEndpoint(endpoint: string, serverUrl: string): Promise<boolean> {
  if (isRelative(endpoint)) return true;
  const origin = originOf(endpoint);
  if (origin === null) return false;
  if (origin === originOf(serverUrl)) return true;
  const own = await discoverOAuth(serverUrl);
  return own?.authorization_endpoint === endpoint;
}

// The login page asks while the user types, again on submit and again for the
// SSO button, and Stalwart rate limits the (anonymous) endpoint: remember what
// it said. Failures are not kept, so a retry asks again.
const DISCOVERY_CACHE_MAX = 32;
const discoveryCache = new Map<string, LiteOAuthDiscovery>();

/** Test hook. */
export function resetLiteOAuthDiscoveryCache(): void {
  discoveryCache.clear();
}

/**
 * Asks Stalwart which provider signs `username` in. `null` when the server
 * has no such endpoint (not Stalwart, or older than 0.16), the answer is
 * unusable, or the request failed; callers then keep the password form.
 */
export async function liteDiscoverOAuth(
  serverUrl: string,
  username: string,
  signal?: AbortSignal,
): Promise<LiteOAuthDiscovery | null> {
  const base = trimUrl(serverUrl);
  const account = username.trim();
  if (!LITE_OAUTH_AVAILABLE || !account || !/^https?:\/\//.test(base)) return null;

  const cacheKey = `${base}\n${account.toLowerCase()}`;
  const cached = discoveryCache.get(cacheKey);
  if (cached) return cached;
  const found = await fetchDiscovery(base, account, signal);
  if (found) {
    if (discoveryCache.size >= DISCOVERY_CACHE_MAX) {
      const oldest = discoveryCache.keys().next().value;
      if (oldest !== undefined) discoveryCache.delete(oldest);
    }
    discoveryCache.set(cacheKey, found);
  }
  return found;
}

async function fetchDiscovery(base: string, account: string, signal?: AbortSignal): Promise<LiteOAuthDiscovery | null> {

  let doc: DiscoveryDocument;
  // One controller for both the caller's abort and the timeout (AbortSignal.any
  // is too recent to rely on).
  const controller = new AbortController();
  const abort = () => controller.abort();
  const timer = setTimeout(abort, DISCOVERY_TIMEOUT_MS);
  if (signal?.aborted) abort();
  signal?.addEventListener('abort', abort);
  try {
    const response = await fetch(`${base}/api/discover/${encodeURIComponent(account)}`, { signal: controller.signal });
    if (!response.ok) return null;
    doc = (await response.json()) as DiscoveryDocument;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', abort);
  }

  const { authorization_endpoint: authorization, token_endpoint: token } = doc;
  if (typeof authorization !== 'string' || !authorization || typeof token !== 'string' || !token) return null;

  const optional = (value: unknown): string | undefined => (typeof value === 'string' && value ? value : undefined);
  const revocation = optional(doc.revocation_endpoint);
  const endSession = optional(doc.end_session_endpoint);
  const scope = pickScope(doc.scopes_supported);

  try {
    if (await isOwnEndpoint(authorization, base)) {
      return {
        external: false,
        scope,
        metadata: {
          issuer: new URL(base).origin,
          authorization_endpoint: rebase(authorization, base),
          token_endpoint: rebase(token, base),
          revocation_endpoint: revocation && rebase(revocation, base),
          end_session_endpoint: endSession && rebase(endSession, base),
        },
      };
    }
    // An external provider's endpoints are absolute; anything else is not a
    // document to send a user (or an authorization code) to.
    if (!/^https?:\/\//.test(authorization) || !/^https?:\/\//.test(token)) return null;
    return {
      external: true,
      scope,
      metadata: {
        issuer: typeof doc.issuer === 'string' ? doc.issuer : '',
        authorization_endpoint: authorization,
        token_endpoint: token,
        revocation_endpoint: revocation,
        end_session_endpoint: endSession,
      },
    };
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Pending flow
// ---------------------------------------------------------------------------

/**
 * What the callback needs besides the verifier and state the login page
 * already parks in sessionStorage: where to redeem the code, as which client,
 * and the exact redirect URI the authorization request carried.
 */
export interface LiteOAuthFlow {
  tokenEndpoint: string;
  clientId: string;
  redirectUri: string;
  /** "Remember me" was ticked: keep the refresh token across browser restarts. */
  persistent: boolean;
  /** Where sign-out revokes the refresh token, when discovery named it. */
  revocationEndpoint?: string;
}

export function saveLiteOAuthFlow(flow: LiteOAuthFlow): void {
  try {
    window.sessionStorage.setItem(FLOW_KEY, JSON.stringify(flow));
  } catch {
    // Without sessionStorage the verifier is lost too; the callback reports it.
  }
}

export function readLiteOAuthFlow(): LiteOAuthFlow | null {
  try {
    const raw = window.sessionStorage.getItem(FLOW_KEY);
    const flow = raw ? (JSON.parse(raw) as Partial<LiteOAuthFlow>) : null;
    if (!flow || typeof flow.tokenEndpoint !== 'string' || typeof flow.clientId !== 'string' || typeof flow.redirectUri !== 'string') return null;
    if (!flow.tokenEndpoint || !flow.clientId || !flow.redirectUri) return null;
    return {
      tokenEndpoint: flow.tokenEndpoint,
      clientId: flow.clientId,
      redirectUri: flow.redirectUri,
      persistent: flow.persistent === true,
      ...(typeof flow.revocationEndpoint === 'string' && flow.revocationEndpoint
        ? { revocationEndpoint: flow.revocationEndpoint }
        : {}),
    };
  } catch {
    return null;
  }
}

export function clearLiteOAuthFlow(): void {
  try {
    window.sessionStorage.removeItem(FLOW_KEY);
  } catch {
    // ignore
  }
}
