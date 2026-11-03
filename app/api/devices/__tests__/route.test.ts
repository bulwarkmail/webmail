import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { NextRequest } from 'next/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const creds = vi.hoisted(() => ({ value: null as null | { accountName: string; serverUrl: string } }));
vi.mock('@/lib/stalwart/credentials', () => ({ getStalwartCredentials: async () => creds.value }));

const admin = vi.hoisted(() => ({ allowed: true }));
vi.mock('@/lib/admin/session', async (original) => ({
  ...await original<typeof import('@/lib/admin/session')>(),
  requireAdminAuth: async () => (admin.allowed
    ? { session: { role: 'admin' } }
    : { error: new Response(JSON.stringify({ error: 'Unauthorized' }), { status: 401 }) }),
  getClientIP: () => '203.0.113.9',
}));

import { POST as checkIn } from '../route';
import { POST as wiped } from '../wiped/route';
import { GET as adminList, POST as adminAct } from '../../admin/devices/route';
import * as registry from '@/lib/devices/registry';

let dir: string;

function request(url: string, body: unknown, headers: Record<string, string> = {}): NextRequest {
  return new NextRequest(`https://mail.example.org${url}`, {
    method: 'POST',
    body: JSON.stringify(body),
    headers: { 'Content-Type': 'application/json', 'sec-fetch-site': 'same-origin', ...headers },
  });
}

function audit(): Array<{ action: string; detail: Record<string, unknown>; ip: string }> {
  try {
    return readFileSync(path.join(dir, 'audit.log'), 'utf8').trim().split('\n').map((line) => JSON.parse(line));
  } catch {
    return [];
  }
}

async function register(): Promise<{ id: string; secret: string }> {
  creds.value = { accountName: 'alice@example.org', serverUrl: 'https://mail.example.org' };
  const response = await checkIn(request('/api/devices', { platform: 'Chrome, Windows', appVersion: '1.0.0' }, { 'X-JMAP-Cookie-Slot': '0' }));
  expect(response.status).toBe(200);
  const body = await response.json() as { id: string; secret: string };
  // Everything after this works with no session at all.
  creds.value = null;
  return body;
}

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'bw-device-routes-'));
  vi.stubEnv('ADMIN_STATE_DIR', dir);
  admin.allowed = true;
  creds.value = null;
});

afterEach(() => {
  vi.unstubAllEnvs();
  rmSync(dir, { recursive: true, force: true });
});

describe('POST /api/devices', () => {
  it('won\'t register anyone without a session cookie', async () => {
    const response = await checkIn(request('/api/devices', { platform: 'x', appVersion: '1' }));
    expect(response.status).toBe(401);
    expect((await registry.listDevices()).total).toBe(0);
  });

  it('keys a new row on the cookie\'s account name', async () => {
    const { id } = await register();
    expect(id.split('/')[0]).toBe((await registry.listDevices()).devices[0].userKey);
    expect((await registry.getDevice(id))?.user).toBe('alice@example.org');
  });

  it('refuses another site', async () => {
    const response = await checkIn(request('/api/devices', { id: 'x', secret: 'y' }, { 'sec-fetch-site': 'cross-site' }));
    expect(response.status).toBe(403);
  });

  it('tells a device with no cookies about its wipe, going by its secret', async () => {
    const { id, secret } = await register();
    const before = await checkIn(request('/api/devices', { id, secret, platform: 'x', appVersion: '1' }));
    expect(await before.json()).toEqual({ wipe: null });

    await registry.requestDeviceWipe(id, 'admin');
    const after = await checkIn(request('/api/devices', { id, secret, platform: 'x', appVersion: '1' }));
    expect((await after.json() as { wipe: unknown }).wipe).toMatchObject({ requestedAt: expect.any(String) });
  });

  it('says the same for a wrong secret as for a row that isn\'t there', async () => {
    const { id } = await register();
    const wrong = await checkIn(request('/api/devices', { id, secret: 'f'.repeat(64) }));
    const missing = await checkIn(request('/api/devices', { id: `${'a'.repeat(64)}/${'b'.repeat(32)}`, secret: 'f'.repeat(64) }));
    expect(wrong.status).toBe(404);
    expect(await wrong.json()).toEqual(await missing.json());
  });

  it('won\'t store a platform with control characters or at any length', async () => {
    creds.value = { accountName: 'alice@example.org', serverUrl: 'https://mail.example.org' };
    const response = await checkIn(request('/api/devices', { platform: `a\nb${'x'.repeat(200)}`, appVersion: '1' }));
    const { id } = await response.json() as { id: string };
    const device = await registry.getDevice(id);
    expect(device?.platform).not.toContain('\n');
    expect(device?.platform.length).toBeLessThanOrEqual(64);
  });
});

describe('POST /api/devices/wiped', () => {
  it('confirms with the secret alone and writes an audit entry', async () => {
    const { id, secret } = await register();
    await registry.requestDeviceWipe(id, 'admin');

    const response = await wiped(request('/api/devices/wiped', { id, secret, reason: 'admin', unsent: 2 }));
    expect(response.status).toBe(200);

    const device = await registry.getDevice(id);
    expect(device?.wipe).toBeNull();
    expect(device?.wipedAt).not.toBeNull();
    const entry = audit().find((line) => line.action === 'device.wipe.confirm');
    expect(entry?.detail).toMatchObject({ device: id, user: 'alice@example.org', reason: 'admin', unsentDeleted: 2 });
    expect(entry?.ip).toBe('203.0.113.9');
  });

  it('takes nothing without the right secret and writes no entry', async () => {
    const { id } = await register();
    await registry.requestDeviceWipe(id, 'admin');
    const response = await wiped(request('/api/devices/wiped', { id, secret: 'f'.repeat(64), reason: 'admin' }));
    expect(response.status).toBe(404);
    expect((await registry.getDevice(id))?.wipe).not.toBeNull();
    expect(audit().filter((line) => line.action === 'device.wipe.confirm')).toEqual([]);
  });
});

describe('/api/admin/devices', () => {
  it('is closed without an admin session', async () => {
    admin.allowed = false;
    expect((await adminAct(request('/api/admin/devices', { action: 'wipe', id: 'x' }))).status).toBe(401);
    expect((await adminList(new NextRequest('https://mail.example.org/api/admin/devices'))).status).toBe(401);
  });

  it('wipes one device and writes an audit entry for the request', async () => {
    const { id } = await register();
    const response = await adminAct(request('/api/admin/devices', { action: 'wipe', id }));
    expect(response.status).toBe(200);
    expect((await registry.getDevice(id))?.wipe).toMatchObject({ by: 'admin' });
    expect(audit().map((line) => line.action)).toEqual(['device.wipe.request']);
    expect(audit()[0].detail).toMatchObject({ device: id, user: 'alice@example.org', by: 'admin' });
  });

  it('asking again writes no second entry', async () => {
    const { id } = await register();
    await adminAct(request('/api/admin/devices', { action: 'wipe', id }));
    const again = await adminAct(request('/api/admin/devices', { action: 'wipe', id }));
    expect(again.status).toBe(200);
    expect(audit().filter((line) => line.action === 'device.wipe.request')).toHaveLength(1);
  });

  it('wipes all of a user\'s devices, one audit entry each', async () => {
    const first = await register();
    const second = await register();
    const response = await adminAct(request('/api/admin/devices', { action: 'wipe-user', userKey: first.id.split('/')[0] }));
    expect(response.status).toBe(200);
    expect((await registry.getDevice(first.id))?.wipe).not.toBeNull();
    expect((await registry.getDevice(second.id))?.wipe).not.toBeNull();
    expect(audit().filter((line) => line.action === 'device.wipe.request')).toHaveLength(2);
  });

  it('takes a wipe back and forgets a row, on the record', async () => {
    const { id } = await register();
    await adminAct(request('/api/admin/devices', { action: 'wipe', id }));
    await adminAct(request('/api/admin/devices', { action: 'cancel', id }));
    expect((await registry.getDevice(id))?.wipe).toBeNull();
    await adminAct(request('/api/admin/devices', { action: 'forget', id }));
    expect(await registry.getDevice(id)).toBeNull();
    expect(audit().map((line) => line.action)).toEqual(['device.wipe.request', 'device.wipe.cancel', 'device.forget']);
  });

  it('lists without any secret', async () => {
    const { secret } = await register();
    const response = await adminList(new NextRequest('https://mail.example.org/api/admin/devices'));
    const text = await response.text();
    expect(JSON.parse(text).total).toBe(1);
    expect(text).not.toContain(secret);
    expect(text).not.toContain('secretHash');
  });

  it('turns down nonsense', async () => {
    expect((await adminAct(request('/api/admin/devices', { action: 'wipe', id: '../etc/passwd' }))).status).toBe(400);
    expect((await adminAct(request('/api/admin/devices', { action: 'wipe-user', userKey: 'nope' }))).status).toBe(400);
    expect((await adminAct(request('/api/admin/devices', { action: 'wipe', id: `${'a'.repeat(64)}/${'b'.repeat(32)}` }))).status).toBe(404);
  });
});

describe('the audit log page', () => {
  it('can filter by every device action', () => {
    const page = readFileSync(path.join(process.cwd(), 'app/(main)/admin/_pages/logs.tsx'), 'utf8');
    for (const action of ['device.wipe.request', 'device.wipe.confirm', 'device.wipe.cancel', 'device.forget']) {
      expect(page).toContain(`value="${action}"`);
    }
  });
});
