import { NextRequest, NextResponse } from 'next/server';
import { requireAdminAuth } from '@/lib/admin/session';
import { logger } from '@/lib/logger';
import { readErrors, summarizeDay, utcDay } from '@/lib/error-reporting/aggregate';
import { shouldCollectErrors } from '@/lib/error-reporting/settings';
import { storedDataUnavailableResponse } from '@/lib/stored-data-errors';
import { metricsEnabled } from '@/lib/metrics';
import { isTracingActive, tracingEndpoint } from '@/lib/tracing/config';

export const dynamic = 'force-dynamic';

/**
 * GET /api/admin/monitoring: what System > Monitoring shows besides the
 * config keys (those come from /api/admin/config): whether errors are being
 * counted, today's counts, and whether metrics and tracing are on.
 */
export async function GET(request: NextRequest) {
  try {
    const auth = await requireAdminAuth(request);
    if ('error' in auth) return auth.error;

    const collecting = await shouldCollectErrors();
    const today = utcDay();
    const errorsToday = summarizeDay(await readErrors(), today);
    const metrics = { enabled: metricsEnabled() };
    const endpoint = tracingEndpoint();
    let endpointHost: string | null = null;
    try { endpointHost = endpoint ? new URL(endpoint).host : null; } catch { endpointHost = null; }
    const tracing = { configured: endpoint !== null, active: isTracingActive(), endpointHost };
    return NextResponse.json({ collecting, day: today, errorsToday, metrics, tracing }, { headers: { 'Cache-Control': 'no-store' } });
  } catch (err) {
    logger.error('monitoring GET error', { error: err instanceof Error ? err.message : 'unknown' });
    const unavailable = storedDataUnavailableResponse(err);
    if (unavailable) return unavailable;
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
