import { describe, it, expect, vi, beforeEach } from 'vitest';

// Admin password login allows 50 attempts across all clients per 15 minutes,
// because a client without a proxy in front can make up its X-Forwarded-For
// address. Anyone could spend that budget and lock every admin out. A browser
// an admin signed in from before carries a device cookie and is limited on
// its own (OWASP device cookies), so it still gets in.

vi.mock('next/server', () => ({
  NextResponse: {
    json: (data: unknown, init?: { status?: number }) => ({ json: async () => data, status: init?.status ?? 200 }),
  },
}));

// One cookie jar per browser; `current` is the browser making the request.
const browsers = { current: new Map<string, string>() };
vi.mock('next/headers', () => ({
  cookies: async () => ({
    get: (name: string) => (browsers.current.has(name) ? { name, value: browsers.current.get(name)! } : undefined),
    set: (name: string, value: string) => { browsers.current.set(name, value); },
    delete: (name: string) => { browsers.current.delete(name); },
  }),
}));

vi.mock('@/lib/logger', () => ({ logger: { warn: vi.fn(), error: vi.fn(), debug: vi.fn(), info: vi.fn() } }));
vi.mock('@/lib/admin/audit', () => ({ auditLog: vi.fn() }));
vi.mock('@/lib/security/same-origin', () => ({ isSameOriginRequest: () => true }));
vi.mock('@/lib/admin/config-manager', () => ({
  configManager: { ensureLoaded: vi.fn(), get: (_key: string, fallback?: unknown) => fallback },
}));
vi.mock('@/lib/stalwart/credentials', () => ({ getStalwartCredentials: async () => null }));
vi.mock('@/lib/admin/stalwart-admin-access', () => ({ getStalwartAdminAccessMode: async () => 'password' }));
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
  // Fresh rate limiter state for every test. The counters live in the
  // store on globalThis now, not in the module.
  vi.resetModules();
  (await import('@/lib/shared-store/local')).resetLocalStoreForTests();
  ({ POST } = await import('@/app/api/admin/auth/route'));
});

async function login(browser: Map<string, string>, password: string, ip: string): Promise<number> {
  browsers.current = browser;
  const request = new Request('https://bulwark.example/api/admin/auth', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-forwarded-for': ip },
    body: JSON.stringify({ password }),
  });
  const response = await POST(request as never);
  return response.status;
}

/** Wrong passwords from 50 made-up addresses: the whole shared budget. */
async function spendSharedBudget() {
  const attacker = new Map<string, string>();
  for (let i = 0; i < 50; i++) await login(attacker, 'guess', `198.51.100.${i}`);
  expect(await login(attacker, 'guess', '198.51.100.200')).toBe(429);
}

describe('admin login device cookie', () => {
  it('lets a browser an admin signed in from before in after others spent the shared budget', async () => {
    const admin = new Map<string, string>();
    expect(await login(admin, 'right-password', '203.0.113.7')).toBe(200);
    expect(admin.has('admin_device')).toBe(true);

    await spendSharedBudget();

    expect(await login(admin, 'right-password', '203.0.113.7')).toBe(200);
  });

  it('still blocks a new browser once the shared budget is spent', async () => {
    await spendSharedBudget();
    expect(await login(new Map(), 'right-password', '203.0.113.8')).toBe(429);
  });

  it('limits a device on its own to 5 attempts', async () => {
    const admin = new Map<string, string>();
    expect(await login(admin, 'right-password', '203.0.113.7')).toBe(200);
    for (let i = 0; i < 5; i++) expect(await login(admin, 'wrong', `192.0.2.${i}`)).toBe(401);
    expect(await login(admin, 'right-password', '192.0.2.99')).toBe(429);
  });

  it('does not take an admin session token as a device cookie', async () => {
    const { createAdminSession, createAdminDeviceToken, verifyAdminDeviceToken, verifyAdminSession } = await import('@/lib/admin/session');
    expect(verifyAdminDeviceToken(createAdminSession())).toBeNull();
    expect(verifyAdminSession(createAdminDeviceToken())).toBeNull();
    expect(verifyAdminDeviceToken(createAdminDeviceToken())).toEqual(expect.any(String));

    await spendSharedBudget();
    const forged = new Map([['admin_device', createAdminSession()]]);
    expect(await login(forged, 'right-password', '203.0.113.9')).toBe(429);
  });
});
