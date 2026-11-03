import { NextRequest, NextResponse } from 'next/server';
import { auditLog } from '@/lib/admin/audit';
import { getClientIP } from '@/lib/admin/session';
import { confirmDeviceWipe, DEVICE_ID_RE, DEVICE_SECRET_RE, dropDevice } from '@/lib/devices/registry';
import type { DeviceView } from '@/lib/devices/types';
import { AUDIT_DEVICE_WIPE_CONFIRM, WIPE_REASONS, type WipeReason } from '@/lib/devices/types';
import { logger } from '@/lib/logger';
import { rejectCrossOriginRequest } from '@/lib/security/same-origin';
import { getStore } from '@/lib/shared-store';
import { isStoreUnavailable } from '@/lib/stored-data-errors';

const NO_STORE = { 'Cache-Control': 'no-store' };
const MAX_BODY_BYTES = 1024;
// Per address: a whole office can sit behind one, checking in as it starts up.
const PER_MINUTE = 300;

/**
 * POST /api/devices/wiped: a device says its wipe is done. By then it has signed
 * out or is about to, so its secret is the proof, not a session. Sent again at
 * the next contact until it gets through, so it answers the same each time, and
 * only a row that really changes goes in the log.
 *
 * With `drop`: the account signed out here, with its data, so the row goes too.
 */
export async function POST(request: NextRequest) {
  const crossOrigin = rejectCrossOriginRequest(request);
  if (crossOrigin) return crossOrigin;

  const limit = await getStore().counters.reserve([
    { key: `device-checkin:${getClientIP(request)}`, max: PER_MINUTE, windowMs: 60_000 },
  ]).catch(() => ({ ok: true }));
  if (!limit.ok) return NextResponse.json({ error: 'rate limited' }, { status: 429, headers: NO_STORE });

  try {
    const text = await request.text();
    if (text.length > MAX_BODY_BYTES) return NextResponse.json({ error: 'too large' }, { status: 413, headers: NO_STORE });
    let body: Record<string, unknown>;
    try {
      body = JSON.parse(text) as Record<string, unknown>;
    } catch {
      return NextResponse.json({ error: 'bad request' }, { status: 400, headers: NO_STORE });
    }
    if (typeof body?.id !== 'string' || !DEVICE_ID_RE.test(body.id) || typeof body.secret !== 'string' || !DEVICE_SECRET_RE.test(body.secret)) {
      return NextResponse.json({ error: 'unknown_device' }, { status: 404, headers: NO_STORE });
    }
    const write = (device: DeviceView, reason: WipeReason, unsentDeleted: number | 'unknown') => auditLog(AUDIT_DEVICE_WIPE_CONFIRM, {
      device: device.id,
      user: device.user,
      server: device.server,
      platform: device.platform,
      reason,
      unsentDeleted,
    }, getClientIP(request));

    if (body.drop === true) {
      const dropped = await dropDevice(body.id, body.secret);
      if (!dropped) return NextResponse.json({ error: 'unknown_device' }, { status: 404, headers: NO_STORE });
      if (dropped.confirmed) await write(dropped.confirmed, 'user', 'unknown');
      return NextResponse.json({ ok: true }, { headers: NO_STORE });
    }

    if (!WIPE_REASONS.includes(body.reason as WipeReason)) return NextResponse.json({ error: 'bad request' }, { status: 400, headers: NO_STORE });
    const reason = body.reason as WipeReason;
    const unsent = typeof body.unsent === 'number' && Number.isFinite(body.unsent) && body.unsent >= 0 ? Math.floor(body.unsent) : 'unknown';

    const answer = await confirmDeviceWipe(body.id, body.secret, reason);
    if (!answer) return NextResponse.json({ error: 'unknown_device' }, { status: 404, headers: NO_STORE });
    if (answer === 'no_wipe_asked') return NextResponse.json({ error: 'no_wipe_asked' }, { status: 409, headers: NO_STORE });
    if (answer.changed) await write(answer.device, reason, unsent);
    return NextResponse.json({ ok: true }, { headers: NO_STORE });
  } catch (error) {
    if (isStoreUnavailable(error)) {
      return NextResponse.json({ error: 'Temporarily unavailable' }, { status: 503, headers: { ...NO_STORE, 'Retry-After': '30' } });
    }
    logger.error('device wipe confirmation', { error: error instanceof Error ? error.message : String(error) });
    return NextResponse.json({ error: 'Internal server error' }, { status: 500, headers: NO_STORE });
  }
}
