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
async function registerClient(base: string, scope: string): Promise<string> {
  try {
    const response = await fetch(`${base}/auth/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        client_name: 'Bulwark',
        redirect_uris: [REGISTERED_REDIRECT],
        token_endpoint_auth_method: 'none',
        grant_types: ['authorization_code', 'refresh_token'],
        response_types: ['code'],
        scope,
      }),
      redirect: 'error',
      signal: AbortSignal.timeout(REGISTER_TIMEOUT_MS),
    });
    if (!response.ok) return FALLBACK_CLIENT_ID;
    const body = (await response.json()) as { client_id?: unknown };
    return typeof body.client_id === 'string' && body.client_id ? body.client_id : FALLBACK_CLIENT_ID;
  } catch (error) {
    logger.warn('Desktop OAuth: client registration failed', { error: error instanceof Error ? error.message : String(error) });
    return FALLBACK_CLIENT_ID;
  }
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
    return NextResponse.json({
      authorization_endpoint: metadata.authorization_endpoint,
      client_id: await registerClient(upstream.serverUrl, scope),
      scope,
    });
  } catch (error) {
    logger.error('Desktop OAuth discovery failed', { error: error instanceof Error ? error.message : 'Unknown error' });
    return NextResponse.json({ error: 'discovery_failed' }, { status: 503 });
  }
}
