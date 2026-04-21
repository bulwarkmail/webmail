import { NextRequest, NextResponse } from 'next/server';
import { logger } from '@/lib/logger';
import { getStalwartCredentials } from '@/lib/stalwart/credentials';

const ALLOWED_METHODS = new Set(['PROPFIND', 'MKCOL', 'GET', 'PUT', 'DELETE', 'MOVE', 'COPY']);

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

function buildDavTargetUrl(baseUrl: string, username: string, rawPath: string): string {
  const rootUrl = new URL(`${baseUrl.replace(/\/$/, '')}/dav/file/${encodeURIComponent(username)}/`);
  const relativePath = normalizeDavRelativePath(rawPath);
  return relativePath ? new URL(relativePath, rootUrl).toString() : rootUrl.toString();
}

/**
 * POST /api/webdav
 * Proxies WebDAV requests to the Stalwart server.
 *
 * Headers:
 *   X-WebDAV-Method: The actual WebDAV method (PROPFIND, MKCOL, GET, PUT, DELETE, MOVE, COPY)
 *   X-WebDAV-Path: Resource path relative to the user's DAV root (default: /)
 *   X-WebDAV-Destination: Destination path for MOVE/COPY (relative to user's DAV root)
 *   Depth: WebDAV Depth header (forwarded as-is)
 *   Content-Type: Forwarded for PROPFIND (XML) and PUT (file upload)
 *   Overwrite: WebDAV Overwrite header for MOVE/COPY
 */
export async function POST(request: NextRequest) {
  try {
    const creds = await getStalwartCredentials(request);
    if (!creds) {
      return NextResponse.json({ error: 'Not authenticated' }, { status: 401 });
    }

    const method = request.headers.get('X-WebDAV-Method')?.toUpperCase();
    if (!method || !ALLOWED_METHODS.has(method)) {
      return NextResponse.json({ error: 'Invalid WebDAV method' }, { status: 400 });
    }

    const davPath = request.headers.get('X-WebDAV-Path') || '/';
    const baseUrl = creds.serverUrl.replace(/\/$/, '');
    const targetUrl = buildDavTargetUrl(baseUrl, creds.username, davPath);

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
      upstreamHeaders['Destination'] = buildDavTargetUrl(baseUrl, creds.username, destination);
    }

    const overwrite = request.headers.get('Overwrite');
    if (overwrite) upstreamHeaders['Overwrite'] = overwrite;

    // Forward request body for methods that need it.
    // PUT streams directly to upstream to avoid buffering large uploads in memory.
    // PROPFIND bodies are small XML and are read fully.
    let body: ArrayBuffer | ReadableStream<Uint8Array> | null = null;
    if (method === 'PROPFIND') {
      body = await request.arrayBuffer();
    } else if (method === 'PUT') {
      body = request.body;
    }

    const response = await fetch(targetUrl, {
      method,
      headers: upstreamHeaders,
      body,
      redirect: 'follow',
      // `duplex: 'half'` is required by undici when sending a streaming request body.
      ...(method === 'PUT' ? { duplex: 'half' } : {}),
    } as Parameters<typeof fetch>[1] & { duplex?: 'half' });

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

    // For other methods (MKCOL, DELETE, MOVE, COPY, PUT), return the status
    return new NextResponse(null, {
      status: response.status,
    });
  } catch (error) {
    if (error instanceof Error && error.message.startsWith('Invalid WebDAV path')) {
      return NextResponse.json({ error: error.message }, { status: 400 });
    }

    logger.error('WebDAV proxy error', { error: error instanceof Error ? error.message : 'Unknown' });
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
