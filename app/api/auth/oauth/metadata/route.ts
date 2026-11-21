import { NextRequest, NextResponse } from 'next/server';
import { logger } from '@/lib/logger';
import { configManager } from '@/lib/admin/config-manager';
import { discoverSignIn, getRequiredConfig } from '@/lib/oauth/token-exchange';
import { loggableError } from '@/lib/oauth/answer-summary';

/**
 * Same-origin OAuth metadata (discovery) proxy.
 *
 * The login page needs the authorization_endpoint to build the PKCE authorize
 * URL in the browser. Discovering it directly from the browser means a
 * cross-origin fetch to the IdP's /.well-known/* documents, which is subject
 * to CORS: providers like Authentik serve those documents without an
 * Access-Control-Allow-Origin header, so the browser blocks the response and
 * discovery fails (issue #382). Performing discovery here - server to server,
 * where CORS does not apply - and handing the result back as a same-origin
 * response sidesteps the problem entirely.
 *
 * The discovery URL is resolved from admin config (via server_id), never from
 * client input, so this cannot be abused as an open SSRF proxy. Endpoint URLs
 * in the discovered document are still gated by the SSRF validator inside
 * discoverOAuth. The returned fields are public well-known metadata.
 */
export async function GET(request: NextRequest) {
  await configManager.ensureLoaded();
  const serverId = request.nextUrl.searchParams.get('server_id');

  let discoveryUrl: string;
  try {
    ({ discoveryUrl } = getRequiredConfig(serverId));
  } catch {
    // OAuth not configured for this server - surface as "no metadata" rather
    // than a 500 so the login page just hides the SSO button.
    return NextResponse.json({ error: 'OAuth not configured' }, { status: 404 });
  }

  try {
    // The login page builds the authorize URL from this, and the mobile app
    // compares its issuer with the configured issuer URL: the same rule as
    // a sign-in here (signInIssuerRule).
    const { metadata, refusal } = await discoverSignIn(serverId);
    // A provider naming another issuer is a setting the admin has to fix, not
    // an outage: the page says so (discovery logged it once already).
    if (refusal === 'issuer_mismatch') {
      return NextResponse.json({ error: 'issuer_mismatch' }, { status: 502 });
    }
    if (!metadata?.authorization_endpoint || !metadata.token_endpoint) {
      logger.warn('OAuth metadata discovery returned no usable endpoints', { discoveryUrl });
      return NextResponse.json({ error: 'OAuth discovery failed' }, { status: 502 });
    }
    return NextResponse.json(metadata, {
      // Mirror the in-process discovery cache TTL so repeated login-page loads
      // hit the CDN/browser cache instead of re-running discovery.
      headers: { 'Cache-Control': 'private, max-age=600' },
    });
  } catch (error) {
    logger.error('OAuth metadata discovery error', { error: loggableError(error) });
    return NextResponse.json({ error: 'OAuth discovery failed' }, { status: 502 });
  }
}
