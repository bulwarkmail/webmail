/**
 * @vitest-environment node
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { NextRequest } from 'next/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// #1718: a Stalwart admin opens the dashboard without the admin password
// through their webmail login. Signing that login out of the webmail left the
// admin session running, so /admin stayed open in the browser.

const jar = new Map<string, string>();
vi.mock('next/headers', () => ({
  cookies: async () => ({
    get: (name: string) => (jar.has(name) ? { name, value: jar.get(name)! } : undefined),
    getAll: () => [...jar].map(([name, value]) => ({ name, value })),
    set: (name: string, value: string) => { jar.set(name, value); },
    delete: (name: string) => { jar.delete(name); },
  }),
}));
const audit = vi.fn();
vi.mock('@/lib/admin/audit', () => ({ auditLog: async (...args: unknown[]) => { audit(...args); } }));

const COOKIE = 'admin_session';
let dir: string;

beforeEach(() => {
  vi.resetModules();
  jar.clear();
  audit.mockClear();
  dir = mkdtempSync(path.join(tmpdir(), 'bw-admin-webmail-signout-'));
  vi.stubEnv('SESSION_SECRET', 'a'.repeat(64));
  vi.stubEnv('ADMIN_CONFIG_DIR', dir);
  vi.stubEnv('ADMIN_STATE_DIR', path.join(dir, 'state'));
});
afterEach(() => {
  vi.unstubAllEnvs();
  rmSync(dir, { recursive: true, force: true });
});

const adminRequest = () => new Request('http://localhost/api/admin/config', {
  method: 'POST',
  headers: { 'sec-fetch-site': 'same-origin' },
});

/** Opens an admin session in this browser, from the login in `slot` or with the password. */
async function openAdmin(slot?: number): Promise<string> {
  const { setAdminSessionCookie } = await import('@/lib/admin/session');
  await setAdminSessionCookie(adminRequest(), slot === undefined ? {} : { slot });
  return jar.get(COOKIE)!;
}

/** Whether the dashboard opens for this cookie. */
async function opens(token: string): Promise<boolean> {
  const { requireAdminAuth } = await import('@/lib/admin/session');
  jar.set(COOKIE, token);
  return !('error' in await requireAdminAuth(adminRequest()));
}

async function signOutOfWebmail(query: string): Promise<number> {
  const { DELETE } = await import('@/app/api/auth/session/route');
  const res = await DELETE(new NextRequest(`http://localhost/api/auth/session?${query}`, {
    method: 'DELETE',
    headers: { 'sec-fetch-site': 'same-origin' },
  }));
  return res.status;
}

describe('webmail sign-out and the admin session (#1718)', () => {
  it('ends the admin session the signed-out login opened, copies included', async () => {
    const token = await openAdmin(0);
    expect(await opens(token)).toBe(true);

    expect(await signOutOfWebmail('slot=0')).toBe(200);

    expect(jar.has(COOKIE)).toBe(false);
    expect(await opens(token)).toBe(false);
    expect(audit).toHaveBeenCalledWith('admin.logout', { reason: 'webmail_sign_out' }, expect.any(String));
  });

  it('ends it when every account signs out', async () => {
    const token = await openAdmin(2);
    expect(await signOutOfWebmail('all=true')).toBe(200);
    expect(await opens(token)).toBe(false);
  });

  it('keeps it when another login signs out', async () => {
    const token = await openAdmin(1);
    jar.set(COOKIE, token);
    expect(await signOutOfWebmail('slot=0')).toBe(200);
    expect(jar.get(COOKIE)).toBe(token);
    expect(await opens(token)).toBe(true);
    expect(audit).not.toHaveBeenCalled();
  });

  it('keeps a session opened with the admin password', async () => {
    const token = await openAdmin();
    jar.set(COOKIE, token);
    expect(await signOutOfWebmail('all=true')).toBe(200);
    expect(jar.get(COOKIE)).toBe(token);
    expect(await opens(token)).toBe(true);
  });
});
