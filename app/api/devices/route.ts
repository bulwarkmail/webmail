import { createHash } from 'node:crypto';
import { NextRequest, NextResponse } from 'next/server';
import { getClientIP } from '@/lib/admin/session';
import { checkInDevice, DEVICE_ID_RE, DEVICE_SECRET_RE, REGISTER_PER_HOUR, registerDevice, TooManyDevicesError } from '@/lib/devices/registry';
import { logger } from '@/lib/logger';
import { rejectCrossOriginRequest } from '@/lib/security/same-origin';
import { getStore } from '@/lib/shared-store';
import { getStalwartCredentials } from '@/lib/stalwart/credentials';
import { isStoreUnavailable } from '@/lib/stored-data-errors';

const NO_STORE = { 'Cache-Control': 'no-store' };
const MAX_BODY_BYTES = 2048;
// Per address: a whole office can sit behind one, checking in as it starts up.
const PER_MINUTE = 300;

function cleanText(value: unknown): string {
  if (typeof value !== 'string') return '';
  return value.replace(/[^\x20-\x7e]/g, '').trim().slice(0, 64);
}

/**
 * POST /api/devices
 *
 * With `{ id, secret }`: a device checks in and hears whether a wipe waits for
 * it. No session needed, and nothing goes to the mail server: a device whose
 * password was revoked still has to learn about its wipe.
 *
 * Without them: a new device registers for the signed-in account in the sealed
 * context cookie (the slot header picks which). That needs a live session
 * cookie, so a browser that restarted registers once its session is restored.
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
    const info = { platform: cleanText(body?.platform), appVersion: cleanText(body?.appVersion) };

    if (body?.id !== undefined || body?.secret !== undefined) {
      if (typeof body.id !== 'string' || !DEVICE_ID_RE.test(body.id) || typeof body.secret !== 'string' || !DEVICE_SECRET_RE.test(body.secret)) {
        return NextResponse.json({ error: 'unknown_device' }, { status: 404, headers: NO_STORE });
      }
      const device = await checkInDevice(body.id, body.secret, info);
      if (!device) return NextResponse.json({ error: 'unknown_device' }, { status: 404, headers: NO_STORE });
      if (device.wipe) return NextResponse.json({ wipe: { requestedAt: device.wipe.requestedAt } }, { headers: NO_STORE });
      // Its data went already. A device still holding this row starts over.
      return NextResponse.json(device.wipedAt ? { wipe: null, wiped: true } : { wipe: null }, { headers: NO_STORE });
    }

    const creds = await getStalwartCredentials(request);
    if (!creds) return NextResponse.json({ error: 'Not authenticated' }, { status: 401, headers: NO_STORE });
    // Per account, not per address: one hour-long counter per signed-in
    // account, so nobody can fill the counter store by changing addresses.
    const account = createHash('sha256').update(`${creds.serverUrl}\n${creds.accountName}`).digest('base64url');
    const newRows = await getStore().counters.reserve([
      { key: `device-register:${account}`, max: REGISTER_PER_HOUR, windowMs: 60 * 60 * 1000 },
    ]).catch(() => ({ ok: true }));
    if (!newRows.ok) return NextResponse.json({ error: 'rate limited' }, { status: 429, headers: NO_STORE });
    const created = await registerDevice(creds.accountName, creds.serverUrl, info);
    return NextResponse.json({ ...created, wipe: null }, { headers: NO_STORE });
  } catch (error) {
    if (error instanceof Error && error.name === new TooManyDevicesError().name) {
      return NextResponse.json({ error: 'too_many_devices' }, { status: 429, headers: NO_STORE });
    }
    if (isStoreUnavailable(error)) {
      return NextResponse.json({ error: 'Temporarily unavailable' }, { status: 503, headers: { ...NO_STORE, 'Retry-After': '30' } });
    }
    logger.error('device check-in', { error: error instanceof Error ? error.message : String(error) });
    return NextResponse.json({ error: 'Internal server error' }, { status: 500, headers: NO_STORE });
  }
}
