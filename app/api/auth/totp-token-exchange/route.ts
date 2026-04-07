import { NextRequest, NextResponse } from 'next/server';
import { cookies } from 'next/headers';
import { logger } from '@/lib/logger';
import { discoverOAuth } from '@/lib/oauth/discovery';
import { refreshTokenCookieName } from '@/lib/oauth/tokens';
import { getCookieOptions } from '@/lib/oauth/cookie-config';
import { readFileEnv } from '@/lib/read-file-env';

/**
 * Exchange basic auth credentials (with TOTP appended) for OAuth tokens.
 *
 * This allows 2FA users who log in with basic auth + TOTP to upgrade
 * to token-based auth, avoiding session expiry when the TOTP rotates.
 *
 * Tries three strategies:
 * 1. ROPC grant with client_id (if OAUTH_CLIENT_ID is set)
 * 2. ROPC grant without client_id
 * 3. ROPC grant authenticated via Basic Auth header (Stalwart-style)
 */

async function tryTokenRequest(
  tokenEndpoint: string,
  params: URLSearchParams,
  extraHeaders?: Record<string, string>,
): Promise<{ ok: true; tokens: { access_token: string; expires_in?: number; refresh_token?: string } } | { ok: false; status: number; error: string }> {
  try {
    const headers: Record<string, string> = { 'Content-Type': 'application/x-www-form-urlencoded', ...extraHeaders };
    const response = await fetch(tokenEndpoint, {
      method: 'POST',
      headers,
      body: params.toString(),
    });

    if (!response.ok) {
      const errorText = await response.text();
      return { ok: false, status: response.status, error: errorText.substring(0, 500) };
    }

    const tokens = await response.json();
    if (!tokens.access_token) {
      return { ok: false, status: 502, error: 'Response missing access_token' };
    }

    return { ok: true, tokens };
  } catch (err) {
    return { ok: false, status: 0, error: err instanceof Error ? err.message : String(err) };
  }
}

async function findTokenEndpoint(serverUrl: string): Promise<string | null> {
  // 1. Try OAuth discovery
  const metadata = await discoverOAuth(serverUrl);
  if (metadata?.token_endpoint) return metadata.token_endpoint;

  // 2. Try common Stalwart token endpoint paths directly
  const candidates = [
    `${serverUrl}/auth/token`,
    `${serverUrl}/api/oauth/token`,
  ];

  for (const url of candidates) {
    try {
      // A POST with no body should return 400 (bad request) rather than 404 if the endpoint exists
      const probe = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: 'grant_type=probe' });
      if (probe.status !== 404 && probe.status !== 405) {
        return url;
      }
    } catch {
      // Network error — endpoint not reachable
    }
  }

  return null;
}

export async function POST(request: NextRequest) {
  try {
    const { serverUrl, username, password, slot: bodySlot } = await request.json();

    if (!serverUrl || !username || !password) {
      return NextResponse.json({ error: 'Missing required parameters' }, { status: 400 });
    }

    const slot = typeof bodySlot === 'number' && bodySlot >= 0 && bodySlot <= 4 ? bodySlot : 0;

    // Use the server-side JMAP_SERVER_URL if set (may differ from the
    // public URL the browser uses, e.g. inside Docker).
    const internalServerUrl = process.env.JMAP_SERVER_URL || process.env.NEXT_PUBLIC_JMAP_SERVER_URL || serverUrl;

    const tokenEndpoint = await findTokenEndpoint(internalServerUrl);
    if (!tokenEndpoint) {
      // Also try with the client-provided URL in case the internal one differs
      const clientEndpoint = internalServerUrl !== serverUrl ? await findTokenEndpoint(serverUrl) : null;
      if (!clientEndpoint) {
        logger.warn('TOTP token exchange: no token endpoint found', { serverUrl, internalServerUrl });
        return NextResponse.json({ error: 'no_token_endpoint', detail: 'Could not discover OAuth token endpoint on the mail server' }, { status: 404 });
      }
      return await attemptAllStrategies(clientEndpoint, username, password, slot);
    }

    return await attemptAllStrategies(tokenEndpoint, username, password, slot);
  } catch (error) {
    logger.error('TOTP token exchange error', { error: error instanceof Error ? error.message : 'Unknown error' });
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}

async function attemptAllStrategies(
  tokenEndpoint: string,
  username: string,
  password: string,
  slot: number,
): Promise<NextResponse> {
  logger.info('TOTP token exchange: found token endpoint', { tokenEndpoint });

  const clientId = process.env.OAUTH_CLIENT_ID;
  const clientSecret = process.env.OAUTH_CLIENT_SECRET || readFileEnv(process.env.OAUTH_CLIENT_SECRET_FILE);
  const basicAuth = `Basic ${Buffer.from(`${username}:${password}`).toString('base64')}`;
  const attempts: Array<{ strategy: string; error: string }> = [];

  // Strategy 1: ROPC with client_id (if configured)
  if (clientId) {
    const params = new URLSearchParams({ grant_type: 'password', username, password, client_id: clientId });
    if (clientSecret) params.set('client_secret', clientSecret);
    const result = await tryTokenRequest(tokenEndpoint, params);
    if (result.ok) {
      logger.info('TOTP token exchange succeeded (ROPC with client_id)');
      return await storeAndRespond(result.tokens, slot);
    }
    attempts.push({ strategy: 'ROPC with client_id', error: result.error });
  }

  // Strategy 2: ROPC without client_id
  {
    const params = new URLSearchParams({ grant_type: 'password', username, password });
    const result = await tryTokenRequest(tokenEndpoint, params);
    if (result.ok) {
      logger.info('TOTP token exchange succeeded (ROPC without client_id)');
      return await storeAndRespond(result.tokens, slot);
    }
    attempts.push({ strategy: 'ROPC without client_id', error: result.error });
  }

  // Strategy 3: Basic Auth header on token endpoint (some servers accept this)
  {
    const params = new URLSearchParams({ grant_type: 'password' });
    const result = await tryTokenRequest(tokenEndpoint, params, { 'Authorization': basicAuth });
    if (result.ok) {
      logger.info('TOTP token exchange succeeded (Basic Auth header)');
      return await storeAndRespond(result.tokens, slot);
    }
    attempts.push({ strategy: 'Basic Auth header', error: result.error });
  }

  // Strategy 4: client_credentials with Basic Auth (last resort)
  {
    const params = new URLSearchParams({ grant_type: 'client_credentials' });
    const result = await tryTokenRequest(tokenEndpoint, params, { 'Authorization': basicAuth });
    if (result.ok) {
      logger.info('TOTP token exchange succeeded (client_credentials + Basic Auth)');
      return await storeAndRespond(result.tokens, slot);
    }
    attempts.push({ strategy: 'client_credentials + Basic Auth', error: result.error });
  }

  logger.warn('TOTP token exchange: all strategies failed', { attempts });
  return NextResponse.json({
    error: 'token_exchange_failed',
    detail: 'All token exchange strategies failed',
    attempts,
  }, { status: 502 });
}

async function storeAndRespond(
  tokens: { access_token: string; expires_in?: number; refresh_token?: string },
  slot: number,
): Promise<NextResponse> {
  if (tokens.refresh_token) {
    const cookieName = refreshTokenCookieName(slot);
    const cookieStore = await cookies();
    cookieStore.set(cookieName, tokens.refresh_token, getCookieOptions());
  }

  return NextResponse.json({
    access_token: tokens.access_token,
    expires_in: tokens.expires_in || 3600,
    has_refresh_token: !!tokens.refresh_token,
  });
}
