import { NextRequest, NextResponse } from 'next/server';
import { logger } from '@/lib/logger';
import { JmapAuthVerificationError, verifyJmapAuth } from '@/lib/auth/verify-jmap-auth';
import { setStalwartAuthContext } from '@/lib/stalwart/auth-context';
import { configManager } from '@/lib/admin/config-manager';
import { isPublicHttpUrl } from '@/lib/security/url-guard';
import { recordLogin } from '@/lib/telemetry/login-tracker';

function getSlot(request: NextRequest, bodySlot: unknown): number {
  if (typeof bodySlot === 'number' && bodySlot >= 0 && bodySlot <= 4) {
    return bodySlot;
  }

  const raw = request.nextUrl.searchParams.get('slot');
  if (raw === null) return 0;

  const slot = parseInt(raw, 10);
  return Number.isNaN(slot) || slot < 0 || slot > 4 ? 0 : slot;
}

export async function POST(request: NextRequest) {
  try {
    const { serverUrl, username, authHeader, slot: bodySlot } = await request.json();

    if (!serverUrl || !username || !authHeader) {
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

    const slot = getSlot(request, bodySlot);
    const normalizedServerUrl = await verifyJmapAuth(upstreamUrl, authHeader, { trusted: upstreamTrusted });

    await setStalwartAuthContext(slot, {
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

    logger.error('Failed to store Stalwart auth context', {
      error: error instanceof Error ? error.message : 'Unknown error',
    });
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}