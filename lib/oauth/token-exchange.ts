import { logger } from '@/lib/logger';
import { discoverOAuth } from '@/lib/oauth/discovery';
import type { EndpointValidator, OAuthMetadata } from '@/lib/oauth/discovery';
import { isPublicHttpUrl } from '@/lib/security/url-guard';
import { readFileEnv } from '@/lib/read-file-env';
import { configManager } from '@/lib/admin/config-manager';
import { parseJmapServers, findServerById } from '@/lib/admin/jmap-servers';

// SSRF guard for OAuth discovery. When `oauthAllowPrivateEndpoints` is set,
// the admin opts in to discovery resolving to RFC-1918 / loopback hosts —
// required for split-DNS deployments where the JMAP server's public hostname
// resolves to an internal IP locally. The guard remains in force for any
// caller that passes a user-supplied serverUrl (see totp-token-exchange).
export function getDiscoveryValidator(): EndpointValidator | undefined {
  const allowPrivate = configManager.get<boolean>('oauthAllowPrivateEndpoints', false);
  return allowPrivate ? undefined : isPublicHttpUrl;
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

export function getRequiredConfig(serverId?: string | null) {
  const entry = getServerEntry(serverId);

  const globalClientId = configManager.get<string>('oauthClientId', '') || process.env.OAUTH_CLIENT_ID;
  const globalServerUrl = configManager.get<string>('jmapServerUrl', '') || process.env.JMAP_SERVER_URL || process.env.NEXT_PUBLIC_JMAP_SERVER_URL;
  const globalIssuerUrl = configManager.get<string>('oauthIssuerUrl', '') || process.env.OAUTH_ISSUER_URL;

  const clientId = entry?.oauth?.clientId || globalClientId;
  const serverUrl = entry?.url || globalServerUrl;
  const issuerUrl = entry?.oauth?.issuerUrl || globalIssuerUrl;

  if (!clientId || !serverUrl) {
    throw new Error(`OAuth misconfigured: ${[!clientId && 'OAUTH_CLIENT_ID', !serverUrl && 'JMAP_SERVER_URL'].filter(Boolean).join(', ')} not set`);
  }
  const discoveryUrl = issuerUrl?.trim() || serverUrl;
  if (issuerUrl !== undefined && issuerUrl !== '' && !issuerUrl.trim()) {
    logger.warn('OAUTH_ISSUER_URL is set but empty, falling back to JMAP_SERVER_URL for discovery');
  }
  return { clientId, serverUrl, discoveryUrl, serverId: entry?.id };
}

function getClientSecret(serverId?: string | null): string {
  const entry = getServerEntry(serverId);
  if (entry?.oauth?.clientSecret) return entry.oauth.clientSecret;
  return getGlobalClientSecret();
}

export async function getTokenEndpoint(serverId?: string | null): Promise<string> {
  const { discoveryUrl } = getRequiredConfig(serverId);
  const metadata = await discoverOAuth(discoveryUrl, { validateEndpoint: getDiscoveryValidator() });
  if (!metadata?.token_endpoint) {
    throw new Error('OAuth token endpoint not found');
  }
  return metadata.token_endpoint;
}

export async function getMetadata(serverId?: string | null): Promise<OAuthMetadata | null> {
  const { discoveryUrl } = getRequiredConfig(serverId);
  return discoverOAuth(discoveryUrl, { validateEndpoint: getDiscoveryValidator() });
}

export function buildOAuthParams(base: Record<string, string>, serverId?: string | null): URLSearchParams {
  const { clientId } = getRequiredConfig(serverId);
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
}

export interface UserInfoResult {
  picture?: string;
  avatar?: string;
  avatar_url?: string;
}

function avatarFromUserInfo(data: unknown): string | undefined {
  if (!data || typeof data !== 'object') return undefined;
  const record = data as Record<string, unknown>;
  const value = record.picture || record.avatar || record.avatar_url;
  if (typeof value !== 'string') return undefined;
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:') return undefined;
    return url.toString();
  } catch {
    return undefined;
  }
}

export async function fetchUserInfoAvatar(
  accessToken: string,
  serverId?: string | null,
): Promise<string | undefined> {
  const metadata = await getMetadata(serverId);
  if (!metadata?.userinfo_endpoint) return undefined;

  const response = await fetch(metadata.userinfo_endpoint, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });

  if (!response.ok) {
    logger.warn('Userinfo request failed', { status: response.status });
    return undefined;
  }

  return avatarFromUserInfo(await response.json());
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

  const tokenResponse = await fetch(tokenEndpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: params.toString(),
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
  };
}
