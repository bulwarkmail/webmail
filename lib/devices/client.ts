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

export type CheckInAnswer = 'wipe' | 'clear' | 'forgotten' | 'unavailable';

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
export async function registerWithInstance(slot: number, signal?: AbortSignal): Promise<{ id: string; secret: string } | null> {
  try {
    const response = await post('/api/devices', deviceInfo(), signal, { 'X-JMAP-Cookie-Slot': String(slot) });
    if (!response.ok) return null;
    const body = await readJson(response);
    return typeof body?.id === 'string' && typeof body.secret === 'string' ? { id: body.id, secret: body.secret } : null;
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
    return body.wipe && typeof body.wipe === 'object' ? 'wipe' : 'clear';
  } catch {
    return 'unavailable';
  }
}

/** True when there's nothing more to say: it was taken, or the row no longer exists. */
export async function reportWipeToInstance(entry: WipeConfirmation, signal?: AbortSignal): Promise<boolean> {
  try {
    const response = await post('/api/devices/wiped', entry, signal);
    if (response.ok) return true;
    return response.status === 404 && (await readJson(response))?.error === 'unknown_device';
  } catch {
    return false;
  }
}
