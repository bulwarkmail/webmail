/**
 * This device's calls to the instance's registry. Only a clear answer counts:
 * a wipe needs a 200 with a `wipe` in it, and "forgotten" needs the route's own
 * word. An older instance without the routes, a proxy's error page or no
 * network at all reads as `unavailable`, and nothing happens.
 */

import { apiFetch } from '@/lib/browser-navigation';
import { getDesktopBridge } from '@/lib/desktop/bridge';
import type { DeviceRecord } from '@/lib/store/client/keys';
import type { WipeConfirmation } from './wipe-state';

export type CheckInAnswer = 'wipe' | 'wiped' | 'clear' | 'forgotten' | 'unavailable';

/** A new row and who the instance gave it to: the device checks that's the account it asked for. */
export interface RegisteredRow {
  id: string;
  secret: string;
  user: string;
  server: string;
}

/** Short enough for one row in a list. Nothing identifying beyond what a browser sends anyway. */
export function describePlatform(): string {
  const bridge = getDesktopBridge();
  if (bridge) return `Desktop app, ${({ win32: 'Windows', darwin: 'macOS', linux: 'Linux' } as const)[bridge.platform] ?? bridge.platform}`;
  if (typeof navigator === 'undefined') return '';
  const ua = navigator.userAgent;
  const os = /Android/.test(ua) ? 'Android'
    : /iPhone|iPad/.test(ua) ? 'iOS'
    : /Windows/.test(ua) ? 'Windows'
    : /Mac OS X/.test(ua) ? 'macOS'
    : /Linux/.test(ua) ? 'Linux'
    : 'Unknown system';
  const browser = /Edg\//.test(ua) ? 'Edge'
    : /Firefox\//.test(ua) ? 'Firefox'
    : /Chrome\//.test(ua) ? 'Chrome'
    : /Safari\//.test(ua) ? 'Safari'
    : 'Browser';
  return `${browser}, ${os}`;
}

function deviceInfo() {
  return { platform: describePlatform(), appVersion: process.env.NEXT_PUBLIC_APP_VERSION ?? '' };
}

async function readJson(response: Response): Promise<Record<string, unknown> | null> {
  try {
    const body = await response.clone().json() as unknown;
    return body && typeof body === 'object' ? body as Record<string, unknown> : null;
  } catch {
    return null;
  }
}

function post(path: string, body: unknown, signal?: AbortSignal, headers: Record<string, string> = {}): Promise<Response> {
  return apiFetch(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify(body),
    signal,
  });
}

/** A new row, for the account signed in on this cookie slot. Null if that can't be done now. */
export async function registerWithInstance(slot: number, signal?: AbortSignal): Promise<RegisteredRow | null> {
  try {
    const response = await post('/api/devices', deviceInfo(), signal, { 'X-JMAP-Cookie-Slot': String(slot) });
    if (!response.ok) return null;
    const body = await readJson(response);
    if (typeof body?.id !== 'string' || typeof body.secret !== 'string' || typeof body.user !== 'string' || typeof body.server !== 'string') return null;
    return { id: body.id, secret: body.secret, user: body.user, server: body.server };
  } catch {
    return null;
  }
}

export async function checkInWithInstance(record: Pick<DeviceRecord, 'id' | 'secret'>, signal?: AbortSignal): Promise<CheckInAnswer> {
  try {
    const response = await post('/api/devices', { id: record.id, secret: record.secret, ...deviceInfo() }, signal);
    const body = await readJson(response);
    if (response.status === 404) return body?.error === 'unknown_device' ? 'forgotten' : 'unavailable';
    if (!response.ok || !body || !('wipe' in body)) return 'unavailable';
    if (body.wipe && typeof body.wipe === 'object') return 'wipe';
    return body.wiped === true ? 'wiped' : 'clear';
  } catch {
    return 'unavailable';
  }
}

/** True when there's nothing more to say: it was taken, or the row no longer exists. */
export async function reportWipeToInstance(entry: WipeConfirmation, signal?: AbortSignal): Promise<boolean> {
  try {
    const { id, secret, reason, unsent, drop } = entry;
    const response = await post('/api/devices/wiped', drop ? { id, secret, drop: true } : { id, secret, reason, unsent }, signal);
    if (response.ok) return true;
    const error = (await readJson(response))?.error;
    return (response.status === 404 && error === 'unknown_device') || (response.status === 409 && error === 'no_wipe_asked');
  } catch {
    return false;
  }
}
