import { NextRequest, NextResponse } from 'next/server';
import { rejectCrossOriginRequest } from '@/lib/security/same-origin';
import { logger } from '@/lib/logger';
import { getStalwartCredentials } from '@/lib/stalwart/credentials';
import { fetchJmapServer } from '@/lib/stalwart/server-fetch';

interface DiscoveryAccountRequest {
  key: string;
  candidates: string[];
}

interface DiscoveryResult {
  url: string | null;
  resolvedAccount: string | null;
}

function buildPublicUrl(serverUrl: string, path: string): string {
  return new URL(path, serverUrl).toString();
}

async function probeCalendarHome(
  serverUrl: string,
  authHeader: string,
  accountName: string,
  trusted: boolean,
): Promise<string | null> {
  const targetUrl = buildPublicUrl(serverUrl, `/dav/cal/${encodeURIComponent(accountName)}`);
  const response = await fetchJmapServer(targetUrl, {
    method: 'PROPFIND',
    headers: {
      Authorization: authHeader,
      Depth: '0',
      'Content-Type': 'application/xml; charset=utf-8',
    },
    body: `<?xml version="1.0" encoding="utf-8"?>
<D:propfind xmlns:D="DAV:">
  <D:prop>
    <D:resourcetype/>
    <D:displayname/>
  </D:prop>
</D:propfind>`,
    redirect: 'manual',
  }, trusted);

  if (response.status === 207) {
    return targetUrl;
  }

  if (response.status >= 300 && response.status < 400) {
    const location = response.headers.get('Location');
    if (location) {
      return new URL(location, targetUrl).toString();
    }
  }

  return null;
}

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

    const body = await request.json().catch(() => ({}));
    const accounts = Array.isArray(body.accounts) ? body.accounts as DiscoveryAccountRequest[] : [];
    const wellKnownUrl = buildPublicUrl(creds.serverUrl, '/.well-known/caldav');
    const discovered: Record<string, DiscoveryResult> = {};

    for (const account of accounts) {
      if (!account?.key) continue;

      const candidates = Array.from(new Set(
        (account.candidates || [])
          .map((candidate) => candidate?.trim())
          .filter((candidate): candidate is string => Boolean(candidate))
      ));

      let url: string | null = null;
      let resolvedAccount: string | null = null;

      for (const candidate of candidates) {
        try {
          url = await probeCalendarHome(creds.serverUrl, creds.authHeader, candidate, creds.trusted);
          if (url) {
            resolvedAccount = candidate;
            break;
          }
        } catch (error) {
          logger.warn('CalDAV discovery probe failed', {
            accountKey: account.key,
            candidate,
            error: error instanceof Error ? error.message : 'Unknown',
          });
        }
      }

      discovered[account.key] = { url, resolvedAccount };
    }

    return NextResponse.json({
      wellKnownUrl,
      accounts: discovered,
    });
  } catch (error) {
    logger.error('CalDAV discovery failed', { error: error instanceof Error ? error.message : 'Unknown' });
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}