import { NextRequest, NextResponse } from 'next/server';
import { requireAdminAuth, getClientIP } from '@/lib/admin/session';
import { auditLog } from '@/lib/admin/audit';
import { logger } from '@/lib/logger';
import {
  effectiveConsent,
  loadState,
  saveState,
  buildPayload,
  sendOnce,
  reschedule,
  DEFAULT_ENDPOINT,
} from '@/lib/telemetry';

/**
 * GET /api/admin/telemetry
 * Returns current consent + endpoint + next/last send + a live preview
 * of exactly what the next heartbeat would contain.
 */
export async function GET() {
  try {
    const auth = await requireAdminAuth();
    if ('error' in auth) return auth.error;

    const { consent, source, state } = await effectiveConsent();
    const payload = await buildPayload();

    return NextResponse.json(
      {
        consent,
        consentSource: source,
        endpoint: state.endpoint || DEFAULT_ENDPOINT,
        consentedAt: state.consentedAt,
        lastSentAt: state.lastSentAt,
        nextScheduledAt: state.nextScheduledAt,
        defaultEndpoint: DEFAULT_ENDPOINT,
        payloadPreview: payload,
      },
      { headers: { 'Cache-Control': 'no-store' } },
    );
  } catch (err) {
    logger.error('telemetry GET error', {
      error: err instanceof Error ? err.message : 'unknown',
    });
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}

/**
 * POST /api/admin/telemetry
 * Body: { action: 'set-consent' | 'set-endpoint' | 'send-now', ... }
 *   set-consent  : { action, consent: 'on' | 'off' }
 *   set-endpoint : { action, endpoint: string }
 *   send-now     : { action }
 */
export async function POST(request: NextRequest) {
  try {
    const auth = await requireAdminAuth();
    if ('error' in auth) return auth.error;
    const ip = getClientIP(request);

    const body = (await request.json().catch(() => null)) as
      | { action?: string; consent?: string; endpoint?: string }
      | null;
    if (!body || typeof body.action !== 'string') {
      return NextResponse.json({ error: 'action required' }, { status: 400 });
    }

    const { source } = await effectiveConsent();

    if (body.action === 'set-consent') {
      if (source === 'env') {
        return NextResponse.json(
          { error: 'consent is overridden by BULWARK_TELEMETRY env var' },
          { status: 409 },
        );
      }
      if (body.consent !== 'on' && body.consent !== 'off') {
        return NextResponse.json({ error: 'consent must be "on" or "off"' }, { status: 400 });
      }
      const state = await loadState();
      const before = state.consent;
      state.consent = body.consent;
      if (body.consent === 'on' && !state.consentedAt) {
        state.consentedAt = new Date().toISOString();
      }
      await saveState(state);
      await reschedule();
      await auditLog('telemetry.set-consent', { from: before, to: body.consent }, ip);
      return NextResponse.json({ ok: true });
    }

    if (body.action === 'set-endpoint') {
      if (typeof body.endpoint !== 'string') {
        return NextResponse.json({ error: 'endpoint required' }, { status: 400 });
      }
      const trimmed = body.endpoint.trim();
      if (trimmed && !/^https?:\/\//i.test(trimmed)) {
        return NextResponse.json({ error: 'endpoint must be http(s)://' }, { status: 400 });
      }
      const state = await loadState();
      const before = state.endpoint;
      state.endpoint = trimmed || DEFAULT_ENDPOINT;
      await saveState(state);
      await auditLog('telemetry.set-endpoint', { from: before, to: state.endpoint }, ip);
      return NextResponse.json({ ok: true, endpoint: state.endpoint });
    }

    if (body.action === 'send-now') {
      const result = await sendOnce({ reason: 'admin-manual' });
      await auditLog(
        'telemetry.send-now',
        { ok: result.ok, status: result.status ?? null, error: result.error ?? null },
        ip,
      );
      return NextResponse.json(result, { status: result.ok ? 200 : 502 });
    }

    return NextResponse.json({ error: 'unknown action' }, { status: 400 });
  } catch (err) {
    logger.error('telemetry POST error', {
      error: err instanceof Error ? err.message : 'unknown',
    });
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
