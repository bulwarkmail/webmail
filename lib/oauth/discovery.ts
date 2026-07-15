export interface OAuthMetadata {
  issuer: string;
  authorization_endpoint: string;
  token_endpoint: string;
  userinfo_endpoint?: string;
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

export async function discoverOAuth(
  serverUrl: string,
  options?: DiscoverOAuthOptions,
): Promise<OAuthMetadata | null> {
  const cached = metadataCache.get(serverUrl);
  if (cached && cached.expiresAt > Date.now()) return cached.metadata;
  if (cached) metadataCache.delete(serverUrl);

  const urls = [
    `${serverUrl}/.well-known/oauth-authorization-server`,
    `${serverUrl}/.well-known/openid-configuration`,
  ];

  const errors: string[] = [];

  for (const url of urls) {
    try {
      const response = await fetch(url);
      if (!response.ok) {
        errors.push(`${url} returned HTTP ${response.status}`);
        continue;
      }

      const data = await response.json();
      if (data.authorization_endpoint && data.token_endpoint) {
        const allPublic = await endpointsArePublic([
          data.authorization_endpoint,
          data.token_endpoint,
          data.userinfo_endpoint,
          data.revocation_endpoint,
          data.end_session_endpoint,
        ], options?.validateEndpoint);
        if (!allPublic) {
          errors.push(`${url} returned non-public or invalid endpoint URL`);
          continue;
        }
        const metadata: OAuthMetadata = {
          issuer: data.issuer,
          authorization_endpoint: data.authorization_endpoint,
          token_endpoint: data.token_endpoint,
          userinfo_endpoint: data.userinfo_endpoint,
          revocation_endpoint: data.revocation_endpoint,
          end_session_endpoint: data.end_session_endpoint,
        };
        rememberMetadata(serverUrl, metadata);
        return metadata;
      }
      errors.push(`${url} response missing required endpoints`);
    } catch (err) {
      errors.push(`${url}: ${err instanceof Error ? err.message : String(err)}`);
      continue;
    }
  }

  console.error(`[OAuth] Discovery failed for ${serverUrl}: ${errors.join('; ')}`);
  return null;
}
