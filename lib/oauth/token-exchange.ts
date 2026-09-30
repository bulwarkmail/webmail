import { logger } from '@/lib/logger';
import { discoverOAuth } from '@/lib/oauth/discovery';
import type { EndpointValidator, OAuthMetadata } from '@/lib/oauth/discovery';
import { isPublicHttpUrl } from '@/lib/security/url-guard';
import { readFileEnv } from '@/lib/read-file-env';
import { configManager } from '@/lib/admin/config-manager';
import { parseJmapServers, findServerById } from '@/lib/admin/jmap-servers';

// Fallback OAuth client id used when no client is configured. The password+TOTP
// login route mints tokens against the mail server's built-in OAuth with this
// id (Stalwart accepts any client id unless `require_client_registration` is
// enabled), so refreshing/revoking those tokens must fall back to the same id
// instead of failing on the missing OAUTH_CLIENT_ID (#873).
export const DEFAULT_CLIENT_ID = 'bulwark-webmail';

export interface ClientConfigOptions {
  /**
   * Client id to use when none is configured. Only pass this for operations on
   * tokens that may have been minted by the TOTP login fallback; flows that
   * initiate OAuth (authorize URL, code exchange, SSO) must keep failing loudly
   * so a misconfiguration surfaces at login rather than as a broken session.
   */
  fallbackClientId?: string;
}

function httpOrigin(url: string): string | null {
  try {
    const u = new URL(url);
    if (u.protocol !== 'https:' && u.protocol !== 'http:') return null;
    if (u.username || u.password) return null;
    return u.origin;
  } catch {
    return null;
  }
}

// SSRF guard for OAuth discovery. `discoveryUrl` comes from admin config (the
// issuer or the JMAP server, see getRequiredConfig), and discovery has already
// connected to it, so endpoints on that same origin are trusted the way the
// configured JMAP server is in stalwart-context. Rejecting them broke
// split-horizon DNS, where the issuer's public hostname resolves to an
// in-cluster address (#1028). Every other endpoint in the document must still
// resolve publicly, so a spoofed or compromised document cannot aim the token
// or revocation request at another internal host. When
// `oauthAllowPrivateEndpoints` is set, the admin opts out of the guard
// entirely, for IdPs that advertise endpoints on other internal hosts.
export function getDiscoveryValidator(discoveryUrl: string): EndpointValidator | undefined {
  const allowPrivate = configManager.get<boolean>('oauthAllowPrivateEndpoints', false);
  if (allowPrivate) return undefined;
  const issuerOrigin = httpOrigin(discoveryUrl);
  return async (endpoint: string) =>
    (issuerOrigin !== null && httpOrigin(endpoint) === issuerOrigin) || isPublicHttpUrl(endpoint);
}

function getGlobalClientSecret(): string {
  const adminSecret = configManager.get<string>('oauthClientSecret', '');
  if (adminSecret) return adminSecret;

  const adminFileSecret = readFileEnv(
    configManager.get<string>('oauthClientSecretFile', ''),
  );
  if (adminFileSecret) return adminFileSecret;

  return process.env.OAUTH_CLIENT_SECRET || readFileEnv(process.env.OAUTH_CLIENT_SECRET_FILE) || '';
}

function getServerEntry(serverId?: string | null) {
  if (!serverId) return undefined;
  const servers = parseJmapServers(configManager.get<unknown>('jmapServers', []));
  return findServerById(servers, serverId);
}

/**
 * Strip a trailing JMAP session path so OAuth discovery hits the right base.
 *
 * `discoverOAuth` appends `/.well-known/...` to this base, so JMAP_SERVER_URL set to
 * the session URL (`.../jmap/session` or `.../.well-known/jmap`, common so the client
 * can skip the 307 redirect a preflighted CORS request cannot follow) makes discovery
 * fetch `<session-url>/.well-known/oauth-authorization-server`, get a 404, and refresh
 * fail with "OAuth token endpoint not found".
 *
 * Only the session suffix (and any query or fragment) is removed, not the whole path:
 * discovery also runs against OAUTH_ISSUER_URL, and a path-based issuer (for example a
 * Keycloak realm at `/realms/<name>`) must keep its path. So this is deliberately not
 * `new URL(url).origin`. (#971)
 */
function discoveryBase(url: string): string {
  try {
    const u = new URL(url);
    u.pathname = u.pathname.replace(/\/(?:jmap\/session|\.well-known\/jmap)\/*$/, '');
    u.search = '';
    u.hash = '';
    return u.toString().replace(/\/+$/, '');
  } catch {
    return url;
  }
}

export function getRequiredConfig(serverId?: string | null, options?: ClientConfigOptions) {
  const entry = getServerEntry(serverId);

  const globalClientId = configManager.get<string>('oauthClientId', '') || process.env.OAUTH_CLIENT_ID;
  const globalServerUrl = configManager.get<string>('jmapServerUrl', '') || process.env.JMAP_SERVER_URL || process.env.NEXT_PUBLIC_JMAP_SERVER_URL;
  const globalIssuerUrl = configManager.get<string>('oauthIssuerUrl', '') || process.env.OAUTH_ISSUER_URL;

  const clientId = entry?.oauth?.clientId || globalClientId || options?.fallbackClientId;
  const serverUrl = entry?.url || globalServerUrl;
  // When the user picked a server, discovery must stay on that server: its
  // own issuer if configured, otherwise the server itself. The global
  // OAUTH_ISSUER_URL only applies when no server entry was resolved, or it
  // would silently send every server's SSO to server 1's IdP. (#952)
  const issuerUrl = entry ? (entry.oauth?.issuerUrl || entry.url) : globalIssuerUrl;

  if (!clientId || !serverUrl) {
    throw new Error(`OAuth misconfigured: ${[!clientId && 'OAUTH_CLIENT_ID', !serverUrl && 'JMAP_SERVER_URL'].filter(Boolean).join(', ')} not set`);
  }
  const discoveryUrl = discoveryBase(issuerUrl?.trim() || serverUrl);
  if (issuerUrl !== undefined && issuerUrl !== '' && !issuerUrl.trim()) {
    logger.warn('OAUTH_ISSUER_URL is set but empty, falling back to JMAP_SERVER_URL for discovery');
  }
  return { clientId, serverUrl, discoveryUrl, serverId: entry?.id };
}

export function getClientSecret(serverId?: string | null): string {
  const entry = getServerEntry(serverId);
  if (entry?.oauth?.clientSecret) return entry.oauth.clientSecret;
  return getGlobalClientSecret();
}

/**
 * Whether the server's client is confidential. Tokens minted for it can only
 * be refreshed with the secret, which never leaves this server - so a paired
 * phone renews them through the webmail (see lib/auth/pair-bundle.ts).
 */
export function hasClientSecret(serverId?: string | null): boolean {
  return getClientSecret(serverId) !== '';
}

export async function getTokenEndpoint(serverId?: string | null, options?: ClientConfigOptions): Promise<string> {
  const { discoveryUrl } = getRequiredConfig(serverId, options);
  const metadata = await discoverOAuth(discoveryUrl, { validateEndpoint: getDiscoveryValidator(discoveryUrl) });
  if (!metadata?.token_endpoint) {
    throw new Error('OAuth token endpoint not found');
  }
  return metadata.token_endpoint;
}

export async function getMetadata(serverId?: string | null, options?: ClientConfigOptions): Promise<OAuthMetadata | null> {
  const { discoveryUrl } = getRequiredConfig(serverId, options);
  return discoverOAuth(discoveryUrl, { validateEndpoint: getDiscoveryValidator(discoveryUrl) });
}

export function buildOAuthParams(base: Record<string, string>, serverId?: string | null, options?: ClientConfigOptions): URLSearchParams {
  const { clientId } = getRequiredConfig(serverId, options);
  const params = new URLSearchParams({ ...base, client_id: clientId });
  const secret = getClientSecret(serverId);
  if (secret) {
    params.set('client_secret', secret);
  }
  return params;
}

export interface TokenResult {
  access_token: string;
  expires_in: number;
  refresh_token?: string;
  /** OIDC id token, kept for RP-initiated logout (`id_token_hint`). */
  id_token?: string;
}

export async function exchangeCodeForTokens(
  code: string,
  codeVerifier: string,
  redirectUri: string,
  serverId?: string | null,
): Promise<TokenResult> {
  const tokenEndpoint = await getTokenEndpoint(serverId);

  const params = buildOAuthParams({
    grant_type: 'authorization_code',
    code,
    redirect_uri: redirectUri,
    code_verifier: codeVerifier,
  }, serverId);

  // The body carries the code, the PKCE verifier and the client secret. The
  // endpoint was validated; a redirect would re-send all of it to a host
  // that was not, so none is followed.
  const tokenResponse = await fetch(tokenEndpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: params.toString(),
    redirect: 'error',
  });

  if (!tokenResponse.ok) {
    const errorText = await tokenResponse.text();
    logger.error('Token exchange failed', { status: tokenResponse.status, error: errorText });
    throw new Error('Token exchange failed');
  }

  const tokens = await tokenResponse.json();

  if (!tokens.access_token) {
    logger.error('Token response missing access_token', { response: JSON.stringify(tokens).substring(0, 500) });
    throw new Error('Invalid token response');
  }

  return {
    access_token: tokens.access_token,
    expires_in: tokens.expires_in || 3600,
    refresh_token: tokens.refresh_token,
    id_token: typeof tokens.id_token === 'string' ? tokens.id_token : undefined,
  };
}
