/**
 * @vitest-environment node
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Admin tokens are stateless, so signing out used to delete only the
// browser's cookie: a copy of it (stolen, or left in another browser) kept
// the dashboard open until it expired, and changing the admin password
// didn't end it either.

const jar = new Map<string, string>();
vi.mock('next/headers', () => ({
  cookies: async () => ({
    get: (name: string) => (jar.has(name) ? { name, value: jar.get(name)! } : undefined),
    set: (name: string, value: string) => { jar.set(name, value); },
    delete: (name: string) => { jar.delete(name); },
  }),
}));
vi.mock('@/lib/admin/audit', () => ({ auditLog: async () => {} }));

const COOKIE = 'admin_session';
let dir: string;

beforeEach(() => {
  vi.resetModules();
  jar.clear();
  dir = mkdtempSync(path.join(tmpdir(), 'bw-admin-signout-'));
  vi.stubEnv('SESSION_SECRET', 'a'.repeat(64));
  vi.stubEnv('ADMIN_CONFIG_DIR', dir);
  vi.stubEnv('ADMIN_STATE_DIR', path.join(dir, 'state'));
});
afterEach(() => {
  vi.unstubAllEnvs();
  rmSync(dir, { recursive: true, force: true });
});

const post = (url: string, body?: unknown) => new Request(`http://localhost${url}`, {
  method: 'POST',
  headers: { 'sec-fetch-site': 'same-origin', 'content-type': 'application/json' },
  body: body === undefined ? undefined : JSON.stringify(body),
});

/** Signs a browser in and returns its cookie. */
async function signIn(): Promise<string> {
  const { setAdminSessionCookie } = await import('@/lib/admin/session');
  await setAdminSessionCookie(post('/api/admin/auth'));
  return jar.get(COOKIE)!;
}

/** Whether the dashboard opens for this cookie. */
async function opens(token: string): Promise<boolean> {
  const { requireAdminAuth } = await import('@/lib/admin/session');
  jar.set(COOKIE, token);
  return !('error' in await requireAdminAuth(post('/api/admin/config')));
}

describe('admin sign-out', () => {
  it('refuses a copy of the cookie after its browser signed out, and keeps other sessions', async () => {
    const stolen = await signIn();
    const other = await signIn();
    expect(await opens(stolen)).toBe(true);

    jar.set(COOKIE, stolen);
    const { clearAdminSessionCookie } = await import('@/lib/admin/session');
    await clearAdminSessionCookie();
    expect(jar.has(COOKIE)).toBe(false);

    expect(await opens(stolen)).toBe(false);
    expect(await opens(other)).toBe(true);

    // Kept on disk: a restart does not bring it back.
    vi.resetModules();
    expect(await opens(stolen)).toBe(false);
  });

  it('signs every session out on a password change and keeps the changer signed in', async () => {
    const { setInitialAdminPassword } = await import('@/lib/admin/password');
    await setInitialAdminPassword('old-password-1');
    const elsewhere = await signIn();
    const changer = await signIn();

    jar.set(COOKIE, changer);
    const { POST } = await import('@/app/api/admin/change-password/route');
    const res = await POST(post('/api/admin/change-password', { currentPassword: 'old-password-1', newPassword: 'new-password-2' }) as never);
    expect(res.status).toBe(200);
    const reissued = jar.get(COOKIE)!;
    expect(reissued).not.toBe(changer);

    expect(await opens(elsewhere)).toBe(false);
    expect(await opens(changer)).toBe(false);
    expect(await opens(reissued)).toBe(true);

    vi.resetModules();
    expect(await opens(elsewhere)).toBe(false);
    expect(await opens(reissued)).toBe(true);
  });

  it('keeps sessions without an admin password (Stalwart admin sign-in) working', async () => {
    const token = await signIn();
    expect(await opens(token)).toBe(true);
  });
});
