export interface OAuthMetadata {
  issuer: string;
  authorization_endpoint: string;
  token_endpoint: string;
  revocation_endpoint?: string;
  end_session_endpoint?: string;
  scopes_supported?: string[];
  registration_endpoint?: string;
  /** RFC 9207: the provider names itself (`iss`) in every authorization answer. */
  authorization_response_iss_parameter_supported?: boolean;
}

const trimSlashes = (value: string) => value.replace(/\/+$/, '');

/**
 * Whether the `iss` of an authorization callback (RFC 9207) fits the issuer
 * the sign-in was sent to. Another issuer is refused, and so is a missing one
 * when `required` (the provider says it always sends one, and the callback was
 * passed on with it). Trailing slashes don't count. An `iss` with no issuer
 * to compare it with is refused.
 */
export function callbackIssuerAccepted(iss: unknown, expected: unknown, required: boolean): boolean {
  if (iss === undefined || iss === null || iss === '') return !required;
  if (typeof iss !== 'string') return false;
  if (typeof expected !== 'string' || !expected) return false;
  return trimSlashes(iss) === trimSlashes(expected);
}

/**
 * Whether metadata fetched from `base` names `base` as its issuer (RFC 8414
 * section 3.3: identical to the issuer identifier the well-known path was
 * appended to). Only trailing slashes are forgiven. `base` is the discovery
 * base as configured, which the URL parser has already given a lowercase host
 * and no default port; an issuer that spells its host in capitals or names
 * the default port is not identical and is refused.
 */
export function isOwnIssuer(issuer: unknown, base: string): boolean {
  return typeof issuer === 'string' && issuer !== '' && trimSlashes(issuer) === trimSlashes(base);
}

// Validates that a discovered endpoint URL is safe to follow. Server-side
// callers must pass this to gate against SSRF (typically isPublicHttpUrl from
// @/lib/security/url-guard, which uses node:dns and cannot be bundled for the
// browser). Client callers omit it: the browser handles outbound networking
// and an SSRF check isn't meaningful there.
export type EndpointValidator = (url: string) => Promise<boolean>;

/**
 * Which metadata `issuer` a sign-in takes; it is what the callback's `iss` is
 * checked against. Metadata that names no issuer is refused under both.
 * - 'own': the address discovery ran against (isOwnIssuer), anything else is
 *   refused;
 * - 'named': any issuer; one that differs from that address is logged once.
 * Which one applies is lib/oauth/sign-in-servers.ts signInIssuerRule.
 */
export type IssuerRule = 'own' | 'named';

export interface DiscoverOAuthOptions {
  validateEndpoint?: EndpointValidator;
  /** For a sign-in: which `issuer` the metadata must name. Unchecked without it. */
  issuerRule?: IssuerRule;
}

/**
 * The issuer findings already logged, by rule, discovery address and issuer
 * named: each is logged once per process, not on every login page load.
 */
const issuerFindingsLogged = new Set<string>();

/** Whether this finding still has to be logged (and marks it logged). */
function firstTime(base: string, rule: IssuerRule, issuer: string): boolean {
  const key = `${rule}\n${base}\n${issuer}`;
  if (issuerFindingsLogged.has(key)) return false;
  issuerFindingsLogged.add(key);
  return true;
}

/** The issuer a document names, for a log line. */
const quotedIssuer = (issuer: string) => JSON.stringify(issuer.slice(0, 200));

function issuerVerdict(metadata: OAuthMetadata, base: string, rule: IssuerRule): 'ok' | 'unavailable' | 'issuer_mismatch' {
  if (typeof metadata.issuer !== 'string' || !metadata.issuer) {
    if (firstTime(base, rule, '')) console.error(`[OAuth] Metadata from ${base} names no issuer, so it can't be used to sign in`);
    return 'unavailable';
  }
  if (isOwnIssuer(metadata.issuer, base)) return 'ok';
  const named = quotedIssuer(metadata.issuer);
  if (rule === 'named') {
    if (firstTime(base, rule, metadata.issuer)) {
      console.warn(`[OAuth] Metadata from ${base} names ${named} as its issuer. Set OAUTH_ISSUER_URL (admin setting oauthIssuerUrl), or oauth.issuerUrl on the server's jmapServers entry, to ${named}; as soon as a second sign-in server is configured, sign-in through ${base} is refused until then`);
    }
    return 'ok';
  }
  if (firstTime(base, rule, metadata.issuer)) {
    console.error(`[OAuth] Metadata from ${base} names ${named} as its issuer, not ${base}, and this instance has more than one sign-in server, so sign-in through it is refused. Set oauth.issuerUrl on the server's jmapServers entry, or OAUTH_ISSUER_URL (admin setting oauthIssuerUrl) for the configured server, to ${named}`);
  }
  return 'issuer_mismatch';
}

const CACHE_TTL_MS = 10 * 60 * 1000;
const CACHE_MAX_ENTRIES = 64;
const metadataCache = new Map<string, { metadata: OAuthMetadata; expiresAt: number }>();

// --- Discovery hardening ---------------------------------------------------
// The login page's "Sign in with SSO" button is gated on OIDC discovery
// succeeding. An un-timed, un-retried fetch that dropped its cached value on
// failure let a single transient blip to the IdP silently hide the button.
// A per-fetch timeout, one retry, and serving stale-but-usable metadata on
// failure keep the button up through a transient blip.
const DISCOVERY_TIMEOUT_MS = 4000;
const DISCOVERY_RETRIES = 1;
const DISCOVERY_RETRY_DELAY_MS = 300;
// When discovery fails, remember the outcome briefly so repeated login-page
// loads during an outage don't hammer the IdP. Also throttles re-discovery
// while serving stale metadata. Kept short so recovery is fast.
const DISCOVERY_FAILURE_TTL_MS = 15 * 1000;

// Records recent failures for serverUrls that have no cached metadata to serve.
const negativeCache = new Map<string, number>();

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

function rememberMetadata(serverUrl: string, metadata: OAuthMetadata): void {
  // Bound the cache so callers that can supply arbitrary serverUrl values
  // (e.g. unauthenticated routes that fall back to user input) cannot
  // exhaust memory. Map preserves insertion order, so the oldest entry is
  // always the first one yielded by keys().
  if (metadataCache.size >= CACHE_MAX_ENTRIES) {
    const oldest = metadataCache.keys().next().value;
    if (oldest !== undefined) metadataCache.delete(oldest);
  }
  metadataCache.set(serverUrl, { metadata, expiresAt: Date.now() + CACHE_TTL_MS });
}

function rememberFailure(serverUrl: string): void {
  // Bound like metadataCache: a user-supplied serverUrl must not grow this map
  // without limit.
  if (negativeCache.size >= CACHE_MAX_ENTRIES) {
    const oldest = negativeCache.keys().next().value;
    if (oldest !== undefined) negativeCache.delete(oldest);
  }
  negativeCache.set(serverUrl, Date.now() + DISCOVERY_FAILURE_TTL_MS);
}

// Endpoints come from an attacker-controllable JSON document when callers pass
// a user-supplied serverUrl (e.g. /api/auth/totp-token-exchange under
// allowCustomJmapEndpoint). Without a validator, a malicious metadata document
// could point token_endpoint at 169.254.169.254 or 127.0.0.1:* and turn the
// downstream fetch() into an SSRF with response-body reflection. Server-side
// callers must pass `validateEndpoint`.
// Returns the first endpoint the validator rejects, or null when all pass.
async function findRejectedEndpoint(
  endpoints: Array<string | undefined>,
  validate: EndpointValidator | undefined,
): Promise<string | null> {
  if (!validate) return null;
  for (const endpoint of endpoints) {
    if (endpoint === undefined) continue;
    if (typeof endpoint !== 'string') return String(endpoint);
    if (!(await validate(endpoint))) return endpoint;
  }
  return null;
}

/**
 * Fetch a well-known document without following redirects anywhere: the
 * endpoints inside it are validated, but the document itself was fetched
 * with `fetch`'s default `follow`, so a configured host that answered with a
 * redirect had the metadata read from wherever it pointed. One hop is
 * followed when it stays on the same host (an http -> https upgrade or a
 * path change); anything else is an error.
 */
async function fetchDiscoveryDocument(url: string): Promise<Response> {
  const first = await fetch(url, { signal: AbortSignal.timeout(DISCOVERY_TIMEOUT_MS), redirect: 'manual' });
  const status = typeof first.status === 'number' ? first.status : 200;
  if (status < 300 || status >= 400) return first;
  const location = first.headers.get('location');
  if (!location) throw new Error(`${url} redirected without a Location header`);
  const next = new URL(location, url);
  const from = new URL(url);
  const sameHost = next.hostname === from.hostname;
  const noDowngrade = next.protocol === 'https:' || next.protocol === from.protocol;
  if (!sameHost || !noDowngrade) {
    throw new Error(`${url} redirects to ${next.origin}, which is another host`);
  }
  return fetch(next.toString(), { signal: AbortSignal.timeout(DISCOVERY_TIMEOUT_MS), redirect: 'error' });
}

// One pass over the well-known documents. Returns usable metadata, or null
// (pushing diagnostics into `errors`) when neither URL yields a public,
// complete document. Each fetch is bounded by a timeout so an unresponsive IdP
// can never hang the request (and, with it, the login page's SSO button).
async function attemptDiscovery(
  urls: string[],
  validate: EndpointValidator | undefined,
  errors: string[],
): Promise<OAuthMetadata | null> {
  for (const url of urls) {
    try {
      const response = await fetchDiscoveryDocument(url);
      if (!response.ok) {
        errors.push(`${url} returned HTTP ${response.status}`);
        continue;
      }

      const data = await response.json();
      if (data.authorization_endpoint && data.token_endpoint) {
        const rejected = await findRejectedEndpoint([
          data.authorization_endpoint,
          data.token_endpoint,
          data.revocation_endpoint,
          data.end_session_endpoint,
        ], validate);
        if (rejected !== null) {
          // Name the endpoint: "unreachable" is the wrong lead when the IdP
          // answered and only the address its endpoint resolves to was refused.
          errors.push(
            `${url} advertises ${rejected}, which is invalid or resolves to a non-public address ` +
            '(set OAUTH_ALLOW_PRIVATE_ENDPOINTS=true if that host is internal on purpose)',
          );
          continue;
        }
        return {
          issuer: data.issuer,
          authorization_endpoint: data.authorization_endpoint,
          token_endpoint: data.token_endpoint,
          revocation_endpoint: data.revocation_endpoint,
          end_session_endpoint: data.end_session_endpoint,
          // Not followed from here: the one caller checks it itself (app/api/auth/desktop-oauth).
          ...(typeof data.registration_endpoint === 'string' ? { registration_endpoint: data.registration_endpoint } : {}),
          ...(Array.isArray(data.scopes_supported)
            ? { scopes_supported: data.scopes_supported.filter((s: unknown): s is string => typeof s === 'string') }
            : {}),
          ...(data.authorization_response_iss_parameter_supported === true
            ? { authorization_response_iss_parameter_supported: true }
            : {}),
        };
      }
      errors.push(`${url} response missing required endpoints`);
    } catch (err) {
      errors.push(`${url}: ${err instanceof Error ? err.message : String(err)}`);
      continue;
    }
  }
  return null;
}

/**
 * What discovery for a sign-in found: usable metadata, or why there is none.
 * `issuer_mismatch`: the metadata names another issuer than the address it
 * was fetched from while the rule is 'own', which the admin fixes by setting
 * that server's issuer URL. Everything else (no answer, no usable document,
 * no issuer at all) is `unavailable`.
 */
export type SignInDiscovery =
  | { metadata: OAuthMetadata; refusal?: undefined }
  | { metadata: null; refusal: 'unavailable' | 'issuer_mismatch' };

export async function discoverSignInMetadata(
  serverUrl: string,
  options?: DiscoverOAuthOptions,
): Promise<SignInDiscovery> {
  const metadata = await fetchMetadata(serverUrl, options);
  if (!metadata) return { metadata: null, refusal: 'unavailable' };
  const verdict = options?.issuerRule ? issuerVerdict(metadata, serverUrl, options.issuerRule) : 'ok';
  if (verdict !== 'ok') return { metadata: null, refusal: verdict };
  return { metadata };
}

export async function discoverOAuth(
  serverUrl: string,
  options?: DiscoverOAuthOptions,
): Promise<OAuthMetadata | null> {
  return (await discoverSignInMetadata(serverUrl, options)).metadata;
}

async function fetchMetadata(
  serverUrl: string,
  options?: DiscoverOAuthOptions,
): Promise<OAuthMetadata | null> {
  const cached = metadataCache.get(serverUrl);
  if (cached && cached.expiresAt > Date.now()) return cached.metadata;
  // A stale entry is deliberately retained (not deleted) so it can be served
  // as a fallback below if the refresh fails - this keeps the SSO button up
  // through a transient IdP blip.

  // Nothing to serve and we failed recently: skip hammering the IdP.
  if (!cached) {
    const retryAfter = negativeCache.get(serverUrl);
    if (retryAfter !== undefined && retryAfter > Date.now()) return null;
  }

  const urls = [
    `${serverUrl}/.well-known/oauth-authorization-server`,
    `${serverUrl}/.well-known/openid-configuration`,
  ];

  const errors: string[] = [];
  for (let attempt = 0; attempt <= DISCOVERY_RETRIES; attempt++) {
    if (attempt > 0) await sleep(DISCOVERY_RETRY_DELAY_MS);
    const metadata = await attemptDiscovery(urls, options?.validateEndpoint, errors);
    if (metadata) {
      rememberMetadata(serverUrl, metadata);
      negativeCache.delete(serverUrl);
      return metadata;
    }
  }

  // Every attempt failed. Prefer stale-but-usable metadata over nothing so the
  // login page keeps rendering the SSO button during the outage; throttle the
  // next re-discovery so we don't retry on every request.
  if (cached) {
    cached.expiresAt = Date.now() + DISCOVERY_FAILURE_TTL_MS;
    console.warn(`[OAuth] Discovery refresh failed for ${serverUrl}; serving stale metadata: ${errors.join('; ')}`);
    return cached.metadata;
  }

  rememberFailure(serverUrl);
  console.error(`[OAuth] Discovery failed for ${serverUrl}: ${errors.join('; ')}`);
  return null;
}
