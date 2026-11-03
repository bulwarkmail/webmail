import { NextRequest, NextResponse } from 'next/server';
import { auditLog } from '@/lib/admin/audit';
import { getClientIP, requireAdminAuth } from '@/lib/admin/session';
import { storeUnavailableResponse } from '@/lib/admin/store-unavailable-response';
import {
  cancelDeviceWipe,
  DEVICE_ID_RE,
  forgetDevice,
  getDevice,
  isUserKey,
  listDevices,
  requestDeviceWipe,
  requestUserWipe,
} from '@/lib/devices/registry';
import { AUDIT_DEVICE_FORGET, AUDIT_DEVICE_WIPE_CANCEL, AUDIT_DEVICE_WIPE_REQUEST, type DeviceView } from '@/lib/devices/types';
import { logger } from '@/lib/logger';

const MAX_PAGE = 200;

function positiveInt(raw: string | null, fallback: number): number {
  const parsed = Number.parseInt(raw ?? '', 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

function auditDetail(device: DeviceView, by: string): Record<string, unknown> {
  return { device: device.id, user: device.user, server: device.server, platform: device.platform, by };
}

/** Nothing to do: the row as it stands, so a stale page catches up. Only a missing row is an error. */
async function unchanged(id: string): Promise<NextResponse> {
  const device = await getDevice(id);
  return device ? NextResponse.json({ device }) : NextResponse.json({ error: 'not found' }, { status: 404 });
}

/** GET /api/admin/devices?offset=&limit=&q= : the registered devices, a page at a time. */
export async function GET(request: NextRequest) {
  try {
    const auth = await requireAdminAuth(request);
    if ('error' in auth) return auth.error;
    const { searchParams } = request.nextUrl;
    const page = await listDevices({
      offset: positiveInt(searchParams.get('offset'), 0),
      limit: Math.min(positiveInt(searchParams.get('limit'), 100) || 100, MAX_PAGE),
      query: searchParams.get('q') ?? undefined,
    });
    return NextResponse.json(page, { headers: { 'Cache-Control': 'no-store' } });
  } catch (error) {
    const unavailable = storeUnavailableResponse(error);
    if (unavailable) return unavailable;
    logger.error('admin devices GET', { error: error instanceof Error ? error.message : String(error) });
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}

/**
 * POST /api/admin/devices
 *   { action: 'wipe' | 'cancel' | 'forget', id }
 *   { action: 'wipe-user', userKey }
 *
 * A wipe waits until the device next reaches this instance. Each request and
 * each confirmed wipe goes in the audit log. Someone who controls the instance
 * can wipe any device that checks in here: that's the admin's power, on the record.
 */
export async function POST(request: NextRequest) {
  try {
    const auth = await requireAdminAuth(request);
    if ('error' in auth) return auth.error;
    // The admin session has a role and no name.
    const by = 'admin';
    const ip = getClientIP(request);

    const body = await request.json().catch(() => null) as { action?: unknown; id?: unknown; userKey?: unknown } | null;
    const action = body?.action;

    if (action === 'wipe-user') {
      if (!isUserKey(body?.userKey)) return NextResponse.json({ error: 'invalid userKey' }, { status: 400 });
      const devices = await requestUserWipe(body.userKey, by);
      for (const device of devices) {
        if (device.wipe) await auditLog(AUDIT_DEVICE_WIPE_REQUEST, auditDetail(device, by), ip);
      }
      return NextResponse.json({ devices });
    }

    if (typeof body?.id !== 'string' || !DEVICE_ID_RE.test(body.id)) {
      return NextResponse.json({ error: 'invalid id' }, { status: 400 });
    }

    if (action === 'wipe') {
      const device = await requestDeviceWipe(body.id, by);
      if (!device) return unchanged(body.id);
      await auditLog(AUDIT_DEVICE_WIPE_REQUEST, auditDetail(device, by), ip);
      return NextResponse.json({ device });
    }
    if (action === 'cancel') {
      const device = await cancelDeviceWipe(body.id);
      if (!device) return unchanged(body.id);
      await auditLog(AUDIT_DEVICE_WIPE_CANCEL, auditDetail(device, by), ip);
      return NextResponse.json({ device });
    }
    if (action === 'forget') {
      const device = await getDevice(body.id);
      if (!device) return NextResponse.json({ error: 'not found' }, { status: 404 });
      await forgetDevice(body.id);
      await auditLog(AUDIT_DEVICE_FORGET, auditDetail(device, by), ip);
      return NextResponse.json({ ok: true });
    }
    return NextResponse.json({ error: 'unknown action' }, { status: 400 });
  } catch (error) {
    const unavailable = storeUnavailableResponse(error);
    if (unavailable) return unavailable;
    logger.error('admin devices POST', { error: error instanceof Error ? error.message : String(error) });
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
