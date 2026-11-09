/**
 * RFC 8707 resource indicator for the authorization request (#1461).
 *
 * Providers that issue access tokens per API, such as Pocket ID, only set the
 * token's audience to the mail server (and grant its scopes) when the client
 * names that API with `resource`. Stalwart 1.0 rejects tokens whose audience
 * isn't one of its resource identifiers.
 *
 * No server imports, so the login page can share the rule.
 */

/**
 * The resource as it goes on the wire, or undefined when the value can't be a
 * resource indicator: RFC 8707 requires an absolute URI without a fragment.
 */
export function normalizeOauthResource(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  if (!trimmed || trimmed.includes('#')) return undefined;
  try {
    // Throws for relative references; a scheme makes it absolute.
    new URL(trimmed);
  } catch {
    return undefined;
  }
  return trimmed;
}

/**
 * Adds `resource` to an authorization request built in the browser. The
 * configured resource names an API of the global provider, so like the issuer
 * (#952) it is left out when signing in to a server entry.
 */
export function addOauthResource(authUrl: URL, resource: unknown, forServerEntry: boolean): void {
  if (forServerEntry) return;
  const value = normalizeOauthResource(resource);
  if (value) authUrl.searchParams.set('resource', value);
}
