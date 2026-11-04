import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { NextRequest } from 'next/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// The real admin check, not a stand-in: a wipe request from another site carries
// the admin's cookie, and only the same-origin check stands in its way.

const jar = vi.hoisted(() => new Map<string, string>());
vi.mock('next/headers', () => ({
  cookies: async () => ({
    get: (name: string) => (jar.has(name) ? { name, value: jar.get(name) } : undefined),
    set: (name: string, value: string) => { jar.set(name, value); },
    delete: (name: string) => { jar.delete(name); },
  }),
}));

let dir: string;

function post(body: unknown, headers: Record<string, string>): NextRequest {
  return new NextRequest('https://mail.example.org/api/admin/devices', {
    method: 'POST',
    body: JSON.stringify(body),
    headers: { 'Content-Type': 'application/json', ...headers },
  });
}

function audit(): string {
  try {
    return readFileSync(path.join(dir, 'audit.log'), 'utf8');
  } catch {
    return '';
  }
}

describe('/api/admin/devices with the real admin check', () => {
  let route: typeof import('../route');
  let registry: typeof import('@/lib/devices/registry');
  let row: { id: string };

  beforeEach(async () => {
    vi.resetModules();
    dir = mkdtempSync(path.join(tmpdir(), 'bw-device-admin-'));
    vi.stubEnv('ADMIN_STATE_DIR', dir);
    vi.stubEnv('ADMIN_CONFIG_DIR', dir);
    vi.stubEnv('SESSION_SECRET', 'x'.repeat(64));
    jar.clear();
    route = await import('../route');
    registry = await import('@/lib/devices/registry');
    row = await registry.registerDevice('alice@example.org', 'https://mail.example.org', { platform: 'x', appVersion: '1' });
    const session = await import('@/lib/admin/session');
    const { getAdminSessionGeneration } = await import('@/lib/admin/password');
    jar.set('admin_session', session.createAdminSession(await getAdminSessionGeneration()));
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    rmSync(dir, { recursive: true, force: true });
  });

  it.each([
    ['another site says so', { 'sec-fetch-site': 'cross-site' }],
    ['a page on another origin', { origin: 'https://evil.example.net' }],
  ])('refuses a wipe with the admin\'s own cookie when %s', async (_name, headers) => {
    const response = await route.POST(post({ action: 'wipe', id: row.id }, headers));
    expect(response.status).toBe(403);
    expect((await registry.getDevice(row.id))?.wipe).toBeNull();
    expect(audit()).toBe('');
  });

  it('refuses wiping a whole user from another site', async () => {
    const response = await route.POST(post({ action: 'wipe-user', userKey: row.id.split('/')[0] }, { 'sec-fetch-site': 'cross-site' }));
    expect(response.status).toBe(403);
    expect((await registry.getDevice(row.id))?.wipe).toBeNull();
  });

  it('takes it from the same origin with the cookie', async () => {
    const response = await route.POST(post({ action: 'wipe', id: row.id }, { 'sec-fetch-site': 'same-origin' }));
    expect(response.status).toBe(200);
    expect((await registry.getDevice(row.id))?.wipe).toMatchObject({ by: 'admin' });
    expect(audit()).toContain('device.wipe.request');
  });

  it('refuses without the cookie, same origin or not', async () => {
    jar.clear();
    const response = await route.POST(post({ action: 'wipe', id: row.id }, { 'sec-fetch-site': 'same-origin' }));
    expect(response.status).toBe(401);
    expect((await registry.getDevice(row.id))?.wipe).toBeNull();
  });
});
