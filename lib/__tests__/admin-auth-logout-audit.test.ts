// @vitest-environment node
//
// DELETE /api/admin/auth (sign out) and the admin audit log. A sign-out
// request passes the same-origin check without Origin and Sec-Fetch-Site
// (curl, a script), so it can come from anyone. It writes `admin.logout` only
// when an admin session that was still signed in was signed out: a request
// without one, with a forged cookie, or with a copy of a session that was
// signed out already writes nothing, so it can't rotate real entries out of
// the log.
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('next/server', () => ({
  NextResponse: {
    json: (data: unknown, init?: { status?: number }) => ({ json: async () => data, status: init?.status ?? 200 }),
  },
}));
const jar = new Map<string, string>();
vi.mock('next/headers', () => ({
  cookies: async () => ({
    get: (name: string) => (jar.has(name) ? { name, value: jar.get(name)! } : undefined),
    set: (name: string, value: string) => { jar.set(name, value); },
    delete: (name: string) => { jar.delete(name); },
  }),
}));
vi.mock('@/lib/logger', () => ({ logger: { warn: vi.fn(), error: vi.fn(), debug: vi.fn(), info: vi.fn() } }));
const auditLog = vi.hoisted(() => vi.fn(async () => {}));
vi.mock('@/lib/admin/audit', () => ({ auditLog }));
vi.mock('@/lib/admin/config-manager', () => ({
  configManager: { ensureLoaded: vi.fn(), get: (_key: string, fallback?: unknown) => fallback },
}));
vi.mock('@/lib/stalwart/credentials', () => ({ getStalwartCredentials: async () => null }));
vi.mock('@/lib/admin/stalwart-admin-access', () => ({ getStalwartAdminAccessMode: async () => 'auto' }));
const revoked = vi.hoisted(() => new Set<string>());
vi.mock('@/lib/admin/password', () => ({
  initAdminPassword: vi.fn().mockResolvedValue(true),
  isAdminEnabled: () => true,
  verifyAdminPassword: async (password: string) => password === 'right-password',
  updateLastLogin: vi.fn(),
  getAdminMeta: () => null,
  getAdminSessionGeneration: async () => 0,
  isAdminSessionRevoked: async (sid: string) => revoked.has(sid),
  revokeAdminSession: vi.fn(async (sid: string) => { revoked.add(sid); }),
}));

process.env.SESSION_SECRET = 'a'.repeat(48);

type Route = typeof import('@/app/api/admin/auth/route');
let POST: Route['POST'];
let DELETE: Route['DELETE'];

beforeEach(async () => {
  vi.resetModules();
  (await import('@/lib/shared-store/local')).resetLocalStoreForTests();
  ({ POST, DELETE } = await import('@/app/api/admin/auth/route'));
  auditLog.mockClear();
  jar.clear();
  revoked.clear();
});

const address = (i: number) => `198.51.${Math.floor(i / 250)}.${i % 250}`;
const logouts = () => (auditLog.mock.calls as unknown as [string][]).filter(([action]) => action === 'admin.logout').length;

/** What curl sends: no Origin, no Sec-Fetch-Site; the cookie jar holds whatever the test put there. */
async function signOut(ip: string): Promise<number> {
  const request = new Request('https://bulwark.example/api/admin/auth', { method: 'DELETE', headers: { 'x-forwarded-for': ip } });
  return (await DELETE(request as never)).status;
}

async function signIn(ip: string): Promise<string> {
  const request = new Request('https://bulwark.example/api/admin/auth', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-forwarded-for': ip },
    body: JSON.stringify({ password: 'right-password' }),
  });
  expect((await POST(request as never)).status).toBe(200);
  return jar.get('admin_session')!;
}

describe('sign-out requests and the audit log', () => {
  it('writes nothing for sign-out requests without an admin session', async () => {
    for (let i = 0; i < 500; i++) expect(await signOut(address(i))).toBe(200);
    expect(logouts()).toBe(0);
  });

  it('writes nothing for a cookie that is not an admin session', async () => {
    for (let i = 0; i < 50; i++) {
      jar.set('admin_session', `made-up-${i}`);
      await signOut(address(i));
    }
    expect(logouts()).toBe(0);
  });

  it('writes nothing for a copy of a session that was signed out already', async () => {
    const token = await signIn('203.0.113.5');
    expect(await signOut('203.0.113.5')).toBe(200);
    expect(logouts()).toBe(1);
    for (let i = 0; i < 20; i++) {
      jar.set('admin_session', token);
      await signOut(address(i));
    }
    expect(logouts()).toBe(1);
  });

  it('still logs a real admin signing out (control)', async () => {
    await signIn('203.0.113.9');
    expect(await signOut('203.0.113.9')).toBe(200);
    expect(logouts()).toBe(1);
    expect(auditLog).toHaveBeenLastCalledWith('admin.logout', {}, '203.0.113.9');
  });
});
