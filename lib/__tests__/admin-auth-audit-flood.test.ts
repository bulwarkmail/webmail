// @vitest-environment node
//
// POST /api/admin/auth and the admin audit log. A request that can't be a
// sign-in (a Stalwart sign-in without a mailbox session) writes nothing; a
// refused attempt counts in the admin login limits, and once those are spent
// the refusal is written once per client and window, with a small ceiling
// across clients. So no number of requests can rotate the admin's real
// entries out of the log, while real failed sign-ins and a real admin's
// sign-in are still logged.
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
vi.mock('@/lib/security/same-origin', () => ({ isSameOriginRequest: () => true }));
vi.mock('@/lib/admin/config-manager', () => ({
  configManager: { ensureLoaded: vi.fn(), get: (_key: string, fallback?: unknown) => fallback },
}));
// A visitor has no mailbox session; a signed-in user (not a Stalwart admin) has one.
const mailbox = vi.hoisted(() => ({ signedIn: false }));
vi.mock('@/lib/stalwart/credentials', () => ({
  getStalwartCredentials: async () => (mailbox.signedIn
    ? { serverUrl: 'https://mail.example.org', authHeader: 'Bearer a-user-token-0123456789', username: 'user@example.org', trusted: true }
    : null),
}));
const mode = vi.hoisted(() => ({ value: 'auto' }));
vi.mock('@/lib/admin/stalwart-admin-access', () => ({ getStalwartAdminAccessMode: async () => mode.value }));
vi.mock('@/lib/admin/password', () => ({
  initAdminPassword: vi.fn().mockResolvedValue(true),
  isAdminEnabled: () => true,
  verifyAdminPassword: async (password: string) => password === 'right-password',
  updateLastLogin: vi.fn(),
  getAdminMeta: () => null,
  getAdminSessionGeneration: async () => 0,
  isAdminSessionRevoked: async () => false,
  revokeAdminSession: vi.fn(),
}));

process.env.SESSION_SECRET = 'a'.repeat(48);

type Route = typeof import('@/app/api/admin/auth/route');
let POST: Route['POST'];

beforeEach(async () => {
  vi.resetModules();
  (await import('@/lib/shared-store/local')).resetLocalStoreForTests();
  ({ POST } = await import('@/app/api/admin/auth/route'));
  auditLog.mockClear();
  jar.clear();
  mode.value = 'auto';
  mailbox.signedIn = false;
  // The user's mail server: an account, but not the superuser.
  vi.stubGlobal('fetch', vi.fn(async (url: RequestInfo | URL) => (String(url).endsWith('/.well-known/jmap')
    ? Response.json({ primaryAccounts: { 'urn:stalwart:jmap': 'u1' } })
    : Response.json({ methodResponses: [['error', { type: 'forbidden' }, '0']] }))));
});

async function post(body: unknown, ip: string): Promise<number> {
  const request = new Request('https://bulwark.example/api/admin/auth', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-forwarded-for': ip },
    body: JSON.stringify(body),
  });
  return (await POST(request as never)).status;
}

const REQUESTS = 500;
const address = (i: number) => `198.51.${Math.floor(i / 250)}.${i % 250}`;
const actions = () => (auditLog.mock.calls as unknown as [string, unknown, string][]).map(([action]) => action);

describe('refused admin sign-ins and the audit log', () => {
  it('writes nothing for a Stalwart sign-in attempt without a mailbox session', async () => {
    for (let i = 0; i < REQUESTS; i++) expect(await post({ stalwartAuth: true }, address(i % 250))).toBe(403);
    expect(auditLog).not.toHaveBeenCalled();
  });

  it('writes nothing for one either while Stalwart sign-in is switched off', async () => {
    mode.value = 'password';
    for (let i = 0; i < REQUESTS; i++) await post({ stalwartAuth: true }, address(i % 250));
    expect(auditLog).not.toHaveBeenCalled();
  });

  it('writes one line per refused password, then one for the client once it is rate limited', async () => {
    for (let i = 0; i < REQUESTS; i++) await post({ password: 'guess' }, '203.0.113.7');
    expect(actions()).toEqual([...Array(5).fill('admin.login_failed'), 'admin.login_blocked']);
  });

  it('keeps a flood of wrong passwords from many addresses to the global limit and a few blocked lines', async () => {
    for (let i = 0; i < REQUESTS; i++) await post({ password: 'guess' }, address(i));
    const lines = actions();
    expect(lines.filter((a) => a === 'admin.login_failed')).toHaveLength(50);
    expect(lines.filter((a) => a === 'admin.login_blocked').length).toBeLessThanOrEqual(10);
  });

  it('counts a signed-in user\'s refused Stalwart sign-ins in the same limits', async () => {
    mailbox.signedIn = true;
    for (let i = 0; i < REQUESTS; i++) await post({ stalwartAuth: true }, address(i));
    const lines = actions();
    expect(lines.filter((a) => a === 'admin.login_failed')).toHaveLength(50);
    expect(lines.length).toBeLessThanOrEqual(60);
  });

  it('still logs a failed password and lets the admin in afterwards', async () => {
    expect(await post({ password: 'guess' }, '203.0.113.9')).toBe(401);
    expect(auditLog).toHaveBeenCalledWith('admin.login_failed', expect.anything(), '203.0.113.9');
    expect(await post({ password: 'right-password' }, '203.0.113.9')).toBe(200);
    expect(auditLog).toHaveBeenCalledWith('admin.login', expect.anything(), '203.0.113.9');
  });
});
