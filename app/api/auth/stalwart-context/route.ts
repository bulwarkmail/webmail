import { NextRequest, NextResponse } from 'next/server';
import { logger } from '@/lib/logger';
import { JmapAuthVerificationError, verifyJmapAuth } from '@/lib/auth/verify-jmap-auth';
import { setStalwartAuthContext } from '@/lib/stalwart/auth-context';
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

    const slot = getSlot(request, bodySlot);
    const normalizedServerUrl = await verifyJmapAuth(serverUrl, authHeader);

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