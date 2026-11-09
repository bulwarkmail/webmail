import { NextRequest, NextResponse } from 'next/server';
import { requireAdminAuth, getClientIP } from '@/lib/admin/session';
import { auditLog } from '@/lib/admin/audit';
import { logger } from '@/lib/logger';
import {
  effectiveConsent,
  effectiveErrorsConsent,
  updateState,
  buildPayload,
  sendOnce,
  reschedule,
  DEFAULT_ENDPOINT,
  getLoginCounts,
  resolveEndpointAllowed,
} from '@/lib/telemetry';
import { storedDataUnavailableResponse } from '@/lib/stored-data-errors';
import { errorsForDay, errorsForPayload } from '@/lib/telemetry/payload';
import { readErrors, utcDay } from '@/lib/error-reporting/aggregate';

/**
 * GET /api/admin/telemetry
 * Returns current consent + endpoint + next/last send + a live preview
 * of exactly what the next heartbeat would contain.
 */
export async function GET(request: NextRequest) {
  try {
    const auth = await requireAdminAuth(request);
    if ('error' in auth) return auth.error;

    const { consent, source, state } = await effectiveConsent();
    const [payload, accountCounts, errors, counted] = await Promise.all([
      buildPayload(),
      getLoginCounts(),
      effectiveErrorsConsent(),
      readErrors(),
    ]);

    return NextResponse.json(
      {
        consent,
        consentSource: source,
        // The separate consent to add error counts (schema v2).
        errorsConsent: errors.consent,
        errorsConsentSource: errors.source,
        endpoint: state.endpoint ?? DEFAULT_ENDPOINT,
        consentedAt: state.consentedAt,
        lastSentAt: state.lastSentAt,
        nextScheduledAt: state.nextScheduledAt,
        defaultEndpoint: DEFAULT_ENDPOINT,
        payloadPreview: payload,
        // What `errors` would hold, so the page can show the v2 payload as soon
        // as the switch is flipped, before anything is saved or sent.
        errorsPreview: errorsForPayload(counted),
        // What instant mode would send now: today's counts so far.
        instantErrorsPreview: errorsForDay(counted, utcDay()),
        accountCounts,
      },
      { headers: { 'Cache-Control': 'no-store' } },
    );
  } catch (err) {
    logger.error('telemetry GET error', {
      error: err instanceof Error ? err.message : 'unknown',
    });
    const unavailable = storedDataUnavailableResponse(err);
    if (unavailable) return unavailable;
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}

/**
 * POST /api/admin/telemetry
 * Body: { action: 'set-consent' | 'set-endpoint' | 'send-now', ... }
 *   set-consent  : { action, consent: 'on' | 'off' } (off also switches error counts off)
 *   set-errors-consent : { action, consent: 'on' | 'instant' | 'off' } ('on' is daily)
 *   set-endpoint : { action, endpoint: string }
 *   send-now     : { action }
 */
export async function POST(request: NextRequest) {
  try {
    const auth = await requireAdminAuth(request);
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
      if (source === 'no-third-party') {
        return NextResponse.json(
          { error: 'telemetry is off while NO_THIRD_PARTY_TRAFFIC is on' },
          { status: 409 },
        );
      }
      if (body.consent !== 'on' && body.consent !== 'off') {
        return NextResponse.json({ error: 'consent must be "on" or "off"' }, { status: 400 });
      }
      const consent = body.consent;
      const now = new Date().toISOString();
      let before: string | undefined;
      // Against the stored state, so a schedule written meanwhile stays.
      await updateState((state) => {
        before = state.consent;
        state.consent = consent;
        if (consent === 'on' && !state.consentedAt) state.consentedAt = now;
        // Error counts ride on the heartbeat: no heartbeats, no error counts,
        // and turning heartbeats on again doesn't bring them back by itself.
        if (consent === 'off') state.errorsConsent = 'off';
      });
      await reschedule();
      await auditLog('telemetry.set-consent', { from: before, to: body.consent }, ip);
      return NextResponse.json({ ok: true });
    }

    if (body.action === 'set-errors-consent') {
      const errors = await effectiveErrorsConsent();
      if (errors.source === 'env') {
        return NextResponse.json({ error: 'error counts are set by the BULWARK_TELEMETRY_ERRORS env var' }, { status: 409 });
      }
      if (errors.source === 'no-third-party') {
        return NextResponse.json({ error: 'telemetry is off while NO_THIRD_PARTY_TRAFFIC is on' }, { status: 409 });
      }
      if (body.consent !== 'on' && body.consent !== 'off' && body.consent !== 'instant') {
        return NextResponse.json({ error: 'consent must be "on", "instant" or "off"' }, { status: 400 });
      }
      if (body.consent !== 'off' && errors.source === 'telemetry') {
        return NextResponse.json({ error: 'turn on the heartbeat first' }, { status: 409 });
      }
      const consent = body.consent;
      let before: string | undefined;
      await updateState((state) => {
        before = state.errorsConsent ?? 'off';
        state.errorsConsent = consent;
      });
      await auditLog('telemetry.set-errors-consent', { from: before, to: consent }, ip);
      return NextResponse.json({ ok: true });
    }

    if (body.action === 'set-endpoint') {
      if (typeof body.endpoint !== 'string') {
        return NextResponse.json({ error: 'endpoint required' }, { status: 400 });
      }
      const trimmed = body.endpoint.trim();
      if (trimmed) {
        const check = await resolveEndpointAllowed(trimmed);
        if (!check.ok) {
          return NextResponse.json({ error: check.reason }, { status: 400 });
        }
      }
      let before: string | undefined;
      // Empty means no collector: heartbeats stop until a URL is set again.
      const state = await updateState((current) => {
        before = current.endpoint;
        current.endpoint = trimmed;
      });
      await reschedule();
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
    const unavailable = storedDataUnavailableResponse(err);
    if (unavailable) return unavailable;
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
