import { NextRequest, NextResponse } from 'next/server';
import { rejectCrossOriginRequest } from '@/lib/security/same-origin';
import { logger } from '@/lib/logger';
import { getStalwartCredentials } from '@/lib/stalwart/credentials';
import { fetchJmapServer } from '@/lib/stalwart/server-fetch';
import { DisallowedUrlError } from '@/lib/security/url-guard';

const ALLOWED_METHODS = new Set(['PROPFIND', 'MKCOL', 'MKCALENDAR', 'GET', 'PUT', 'DELETE', 'MOVE', 'COPY']);

// Stalwart DAV roots the proxy may address: `file` is the user's file storage,
// `cal` their calendar collections (needed for MKCALENDAR, which is the only
// way to pin a calendar's supported-calendar-component-set - #760).
const ALLOWED_COLLECTIONS = new Set(['file', 'cal']);

function normalizeDavRelativePath(rawPath: string): string {
  const sanitized = rawPath.replace(/\\/g, '/').split(/[?#]/, 1)[0] ?? '';
  const segments = sanitized.split('/').filter(Boolean);

  return segments.map((segment) => {
    let decoded: string;
    try {
      decoded = decodeURIComponent(segment);
    } catch {
      throw new Error('Invalid WebDAV path encoding');
    }

    if (decoded === '.' || decoded === '..' || decoded.includes('/') || decoded.includes('\\') || decoded.includes('\0')) {
      throw new Error('Invalid WebDAV path segment');
    }

    return encodeURIComponent(decoded);
  }).join('/');
}

function buildDavTargetUrl(baseUrl: string, username: string, rawPath: string, collection: string = 'file'): string {
  const rootUrl = new URL(`${baseUrl.replace(/\/$/, '')}/dav/${collection}/${encodeURIComponent(username)}/`);
  const relativePath = normalizeDavRelativePath(rawPath);
  return relativePath ? new URL(relativePath, rootUrl).toString() : rootUrl.toString();
}

/**
 * POST /api/webdav
 * Proxies WebDAV requests to the Stalwart server.
 *
 * Headers:
 *   X-WebDAV-Method: The actual WebDAV method (PROPFIND, MKCOL, MKCALENDAR, GET, PUT, DELETE, MOVE, COPY)
 *   X-WebDAV-Collection: Which DAV root to address - `file` (default) or `cal`
 *   X-WebDAV-Path: Resource path relative to the user's DAV root (default: /)
 *   X-WebDAV-Destination: Destination path for MOVE/COPY (relative to user's DAV root)
 *   Depth: WebDAV Depth header (forwarded as-is)
 *   Content-Type: Forwarded for PROPFIND (XML) and PUT (file upload)
 *   Overwrite: WebDAV Overwrite header for MOVE/COPY
 */
export async function POST(request: NextRequest) {
  // CSRF gate (GHSA-9mvj-98f5-9q6g): this handler acts with the caller's
  // session cookie, which SameSite=Lax still sends from a same-site page.
  const crossOrigin = rejectCrossOriginRequest(request);
  if (crossOrigin) return crossOrigin;
  try {
    const creds = await getStalwartCredentials(request);
    if (!creds) {
      return NextResponse.json({ error: 'Not authenticated' }, { status: 401 });
    }

    const method = request.headers.get('X-WebDAV-Method')?.toUpperCase();
    if (!method || !ALLOWED_METHODS.has(method)) {
      return NextResponse.json({ error: 'Invalid WebDAV method' }, { status: 400 });
    }

    const collection = (request.headers.get('X-WebDAV-Collection') || 'file').toLowerCase();
    if (!ALLOWED_COLLECTIONS.has(collection)) {
      return NextResponse.json({ error: 'Invalid WebDAV collection' }, { status: 400 });
    }

    const davPath = request.headers.get('X-WebDAV-Path') || '/';
    const baseUrl = creds.serverUrl.replace(/\/$/, '');
    const targetUrl = buildDavTargetUrl(baseUrl, creds.username, davPath, collection);

    // Build headers for the upstream request
    const upstreamHeaders: Record<string, string> = {
      'Authorization': creds.authHeader,
    };

    // Forward relevant WebDAV headers
    const depth = request.headers.get('Depth');
    if (depth) upstreamHeaders['Depth'] = depth;

    const contentType = request.headers.get('Content-Type');
    if (contentType) upstreamHeaders['Content-Type'] = contentType;

    // For MOVE/COPY, construct the full Destination URL from the relative path
    const destination = request.headers.get('X-WebDAV-Destination');
    if (destination) {
      upstreamHeaders['Destination'] = buildDavTargetUrl(baseUrl, creds.username, destination, collection);
    }

    const overwrite = request.headers.get('Overwrite');
    if (overwrite) upstreamHeaders['Overwrite'] = overwrite;

    // Forward request body for methods that need it.
    // PUT streams directly to upstream to avoid buffering large uploads in memory.
    // PROPFIND and MKCALENDAR bodies are small XML and are read fully.
    let body: ArrayBuffer | ReadableStream<Uint8Array> | null = null;
    if (method === 'PROPFIND' || method === 'MKCALENDAR') {
      body = await request.arrayBuffer();
    } else if (method === 'PUT') {
      body = request.body;
    }

    // A user-chosen server (allowCustomJmapEndpoint) goes through the
    // rebinding-safe fetch; see lib/stalwart/server-fetch.ts.
    const response = await fetchJmapServer(targetUrl, {
      method,
      headers: upstreamHeaders,
      body,
      redirect: 'follow',
      // `duplex: 'half'` is required by undici when sending a streaming request body.
      ...(method === 'PUT' ? { duplex: 'half' } : {}),
    }, creds.trusted);

    // For file downloads (GET), stream the response back
    if (method === 'GET') {
      const headers = new Headers();
      headers.set('Content-Type', response.headers.get('Content-Type') || 'application/octet-stream');
      const contentLength = response.headers.get('Content-Length');
      if (contentLength) headers.set('Content-Length', contentLength);
      headers.set('X-WebDAV-Request-URI', targetUrl);

      return new NextResponse(response.body, {
        status: response.status,
        headers,
      });
    }

    // For PROPFIND, return XML with the actual request URI for href comparison
    if (method === 'PROPFIND') {
      const text = await response.text();
      const headers = new Headers();
      headers.set('Content-Type', 'application/xml; charset=utf-8');
      headers.set('X-WebDAV-Request-URI', targetUrl);

      return new NextResponse(text, {
        status: response.status,
        headers,
      });
    }

    // For other methods (MKCOL, MKCALENDAR, DELETE, MOVE, COPY, PUT), return the status
    return new NextResponse(null, {
      status: response.status,
    });
  } catch (error) {
    if (error instanceof Error && error.message.startsWith('Invalid WebDAV path')) {
      return NextResponse.json({ error: error.message }, { status: 400 });
    }
    if (error instanceof DisallowedUrlError) {
      logger.warn('WebDAV proxy refused non-public server address', { error: error.message });
      return NextResponse.json({ error: 'JMAP server address is not allowed' }, { status: 502 });
    }

    logger.error('WebDAV proxy error', { error: error instanceof Error ? error.message : 'Unknown' });
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
