/**
 * Scopes requested when neither OAUTH_SCOPES nor an admin override is set.
 * Kept free of server imports so the login page and admin dashboard can show
 * the same list the server actually sends.
 */
export const DEFAULT_OAUTH_SCOPES = 'openid email profile';

const DATA_SCOPE_PREFIX = 'urn:ietf:params:oauth:scope:';

/**
 * Stalwart 1.0.3's own scopes (#1527). A token reaches the account's admin
 * objects only with `full`; `security` covers passwords, 2FA, app passwords,
 * API keys and grants, `settings` the account settings and public keys.
 * Stalwart lists all three in `scopes_supported` whatever a client may use,
 * and fails the authorization request with `invalid_scope` when it names one
 * the client isn't allowed. So they are never added because the provider
 * lists them, only asked for when configured, as "Auto-configure OAuth" does
 * after registering the client with them.
 */
export const STALWART_SCOPE_FULL = 'urn:stalwart:oauth:scope:full';
export const STALWART_SCOPE_SECURITY = 'urn:stalwart:oauth:scope:security';
export const STALWART_SCOPE_SETTINGS = 'urn:stalwart:oauth:scope:settings';

const STALWART_SCOPES = [STALWART_SCOPE_FULL, STALWART_SCOPE_SECURITY, STALWART_SCOPE_SETTINGS];

/** The Stalwart scopes `list` names. */
export function stalwartScopesIn(list: string): string[] {
  return [...new Set(list.split(/\s+/).filter((s) => STALWART_SCOPES.includes(s)))];
}

/**
 * `list` asking for exactly the Stalwart scopes in `granted`: any other one
 * it names would fail the sign-in with `invalid_scope`.
 */
export function withStalwartScopes(list: string, granted: readonly string[]): string {
  const kept = list.split(/\s+/).filter((s) => s && !STALWART_SCOPES.includes(s));
  return [...new Set([...kept, ...granted])].join(' ');
}

/**
 * Scopes for a provider that advertises OAuth data scopes (Stalwart: mail,
 * contacts, calendars, files). Stalwart 1.0 gives a client it doesn't treat
 * as first-party only what these name, and refuses a request naming a scope
 * it doesn't know, such as `email` or `profile`. For such a provider the
 * scopes it doesn't list are dropped and every data scope it lists is added;
 * any other provider gets `scopes` unchanged. Stalwart's own scopes are kept
 * when configured and listed, never added (see {@link STALWART_SCOPE_FULL}).
 *
 * `forResource`: the request names the mail server as its resource (RFC
 * 8707, lib/oauth/resource.ts). A provider that grants scopes per API, such
 * as Pocket ID, lists only its own scopes in `scopes_supported`, never the
 * API's, so the configured Stalwart scopes are sent to it as they are
 * (#1583).
 */
export function withProviderDataScopes(scopes: string, supported: unknown, forResource = false): string {
  // Stalwart's own scopes go only to a provider that lists them: the configured
  // list is shared by every server, and another provider may refuse a scope it
  // doesn't know. The resource is only ever sent to the global provider, the
  // one the admin configured these scopes and that resource for.
  const listed: unknown[] = Array.isArray(supported) ? supported : [];
  scopes = scopes.split(/\s+/)
    .filter((s) => s && (forResource || !STALWART_SCOPES.includes(s) || listed.includes(s)))
    .join(' ');
  if (!Array.isArray(supported)) return scopes;
  const data = supported.filter((s): s is string => typeof s === 'string' && s.startsWith(DATA_SCOPE_PREFIX));
  if (data.length === 0) return scopes;
  const kept = scopes.split(/\s+/).filter((s) => s && supported.includes(s));
  return [...new Set([...kept, ...data])].join(' ');
}
