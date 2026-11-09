import { NextRequest, NextResponse } from 'next/server';
import { requireAdminAuth } from '@/lib/admin/session';
import { logger } from '@/lib/logger';
import {
  loadState,
  checkOnce,
  effectiveEndpoint,
  freshStatus,
  disabledByEnv,
  DEFAULT_VERSION_ENDPOINT,
} from '@/lib/version-check';
import { isNoThirdPartyTrafficOn } from '@/lib/admin/third-party-mode';
import { storedDataUnavailableResponse } from '@/lib/stored-data-errors';

/**
 * GET /api/admin/version
 * Returns the cached update status, last check times, and effective config.
 */
export async function GET(request: NextRequest) {
  try {
    const auth = await requireAdminAuth(request);
    if ('error' in auth) return auth.error;

    const state = await loadState();
    return NextResponse.json(
      {
        current: process.env.NEXT_PUBLIC_APP_VERSION || '0.0.0',
        build: process.env.NEXT_PUBLIC_GIT_COMMIT || 'unknown',
        endpoint: effectiveEndpoint(state),
        defaultEndpoint: DEFAULT_VERSION_ENDPOINT,
        disabledByEnv: disabledByEnv(),
        disabledByNoThirdPartyTraffic: await isNoThirdPartyTrafficOn(),
        lastCheckedAt: state.lastCheckedAt,
        lastSuccessAt: state.lastSuccessAt,
        nextScheduledAt: state.nextScheduledAt,
        status: freshStatus(state),
      },
      { headers: { 'Cache-Control': 'no-store' } },
    );
  } catch (err) {
    logger.error('version admin GET error', {
      error: err instanceof Error ? err.message : 'unknown',
    });
    const unavailable = storedDataUnavailableResponse(err, { 'Cache-Control': 'no-store' });
    if (unavailable) return unavailable;
    return NextResponse.json({ error: 'failed' }, { status: 500 });
  }
}

/**
 * POST /api/admin/version
 * { action: 'check-now' } - force a fresh upstream fetch.
 */
export async function POST(req: NextRequest) {
  try {
    const auth = await requireAdminAuth(req);
    if ('error' in auth) return auth.error;

    const body = (await req.json().catch(() => null)) as { action?: string } | null;
    if (!body || body.action !== 'check-now') {
      return NextResponse.json({ error: 'unknown action' }, { status: 400 });
    }

    const result = await checkOnce({ reason: 'admin-trigger' });
    return NextResponse.json(result);
  } catch (err) {
    logger.error('version admin POST error', {
      error: err instanceof Error ? err.message : 'unknown',
    });
    const unavailable = storedDataUnavailableResponse(err, { 'Cache-Control': 'no-store' });
    if (unavailable) return unavailable;
    return NextResponse.json({ error: 'failed' }, { status: 500 });
  }
}
