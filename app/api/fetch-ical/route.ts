import { NextRequest, NextResponse } from 'next/server';
import { rejectCrossOriginRequest } from '@/lib/security/same-origin';
import { getStalwartCredentials } from '@/lib/stalwart/credentials';
import { DisallowedUrlError, fetchPublicUrl, type PublicFetchResponse } from '@/lib/security/url-guard';

const DEFAULT_MAX_BYTES = 25 * 1024 * 1024; // 25MB
// Base budget for a default-sized feed; scaled up with the configured cap so a
// larger allowed body is not cut off by the timer that fit the smaller one.
const BASE_TIMEOUT_MS = 15000;

/** Response cap from ICAL_MAX_BYTES (bytes), read per request so a deploy can raise it. (#692) */
function getMaxResponseSize(): number {
  const raw = process.env.ICAL_MAX_BYTES;
  const parsed = raw ? parseInt(raw, 10) : NaN;
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_MAX_BYTES;
}

function getFetchTimeoutMs(maxBytes: number): number {
  return Math.max(BASE_TIMEOUT_MS, Math.ceil(BASE_TIMEOUT_MS * (maxBytes / DEFAULT_MAX_BYTES)));
}

function tooLarge(maxBytes: number) {
  const limitMb = Math.round((maxBytes / (1024 * 1024)) * 10) / 10;
  return NextResponse.json(
    { error: `Calendar feed is larger than the ${limitMb} MB limit (ICAL_MAX_BYTES)` },
    { status: 413 },
  );
}

function extractBasicAuth(rawUrl: string): { cleanUrl: string; authHeader: string | null } | null {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    return null;
  }

  let authHeader: string | null = null;
  if (parsed.username || parsed.password) {
    const username = decodeURIComponent(parsed.username);
    const password = decodeURIComponent(parsed.password);
    authHeader = `Basic ${Buffer.from(`${username}:${password}`).toString('base64')}`;
    parsed.username = '';
    parsed.password = '';
  }

  return { cleanUrl: parsed.toString(), authHeader };
}

/**
 * POST /api/fetch-ical
 *
 * Server-side proxy for iCalendar subscription URLs (the browser cannot fetch
 * them directly because of CORS). Only logged-in users may use it, and every
 * hop - including redirect targets - goes through `fetchPublicUrl`, which
 * validates the resolved address inside the socket lookup so a rebinding DNS
 * server cannot steer the connection at an internal host
 * (GHSA-24w9-8r42-8jwm).
 */
export async function POST(request: NextRequest) {
  // CSRF gate (GHSA-9mvj-98f5-9q6g): this handler acts with the caller's
  // session cookie, which SameSite=Lax still sends from a same-site page.
  const crossOrigin = rejectCrossOriginRequest(request);
  if (crossOrigin) return crossOrigin;
  const creds = await getStalwartCredentials(request);
  if (!creds) {
    return NextResponse.json({ error: 'Not authenticated' }, { status: 401 });
  }

  let body: { url?: string };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: 'Invalid request body' }, { status: 400 });
  }

  const { url } = body;

  if (!url || typeof url !== 'string') {
    return NextResponse.json({ error: 'URL is required' }, { status: 400 });
  }

  const extracted = extractBasicAuth(url);
  if (!extracted) {
    return NextResponse.json({ error: 'Invalid or disallowed URL' }, { status: 400 });
  }

  const { cleanUrl, authHeader } = extracted;

  const maxResponseSize = getMaxResponseSize();
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), getFetchTimeoutMs(maxResponseSize));

  try {
    const MAX_REDIRECTS = 5;
    let currentUrl = cleanUrl;
    const originalOrigin = new URL(cleanUrl).origin;
    let response: PublicFetchResponse | undefined;

    for (let i = 0; i <= MAX_REDIRECTS; i++) {
      const headers: Record<string, string> = {
        'Accept': 'text/calendar, application/ics, text/plain, */*',
        'User-Agent': 'JMAP-Webmail/1.0 Calendar-Fetcher',
      };
      if (authHeader && new URL(currentUrl).origin === originalOrigin) {
        headers['Authorization'] = authHeader;
      }

      try {
        response = await fetchPublicUrl(currentUrl, {
          signal: controller.signal,
          headers,
        });
      } catch (error) {
        if (error instanceof DisallowedUrlError) {
          return NextResponse.json(
            { error: i === 0 ? 'Invalid or disallowed URL' : 'Redirect to disallowed URL' },
            { status: 400 },
          );
        }
        throw error;
      }

      if (response.status >= 300 && response.status < 400) {
        const location = response.headers.get('location');
        if (!location) {
          return NextResponse.json({ error: 'Redirect without Location header' }, { status: 502 });
        }
        currentUrl = new URL(location, currentUrl).toString();
        continue;
      }
      break;
    }

    if (!response || !response.ok) {
      return NextResponse.json(
        { error: `Remote server returned ${response?.status ?? 'unknown'}` },
        { status: 502 }
      );
    }

    const contentLength = response.headers.get('content-length');
    if (contentLength && parseInt(contentLength) > maxResponseSize) {
      return tooLarge(maxResponseSize);
    }

    const buffer = await response.arrayBuffer();
    if (buffer.byteLength > maxResponseSize) {
      return tooLarge(maxResponseSize);
    }

    return new NextResponse(buffer, {
      status: 200,
      headers: {
        'Content-Type': 'text/calendar',
        'Content-Length': buffer.byteLength.toString(),
      },
    });
  } catch (error: unknown) {
    if (error instanceof Error && error.name === 'AbortError') {
      return NextResponse.json({ error: 'Request timed out' }, { status: 504 });
    }
    return NextResponse.json({ error: 'Failed to fetch calendar' }, { status: 502 });
  } finally {
    clearTimeout(timeout);
  }
}
