import { NextRequest, NextResponse } from 'next/server';
import { cookies } from 'next/headers';
import { logger } from '@/lib/logger';
import { encryptSession, decryptSession } from '@/lib/auth/crypto';
import { SESSION_COOKIE_MAX_AGE, sessionCookieName } from '@/lib/auth/session-cookie';
import { getCookieOptions } from '@/lib/oauth/cookie-config';
import { JmapAuthVerificationError, verifyJmapAuth } from '@/lib/auth/verify-jmap-auth';
import {
  clearStalwartAuthContextInStore,
  setStalwartAuthContextInStore,
} from '@/lib/stalwart/auth-context';
import { configManager } from '@/lib/admin/config-manager';
import { isPublicHttpUrl } from '@/lib/security/url-guard';
import { recordLogin } from '@/lib/telemetry/login-tracker';

const COOKIE_OPTIONS = {
  ...getCookieOptions(),
  maxAge: SESSION_COOKIE_MAX_AGE,
};

function getSlot(request: NextRequest): number {
  const raw = request.nextUrl.searchParams.get('slot');
  if (raw === null) return 0;
  const slot = parseInt(raw, 10);
  if (isNaN(slot) || slot < 0 || slot > 4) return 0;
  return slot;
}

export async function POST(request: NextRequest) {
  try {
    const oauthEnabled = configManager.get<boolean>('oauthEnabled', false);
    const oauthOnly = configManager.get<boolean>('oauthOnly', false);
    if (oauthEnabled && oauthOnly) {
      return NextResponse.json({ error: 'Basic authentication is disabled' }, { status: 403 });
    }

    const { serverUrl, username, password, slot: bodySlot } = await request.json();
    if (!serverUrl || !username || !password) {
      return NextResponse.json({ error: 'Missing required fields' }, { status: 400 });
    }

    // Pin the upstream URL to the configured JMAP server so an unauthenticated
    // caller cannot point this route at internal hosts. Only when no server URL
    // is configured AND the deployment explicitly allows custom JMAP endpoints
    // do we honor the body URL — and even then it must be a public URL.
    await configManager.ensureLoaded();
    const configuredServerUrl =
      configManager.get<string>('jmapServerUrl', '') ||
      process.env.JMAP_SERVER_URL ||
      process.env.NEXT_PUBLIC_JMAP_SERVER_URL ||
      '';
    const allowCustomEndpoint = configManager.get<boolean>('allowCustomJmapEndpoint', false);

    let upstreamUrl: string;
    let upstreamTrusted: boolean;
    if (configuredServerUrl) {
      upstreamUrl = configuredServerUrl;
      upstreamTrusted = true;
    } else if (allowCustomEndpoint) {
      if (!(await isPublicHttpUrl(serverUrl))) {
        return NextResponse.json({ error: 'Server URL is not allowed' }, { status: 400 });
      }
      upstreamUrl = serverUrl;
      upstreamTrusted = false;
    } else {
      return NextResponse.json({ error: 'JMAP server not configured' }, { status: 500 });
    }

    const slot = typeof bodySlot === 'number' && bodySlot >= 0 && bodySlot <= 4 ? bodySlot : getSlot(request);
    const cookieName = sessionCookieName(slot);
    const authHeader = `Basic ${Buffer.from(`${username}:${password}`).toString('base64')}`;
    const normalizedServerUrl = await verifyJmapAuth(upstreamUrl, authHeader, { trusted: upstreamTrusted });
    const token = encryptSession(normalizedServerUrl, username, password);
    const cookieStore = await cookies();
    cookieStore.set(cookieName, token, COOKIE_OPTIONS);
    setStalwartAuthContextInStore(cookieStore, slot, {
      serverUrl: normalizedServerUrl,
      username,
      authHeader,
    });

    void recordLogin(username, normalizedServerUrl);

    return NextResponse.json({ ok: true });
  } catch (error) {
    if (error instanceof JmapAuthVerificationError) {
      return NextResponse.json({ error: error.message }, { status: error.status });
    }

    logger.error('Session store error', { error: error instanceof Error ? error.message : 'Unknown error' });
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}

export async function GET(request: NextRequest) {
  try {
    const slot = getSlot(request);
    const cookieName = sessionCookieName(slot);
    const cookieStore = await cookies();
    const token = cookieStore.get(cookieName)?.value;

    if (!token) {
      return NextResponse.json({ error: 'No session' }, { status: 401 });
    }

    const credentials = decryptSession(token);
    if (!credentials) {
      cookieStore.delete(cookieName);
      clearStalwartAuthContextInStore(cookieStore, slot);
      return NextResponse.json({ error: 'Invalid session' }, { status: 401 });
    }

    setStalwartAuthContextInStore(cookieStore, slot, {
      serverUrl: credentials.serverUrl,
      username: credentials.username,
      authHeader: `Basic ${Buffer.from(`${credentials.username}:${credentials.password}`).toString('base64')}`,
    });

    // Only return non-sensitive fields. Use PUT to retrieve full credentials.
    const { serverUrl, username } = credentials;
    return NextResponse.json(
      { serverUrl, username },
      { headers: { 'Cache-Control': 'no-store, no-cache, must-revalidate' } },
    );
  } catch (error) {
    logger.error('Session read error', { error: error instanceof Error ? error.message : 'Unknown error' });
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}

/**
 * PUT - retrieve full credentials (including password) for session restoration.
 * Protected by multiple Sec-Fetch-* headers to ensure only same-origin
 * browser fetch() requests succeed. Non-browser clients cannot forge these.
 */
export async function PUT(request: NextRequest) {
  try {
    // Require all Sec-Fetch-* headers to match a same-origin fetch() call.
    // Browsers set these automatically and they cannot be overridden by JS.
    const secFetchSite = request.headers.get('sec-fetch-site');
    const secFetchMode = request.headers.get('sec-fetch-mode');
    const secFetchDest = request.headers.get('sec-fetch-dest');
    if (secFetchSite !== 'same-origin' || secFetchMode !== 'cors' || secFetchDest !== 'empty') {
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
    }

    const slot = getSlot(request);
    const cookieName = sessionCookieName(slot);
    const cookieStore = await cookies();
    const token = cookieStore.get(cookieName)?.value;

    if (!token) {
      return NextResponse.json({ error: 'No session' }, { status: 401 });
    }

    const credentials = decryptSession(token);
    if (!credentials) {
      cookieStore.delete(cookieName);
      clearStalwartAuthContextInStore(cookieStore, slot);
      return NextResponse.json({ error: 'Invalid session' }, { status: 401 });
    }

    setStalwartAuthContextInStore(cookieStore, slot, {
      serverUrl: credentials.serverUrl,
      username: credentials.username,
      authHeader: `Basic ${Buffer.from(`${credentials.username}:${credentials.password}`).toString('base64')}`,
    });

    return NextResponse.json(credentials, {
      headers: { 'Cache-Control': 'no-store, no-cache, must-revalidate' },
    });
  } catch (error) {
    logger.error('Session read error', { error: error instanceof Error ? error.message : 'Unknown error' });
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}

export async function DELETE(request: NextRequest) {
  try {
    const cookieStore = await cookies();
    const all = request.nextUrl.searchParams.get('all') === 'true';

    if (all) {
      // Delete all session cookies (slots 0-4)
      for (let i = 0; i <= 4; i++) {
        cookieStore.delete(sessionCookieName(i));
        clearStalwartAuthContextInStore(cookieStore, i);
      }
    } else {
      const slot = getSlot(request);
      cookieStore.delete(sessionCookieName(slot));
      clearStalwartAuthContextInStore(cookieStore, slot);
    }

    return NextResponse.json({ ok: true });
  } catch (error) {
    logger.error('Session clear error', { error: error instanceof Error ? error.message : 'Unknown error' });
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
