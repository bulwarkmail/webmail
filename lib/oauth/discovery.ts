export interface OAuthMetadata {
  issuer: string;
  authorization_endpoint: string;
  token_endpoint: string;
  revocation_endpoint?: string;
  end_session_endpoint?: string;
}

// Validates that a discovered endpoint URL is safe to follow. Server-side
// callers must pass this to gate against SSRF (typically isPublicHttpUrl from
// @/lib/security/url-guard, which uses node:dns and cannot be bundled for the
// browser). Client callers omit it: the browser handles outbound networking
// and an SSRF check isn't meaningful there.
export type EndpointValidator = (url: string) => Promise<boolean>;

export interface DiscoverOAuthOptions {
  validateEndpoint?: EndpointValidator;
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
async function endpointsArePublic(
  endpoints: Array<string | undefined>,
  validate: EndpointValidator | undefined,
): Promise<boolean> {
  if (!validate) return true;
  for (const endpoint of endpoints) {
    if (endpoint === undefined) continue;
    if (typeof endpoint !== 'string') return false;
    if (!(await validate(endpoint))) return false;
  }
  return true;
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
      const response = await fetch(url, { signal: AbortSignal.timeout(DISCOVERY_TIMEOUT_MS) });
      if (!response.ok) {
        errors.push(`${url} returned HTTP ${response.status}`);
        continue;
      }

      const data = await response.json();
      if (data.authorization_endpoint && data.token_endpoint) {
        const allPublic = await endpointsArePublic([
          data.authorization_endpoint,
          data.token_endpoint,
          data.revocation_endpoint,
          data.end_session_endpoint,
        ], validate);
        if (!allPublic) {
          errors.push(`${url} returned non-public or invalid endpoint URL`);
          continue;
        }
        return {
          issuer: data.issuer,
          authorization_endpoint: data.authorization_endpoint,
          token_endpoint: data.token_endpoint,
          revocation_endpoint: data.revocation_endpoint,
          end_session_endpoint: data.end_session_endpoint,
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

export async function discoverOAuth(
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
