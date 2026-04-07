import { logger } from '@/lib/logger';
import { discoverOAuth } from '@/lib/oauth/discovery';
import type { OAuthMetadata } from '@/lib/oauth/discovery';
import { readFileEnv } from '@/lib/read-file-env';

const CLIENT_SECRET = process.env.OAUTH_CLIENT_SECRET || readFileEnv(process.env.OAUTH_CLIENT_SECRET_FILE) || '';

export function getRequiredConfig() {
  const clientId = process.env.OAUTH_CLIENT_ID;
  const serverUrl = process.env.JMAP_SERVER_URL || process.env.NEXT_PUBLIC_JMAP_SERVER_URL;
  const issuerUrl = process.env.OAUTH_ISSUER_URL;
  if (!clientId || !serverUrl) {
    throw new Error(`OAuth misconfigured: ${[!clientId && 'OAUTH_CLIENT_ID', !serverUrl && 'JMAP_SERVER_URL'].filter(Boolean).join(', ')} not set`);
  }
  const discoveryUrl = issuerUrl?.trim() || serverUrl;
  if (issuerUrl !== undefined && !issuerUrl.trim()) {
    logger.warn('OAUTH_ISSUER_URL is set but empty, falling back to JMAP_SERVER_URL for discovery');
  }
  return { clientId, serverUrl, discoveryUrl };
}

export async function getTokenEndpoint(): Promise<string> {
  const { discoveryUrl } = getRequiredConfig();
  const metadata = await discoverOAuth(discoveryUrl);
  if (!metadata?.token_endpoint) {
    throw new Error('OAuth token endpoint not found');
  }
  return metadata.token_endpoint;
}

export async function getMetadata(): Promise<OAuthMetadata | null> {
  const { discoveryUrl } = getRequiredConfig();
  return discoverOAuth(discoveryUrl);
}

export function buildOAuthParams(base: Record<string, string>): URLSearchParams {
  const { clientId } = getRequiredConfig();
  const params = new URLSearchParams({ ...base, client_id: clientId });
  if (CLIENT_SECRET) {
    params.set('client_secret', CLIENT_SECRET);
  }
  return params;
}

export interface TokenResult {
  access_token: string;
  expires_in: number;
  refresh_token?: string;
}

export async function exchangeCodeForTokens(
  code: string,
  codeVerifier: string,
  redirectUri: string,
): Promise<TokenResult> {
  const tokenEndpoint = await getTokenEndpoint();

  const params = buildOAuthParams({
    grant_type: 'authorization_code',
    code,
    redirect_uri: redirectUri,
    code_verifier: codeVerifier,
  });

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
