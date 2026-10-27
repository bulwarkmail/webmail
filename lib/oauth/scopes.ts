/**
 * Scopes requested when neither OAUTH_SCOPES nor an admin override is set.
 * Kept free of server imports so the login page and admin dashboard can show
 * the same list the server actually sends.
 */
export const DEFAULT_OAUTH_SCOPES = 'openid email profile';

const DATA_SCOPE_PREFIX = 'urn:ietf:params:oauth:scope:';

/**
 * Scopes for a provider that advertises OAuth data scopes (Stalwart: mail,
 * contacts, calendars, files). Stalwart 1.0 gives a client it doesn't treat
 * as first-party only what these name, and refuses a request naming a scope
 * it doesn't know, such as `email` or `profile`. For such a provider the
 * scopes it doesn't list are dropped and every data scope it lists is added;
 * any other provider gets `scopes` unchanged.
 */
export function withProviderDataScopes(scopes: string, supported: unknown): string {
  if (!Array.isArray(supported)) return scopes;
  const data = supported.filter((s): s is string => typeof s === 'string' && s.startsWith(DATA_SCOPE_PREFIX));
  if (data.length === 0) return scopes;
  const kept = scopes.split(/\s+/).filter((s) => s && supported.includes(s));
  return [...new Set([...kept, ...data])].join(' ');
}
