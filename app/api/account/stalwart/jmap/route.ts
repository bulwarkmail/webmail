import { NextRequest, NextResponse } from 'next/server';
import { rejectCrossOriginRequest } from '@/lib/security/same-origin';
import { logger } from '@/lib/logger';
import { configManager } from '@/lib/admin/config-manager';
import { getStalwartCredentials } from '@/lib/stalwart/credentials';
import { JmapRedirectError, fetchJmapSession, postJmap, rebaseApiUrl } from '@/lib/stalwart/jmap-api';
import { DisallowedUrlError } from '@/lib/security/url-guard';

/**
 * POST /api/account/stalwart/jmap
 *
 * Passthrough to Stalwart's JMAP endpoint using the stored basic-auth
 * context so the browser does not need access to the user's credentials.
 *
 * Body: standard JMAP request `{ using: string[], methodCalls: [...] }`
 *
 * In Stalwart 0.16 all management operations (password change, app
 * passwords, API keys, account settings, etc.) are exposed as JMAP
 * methods under the `x:` namespace on the same endpoint.
 */
export async function POST(request: NextRequest) {
  // CSRF gate (GHSA-9mvj-98f5-9q6g): this handler acts with the caller's
  // session cookie, which SameSite=Lax still sends from a same-site page.
  const crossOrigin = rejectCrossOriginRequest(request);
  if (crossOrigin) return crossOrigin;
  // Registered unconditionally by Next, so the switch lives here: when the
  // passthrough (or Stalwart features as a whole) is disabled the route
  // does not exist as far as callers are concerned. Checked before the
  // credential lookup so a disabled route never touches the session. (#904)
  await configManager.ensureLoaded();
  const passthroughEnabled =
    configManager.get<boolean>('stalwartFeaturesEnabled', true) &&
    configManager.get<boolean>('stalwartJmapPassthroughEnabled', true);
  if (!passthroughEnabled) {
    return NextResponse.json({ error: 'Not found' }, { status: 404 });
  }

  try {
    const creds = await getStalwartCredentials(request);
    if (!creds) {
      return NextResponse.json({ error: 'Not authenticated' }, { status: 401 });
    }

    const body = await request.text();

    const fetchOptions = { trusted: creds.trusted };
    const directUrl = `${creds.serverUrl}/jmap/`;
    let response = await postJmap(directUrl, creds.authHeader, body, fetchOptions);

    if (response.status === 404) {
      // `${serverUrl}/jmap/` is not the API endpoint on this deployment
      // (path prefix, non-Stalwart URL layout). Resolve the session's
      // advertised apiUrl on the same host and retry once.
      const session = await fetchJmapSession(creds.serverUrl, creds.authHeader, fetchOptions);
      const apiUrl = rebaseApiUrl(session, creds.serverUrl);
      if (apiUrl && apiUrl !== directUrl) {
        response = await postJmap(apiUrl, creds.authHeader, body, fetchOptions);
      }
    }

    if (!response.ok) {
      logger.warn('Stalwart JMAP passthrough upstream error', {
        status: response.status,
        serverUrl: creds.serverUrl,
      });
    }

    const responseText = await response.text();
    return new NextResponse(responseText, {
      status: response.status,
      headers: { 'Content-Type': response.headers.get('Content-Type') || 'application/json' },
    });
  } catch (error) {
    if (error instanceof JmapRedirectError) {
      logger.error('Stalwart JMAP passthrough redirect error', { error: error.message });
      return NextResponse.json({ error: error.message }, { status: 502 });
    }
    if (error instanceof DisallowedUrlError) {
      logger.warn('Stalwart JMAP passthrough refused non-public server address', { error: error.message });
      return NextResponse.json({ error: 'JMAP server address is not allowed' }, { status: 502 });
    }
    // `fetch failed` from undici is too generic to debug — the real reason
    // (ENOTFOUND, ECONNREFUSED, self-signed TLS, …) lives on `error.cause`.
    const err = error as Error & { cause?: { code?: string; message?: string } };
    logger.error('Stalwart JMAP passthrough error', {
      error: err?.message ?? 'Unknown',
      causeCode: err?.cause?.code,
      causeMessage: err?.cause?.message,
    });
    // The server this process failed to reach is the user's own mail server,
    // so the reason is worth surfacing: an opaque 500 leaves operators with
    // nothing to act on.
    if (err?.cause?.code) {
      return NextResponse.json(
        { error: `Cannot reach the JMAP server (${err.cause.code})` },
        { status: 502 },
      );
    }
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
