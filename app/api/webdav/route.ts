import { NextRequest, NextResponse } from 'next/server';
import { logger } from '@/lib/logger';
import { getStalwartCredentials } from '@/lib/stalwart/credentials';

const ALLOWED_METHODS = new Set(['PROPFIND', 'MKCOL', 'GET', 'PUT', 'DELETE', 'MOVE', 'COPY']);

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
    const cleanPath = davPath.replace(/^\/+/, '');
    const baseUrl = creds.apiUrl.replace(/\/$/, '');
    const targetUrl = cleanPath
      ? `${baseUrl}/dav/file/${encodeURIComponent(creds.username)}/${cleanPath}`
      : `${baseUrl}/dav/file/${encodeURIComponent(creds.username)}/`;

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
      const cleanDest = destination.replace(/^\/+/, '');
      upstreamHeaders['Destination'] = cleanDest
        ? `${baseUrl}/dav/file/${encodeURIComponent(creds.username)}/${cleanDest}`
        : `${baseUrl}/dav/file/${encodeURIComponent(creds.username)}/`;
    }

    const overwrite = request.headers.get('Overwrite');
    if (overwrite) upstreamHeaders['Overwrite'] = overwrite;

    // Forward request body for methods that need it
    let body: ArrayBuffer | null = null;
    if (method === 'PROPFIND' || method === 'PUT') {
      body = await request.arrayBuffer();
    }

    const response = await fetch(targetUrl, {
      method,
      headers: upstreamHeaders,
      body,
      redirect: 'follow',
    });

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
    logger.error('WebDAV proxy error', { error: error instanceof Error ? error.message : 'Unknown' });
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
