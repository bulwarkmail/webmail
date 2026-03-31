import { NextRequest, NextResponse } from 'next/server';

const MAX_RESPONSE_SIZE = 10 * 1024 * 1024; // 10MB
const FETCH_TIMEOUT_MS = 15000;

function isValidExternalUrl(urlString: string): boolean {
  let url: URL;
  try {
    url = new URL(urlString);
  } catch {
    return false;
  }

  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    return false;
  }

  const hostname = url.hostname.toLowerCase();

  // Block private/internal hostnames
  if (
    hostname === 'localhost' ||
    hostname === '127.0.0.1' ||
    hostname === '::1' ||
    hostname === '0.0.0.0' ||
    hostname.endsWith('.local') ||
    hostname.endsWith('.internal') ||
    hostname.endsWith('.arpa') ||
    hostname.startsWith('10.') ||
    hostname.startsWith('192.168.') ||
    hostname.startsWith('169.254.') ||
    /^172\.(1[6-9]|2\d|3[01])\./.test(hostname)
  ) {
    return false;
  }

  // Block URLs with credentials
  if (url.username || url.password) {
    return false;
  }

  return true;
}

export async function POST(request: NextRequest) {
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

  if (!isValidExternalUrl(url)) {
    return NextResponse.json({ error: 'Invalid or disallowed URL' }, { status: 400 });
  }

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

    const MAX_REDIRECTS = 5;
    let currentUrl = url;
    let response: Response | undefined;

    for (let i = 0; i <= MAX_REDIRECTS; i++) {
      if (!isValidExternalUrl(currentUrl)) {
        clearTimeout(timeout);
        return NextResponse.json({ error: 'Redirect to disallowed URL' }, { status: 400 });
      }

      response = await fetch(currentUrl, {
        signal: controller.signal,
        headers: {
          'Accept': 'text/calendar, application/ics, text/plain, */*',
          'User-Agent': 'JMAP-Webmail/1.0 Calendar-Fetcher',
        },
        redirect: 'manual',
      });

      if (response.status >= 300 && response.status < 400) {
        const location = response.headers.get('location');
        if (!location) {
          clearTimeout(timeout);
          return NextResponse.json({ error: 'Redirect without Location header' }, { status: 502 });
        }
        // Resolve relative redirects
        currentUrl = new URL(location, currentUrl).toString();
        continue;
      }
      break;
    }

    clearTimeout(timeout);

    if (!response || !response.ok) {
      return NextResponse.json(
        { error: `Remote server returned ${response?.status ?? 'unknown'}` },
        { status: 502 }
      );
    }

    const contentLength = response.headers.get('content-length');
    if (contentLength && parseInt(contentLength) > MAX_RESPONSE_SIZE) {
      return NextResponse.json({ error: 'File too large' }, { status: 413 });
    }

    const buffer = await response.arrayBuffer();
    if (buffer.byteLength > MAX_RESPONSE_SIZE) {
      return NextResponse.json({ error: 'File too large' }, { status: 413 });
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
  }
}
