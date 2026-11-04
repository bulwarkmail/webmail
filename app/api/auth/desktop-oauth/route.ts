import { NextRequest, NextResponse } from 'next/server';
import { logger } from '@/lib/logger';
import { IS_DESKTOP_BUILD } from '@/lib/desktop/flag';
import { discoverOAuth } from '@/lib/oauth/discovery';
import { DEFAULT_OAUTH_SCOPES, withProviderDataScopes } from '@/lib/oauth/scopes';
import { getDiscoveryValidator } from '@/lib/oauth/token-exchange';
import { resolveCustomUpstream } from '@/lib/oauth/custom-upstream';
import { rejectCrossOriginRequest } from '@/lib/security/same-origin';

/** The client id on a server that won't register one: 0.16 accepts any id. */
const FALLBACK_CLIENT_ID = 'bulwark-desktop';
const REGISTERED_REDIRECT = 'http://127.0.0.1/bulwark-desktop/callback';
/** Only tried when the server says no to loopback. Neither Stalwart line takes this one. */
const SCHEME_REDIRECT = 'bulwark://sign-in/callback';
const REGISTER_TIMEOUT_MS = 5000;

function isLoopbackRedirect(value: unknown): boolean {
  if (typeof value !== 'string') return false;
  try {
    const url = new URL(value);
    return url.protocol === 'http:' && url.hostname === '127.0.0.1' && url.pathname === '/bulwark-desktop/callback';
  } catch {
    return false;
  }
}

/**
 * Registers the desktop app as a public client. Stalwart 1.0 needs this: its
 * ids are stateless, so the same metadata gives the same id and nothing is
 * stored. It accepts a loopback redirect and ignores the port when matching.
 */
async function postRegistration(endpoint: string, redirectUri: string, scope: string): Promise<Response> {
  return fetch(endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      client_name: 'Bulwark',
      redirect_uris: [redirectUri],
      token_endpoint_auth_method: 'none',
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      scope,
    }),
    redirect: 'error',
    signal: AbortSignal.timeout(REGISTER_TIMEOUT_MS),
  });
}

async function clientIdOf(response: Response): Promise<string | null> {
  const body = (await response.json().catch(() => null)) as { client_id?: unknown } | null;
  return typeof body?.client_id === 'string' && body.client_id ? body.client_id : null;
}

async function registerClient(endpoint: string, scope: string): Promise<{ clientId: string; useScheme: boolean }> {
  try {
    const response = await postRegistration(endpoint, REGISTERED_REDIRECT, scope);
    if (response.ok) return { clientId: (await clientIdOf(response)) ?? FALLBACK_CLIENT_ID, useScheme: false };
    const refusal = (await response.json().catch(() => null)) as { error?: unknown } | null;
    if (refusal?.error === 'invalid_redirect_uri') {
      const second = await postRegistration(endpoint, SCHEME_REDIRECT, scope);
      const clientId = second.ok ? await clientIdOf(second) : null;
      if (clientId) return { clientId, useScheme: true };
    }
  } catch (error) {
    logger.warn('Desktop OAuth: client registration failed', { error: error instanceof Error ? error.message : String(error) });
  }
  return { clientId: FALLBACK_CLIENT_ID, useScheme: false };
}

/**
 * What the desktop app needs to send the user to a server's own sign-in page:
 * the authorize endpoint and a client id. Only in the desktop build. Discovery
 * runs here rather than in the page, for the same reason as on the login page:
 * the documents often have no CORS headers.
 */
export async function POST(request: NextRequest) {
  if (!IS_DESKTOP_BUILD) return NextResponse.json({ error: 'Not found' }, { status: 404 });
  const crossOrigin = rejectCrossOriginRequest(request);
  if (crossOrigin) return crossOrigin;
  try {
    const { serverUrl, redirectUri } = await request.json();
    if (!isLoopbackRedirect(redirectUri)) {
      return NextResponse.json({ error: 'invalid_redirect' }, { status: 400 });
    }
    const upstream = await resolveCustomUpstream(serverUrl, FALLBACK_CLIENT_ID);
    if (!upstream) return NextResponse.json({ error: 'invalid_server_url' }, { status: 400 });

    const metadata = await discoverOAuth(upstream.serverUrl, { validateEndpoint: getDiscoveryValidator(upstream.serverUrl) });
    if (!metadata) return NextResponse.json({ error: 'no_oauth' }, { status: 404 });

    const scope = withProviderDataScopes(DEFAULT_OAUTH_SCOPES, metadata.scopes_supported);
    // RFC 8414 says where. Without it, Stalwart's path: 0.16's documents don't always name it.
    const validate = getDiscoveryValidator(upstream.serverUrl);
    const named = metadata.registration_endpoint;
    const endpoint = named && (!validate || (await validate(named))) ? named : `${upstream.serverUrl}/auth/register`;
    const { clientId, useScheme } = await registerClient(endpoint, scope);
    return NextResponse.json({
      authorization_endpoint: metadata.authorization_endpoint,
      client_id: clientId,
      scope,
      issuer: metadata.issuer,
      ...(useScheme ? { use_scheme: true } : {}),
    });
  } catch (error) {
    logger.error('Desktop OAuth discovery failed', { error: error instanceof Error ? error.message : 'Unknown error' });
    return NextResponse.json({ error: 'discovery_failed' }, { status: 503 });
  }
}
