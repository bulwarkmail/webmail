// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

// /api/admin/auth asks the mail server whether the signed-in user is a
// Stalwart superuser, with the credential from the context cookie, like every
// other cookie-authed route. So it goes through the same failure budget
// (lib/stalwart/stored-credential-budget.ts): a credential the mail server
// refused is not sent again, a refusal seen here is recorded for the other
// routes, the ceiling across all credentials holds, and the client's address
// travels upstream. Every refusal is a failed login at the mail server, which
// bans the address they come from once there are enough.

vi.mock('@/lib/logger', () => ({
  logger: { warn: vi.fn(), error: vi.fn(), debug: vi.fn(), info: vi.fn() },
}));
vi.mock('@/lib/auth/session-secret', () => ({
  getSessionSecret: () => 's'.repeat(64),
  hasSessionSecret: () => true,
}));
vi.mock('@/lib/admin/config-manager', () => ({
  configManager: {
    ensureLoaded: vi.fn().mockResolvedValue(undefined),
    // Defaults: stalwartAdminAccess = auto, allowCustomJmapEndpoint = false.
    // The instance's own server is the one asked.
    get: (key: string, fallback?: unknown) => (key === 'jmapServerUrl' ? 'https://mail.example.org' : fallback),
  },
}));
vi.mock('@/lib/admin/password', () => ({
  initAdminPassword: vi.fn().mockResolvedValue(true),
  isAdminEnabled: () => true,
  verifyAdminPassword: vi.fn(),
  updateLastLogin: vi.fn(),
  getAdminMeta: () => null,
}));
const setAdminSessionCookie = vi.fn();
vi.mock('@/lib/admin/session', () => ({
  setAdminSessionCookie: (...args: unknown[]) => setAdminSessionCookie(...args),
  clearAdminSessionCookie: vi.fn(),
  requireAdminAuth: async () => ({ error: 'unauthorized' }),
  getClientIP: () => '203.0.113.7',
  isSameOriginRequest: () => true,
  getAdminDeviceId: async () => null,
  setAdminDeviceCookie: vi.fn(),
}));
vi.mock('@/lib/admin/rate-limit', () => ({
  checkRateLimit: () => ({ allowed: true, retryAfterMs: 0 }),
  checkDeviceRateLimit: () => ({ allowed: true, retryAfterMs: 0 }),
}));
vi.mock('@/lib/admin/audit', () => ({ auditLog: vi.fn() }));

const SERVER = 'https://mail.example.org';
const current = { authHeader: '' };
vi.mock('@/lib/stalwart/credentials', () => ({
  getStalwartCredentials: async () => ({
    serverUrl: SERVER,
    authHeader: current.authHeader,
    username: 'user@example.org',
    accountName: 'user@example.org',
    hasSessionCookie: true,
    slot: 0,
    trusted: true,
  }),
}));

interface Seen { url: string; auth: string | null; forwardedFor: string | null }

/** A mail server that refuses every credential, and notes what it was asked. */
function refusingMailServer(): Seen[] {
  const seen: Seen[] = [];
  vi.stubGlobal('fetch', vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
    const headers = new Headers(init?.headers);
    seen.push({ url: String(url), auth: headers.get('authorization'), forwardedFor: headers.get('x-forwarded-for') });
    return new Response('{"type":"about:blank","status":401}', { status: 401 });
  }));
  return seen;
}

/** A mail server where the credential belongs to the server-wide superuser. */
function superuserMailServer(): Seen[] {
  const seen: Seen[] = [];
  vi.stubGlobal('fetch', vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
    const headers = new Headers(init?.headers);
    seen.push({ url: String(url), auth: headers.get('authorization'), forwardedFor: headers.get('x-forwarded-for') });
    if (String(url).endsWith('/.well-known/jmap')) {
      return Response.json({ primaryAccounts: { 'urn:stalwart:jmap': 'a1' } });
    }
    return Response.json({ methodResponses: [['x:Tenant/query', { ids: [] }, '0']] });
  }));
  return seen;
}

const basic = (password: string) => `Basic ${Buffer.from(`user@example.org:${password}`).toString('base64')}`;

async function adminStatus() {
  const { GET } = await import('@/app/api/admin/auth/route');
  const res = await GET(new NextRequest('https://webmail.example/api/admin/auth', { headers: { 'X-JMAP-Cookie-Slot': '0' } }));
  return { status: res.status, body: await res.json() };
}

async function stalwartSignIn() {
  const { POST } = await import('@/app/api/admin/auth/route');
  const res = await POST(new NextRequest('https://webmail.example/api/admin/auth', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'X-JMAP-Cookie-Slot': '0' },
    body: JSON.stringify({ stalwartAuth: true }),
  }));
  return res.status;
}

describe('/api/admin/auth and the stored-credential budget', () => {
  beforeEach(async () => {
    vi.resetModules();
    vi.unstubAllGlobals();
    setAdminSessionCookie.mockClear();
    const { resetStoredCredentialBudgetForTests } = await import('@/lib/stalwart/stored-credential-budget');
    resetStoredCredentialBudgetForTests();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('does not send a credential the mail server already refused', async () => {
    const seen = refusingMailServer();
    current.authHeader = basic('changed-since');
    const { recordStoredCredentialStatus, isStoredCredentialRefused } = await import('@/lib/stalwart/stored-credential-budget');
    await recordStoredCredentialStatus(current.authHeader, 401);
    expect(await isStoredCredentialRefused(current.authHeader)).toBe(true);

    const res = await adminStatus();
    expect(res.status).toBe(200);
    expect(res.body.stalwartAdmin).toBe(false);
    expect(seen).toEqual([]);
  });

  it('does not send it for a Stalwart sign-in to the console either', async () => {
    const seen = refusingMailServer();
    current.authHeader = basic('changed-since-too');
    const { recordStoredCredentialStatus } = await import('@/lib/stalwart/stored-credential-budget');
    await recordStoredCredentialStatus(current.authHeader, 401);

    expect(await stalwartSignIn()).toBe(403);
    expect(seen).toEqual([]);
    expect(setAdminSessionCookie).not.toHaveBeenCalled();
  });

  it('records a refusal it sees, so the credential is not tried again elsewhere', async () => {
    refusingMailServer();
    current.authHeader = basic('revoked-app-password');
    const { isStoredCredentialRefused } = await import('@/lib/stalwart/stored-credential-budget');

    await adminStatus();
    expect(await isStoredCredentialRefused(current.authHeader)).toBe(true);
  });

  it('stops asking once the failure ceiling across all credentials is reached', async () => {
    const seen = refusingMailServer();
    // 40 stale credentials (revoked app passwords, say), one status check each.
    for (let i = 0; i < 40; i++) {
      current.authHeader = basic(`revoked-${i}`);
      await adminStatus();
    }
    // The budget's ceiling is 20 refusals per 15 minutes.
    expect(seen.length).toBeLessThanOrEqual(20);
  });

  it('answers "not an admin" without asking when other routes reached the ceiling', async () => {
    const { recordStoredCredentialStatus } = await import('@/lib/stalwart/stored-credential-budget');
    for (let i = 0; i < 20; i++) await recordStoredCredentialStatus(basic(`stale-elsewhere-${i}`), 401);
    const seen = superuserMailServer();
    current.authHeader = basic('never-asked-before');

    const res = await adminStatus();
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ stalwartAdmin: false, stalwartAutoLogin: false });
    expect(seen).toEqual([]);
  });

  it('names the client address to the mail server and still finds a superuser', async () => {
    const seen = superuserMailServer();
    current.authHeader = basic('the-right-password');

    const res = await adminStatus();
    expect(res.body).toMatchObject({ stalwartAdmin: true, stalwartAutoLogin: true });
    expect(seen.map((s) => s.url)).toEqual([`${SERVER}/.well-known/jmap`, `${SERVER}/jmap/`]);
    expect(seen.every((s) => s.forwardedFor === '203.0.113.7')).toBe(true);
    expect(seen.every((s) => s.auth === current.authHeader)).toBe(true);
  });

  it('remembers a refusal longer than a minute, also for a token the budget does not count', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const seen = refusingMailServer();
    current.authHeader = 'Bearer an-expired-access-token';

    await adminStatus();
    expect(seen).toHaveLength(1);
    vi.setSystemTime(Date.now() + 5 * 60_000);
    await adminStatus();
    expect(seen).toHaveLength(1);
    vi.setSystemTime(Date.now() + 11 * 60_000);
    await adminStatus();
    expect(seen).toHaveLength(2);
  });

  it('asks again about a superuser after a minute (control)', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const seen = superuserMailServer();
    current.authHeader = 'Bearer a-valid-access-token';

    await adminStatus();
    vi.setSystemTime(Date.now() + 61_000);
    await adminStatus();
    expect(seen.filter((s) => s.url.endsWith('/.well-known/jmap'))).toHaveLength(2);
  });

  it('forgets a remembered refusal once a sign-in with the same credential worked', async () => {
    let refuseAll = true;
    vi.stubGlobal('fetch', vi.fn(async (url: RequestInfo | URL) => {
      if (refuseAll) return new Response('', { status: 401 });
      if (String(url).endsWith('/.well-known/jmap')) return Response.json({ primaryAccounts: { 'urn:stalwart:jmap': 'a1' } });
      return Response.json({ methodResponses: [['x:Tenant/query', { ids: [] }, '0']] });
    }));
    current.authHeader = basic('the-admins-password');
    // A passing refusal (the directory behind the mail server was down, say).
    expect((await adminStatus()).body.stalwartAdmin).toBe(false);
    refuseAll = false;
    // Without a new sign-in the refusal is still remembered.
    expect((await adminStatus()).body.stalwartAdmin).toBe(false);
    // The admin signs in again with the same password: the sign-in records it as working.
    const { recordStoredCredentialStatus } = await import('@/lib/stalwart/stored-credential-budget');
    await recordStoredCredentialStatus(current.authHeader, 200);
    expect((await adminStatus()).body.stalwartAdmin).toBe(true);
  });
});
