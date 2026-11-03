import { NextRequest, NextResponse } from 'next/server';
import { auditLog } from '@/lib/admin/audit';
import { getClientIP } from '@/lib/admin/session';
import { confirmDeviceWipe, DEVICE_ID_RE, DEVICE_SECRET_RE } from '@/lib/devices/registry';
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
 * the next contact until it gets through, so it answers the same each time.
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
    const reason: WipeReason = WIPE_REASONS.includes(body.reason as WipeReason) ? body.reason as WipeReason : 'admin';
    const unsent = typeof body.unsent === 'number' && Number.isFinite(body.unsent) && body.unsent >= 0 ? Math.floor(body.unsent) : 0;

    const device = await confirmDeviceWipe(body.id, body.secret, reason);
    if (!device) return NextResponse.json({ error: 'unknown_device' }, { status: 404, headers: NO_STORE });
    await auditLog(AUDIT_DEVICE_WIPE_CONFIRM, {
      device: device.id,
      user: device.user,
      server: device.server,
      platform: device.platform,
      reason,
      unsentDeleted: unsent,
    }, getClientIP(request));
    return NextResponse.json({ ok: true }, { headers: NO_STORE });
  } catch (error) {
    if (isStoreUnavailable(error)) {
      return NextResponse.json({ error: 'Temporarily unavailable' }, { status: 503, headers: { ...NO_STORE, 'Retry-After': '30' } });
    }
    logger.error('device wipe confirmation', { error: error instanceof Error ? error.message : String(error) });
    return NextResponse.json({ error: 'Internal server error' }, { status: 500, headers: NO_STORE });
  }
}
