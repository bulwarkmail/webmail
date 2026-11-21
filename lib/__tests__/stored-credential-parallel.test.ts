// @vitest-environment node
//
// The stored-credential budget holds against requests that overlap. Every
// cookie-authed route replays the context cookie's credential through
// fetchJmapServer, and Stalwart takes 50-500 ms to refuse a login: checking
// "refused?" first and recording the answer later let 25 requests at once
// with one stale credential reach the mail server 25 times, and 40 stale
// credentials at once pass the ceiling of 20. Now one request decides for a
// credential that hasn't worked lately, the others wait for its answer, and
// the ceiling counts requests in flight. A credential that works must not
// make a page's requests queue behind each other after the first answer.
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

vi.mock('@/lib/logger', () => ({ logger: { warn: vi.fn(), error: vi.fn(), debug: vi.fn(), info: vi.fn() } }));
vi.mock('@/lib/auth/session-secret', () => ({ getSessionSecret: () => 's'.repeat(64), hasSessionSecret: () => true }));
vi.mock('@/lib/admin/config-manager', () => ({
  configManager: {
    ensureLoaded: vi.fn().mockResolvedValue(undefined),
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
vi.mock('@/lib/admin/session', () => ({
  setAdminSessionCookie: vi.fn(),
  clearAdminSessionCookie: vi.fn(),
  requireAdminAuth: async () => ({ error: 'unauthorized' }),
  getClientIP: () => '203.0.113.7',
  isSameOriginRequest: () => true,
  getAdminDeviceId: async () => null,
  setAdminDeviceCookie: vi.fn(),
}));
vi.mock('@/lib/admin/audit', () => ({ auditLog: vi.fn() }));
const credential = vi.hoisted(() => ({ value: '' }));
vi.mock('@/lib/stalwart/credentials', () => ({
  getStalwartCredentials: async (request: Request) => ({
    serverUrl: 'https://mail.example.org',
    authHeader: request.headers.get('x-test-credential') ?? credential.value,
    username: 'user@example.org', accountName: 'user@example.org', hasSessionCookie: true, slot: 0, trusted: true,
  }),
}));

const SERVER = 'https://mail.example.org';
const basic = (password: string) => `Basic ${Buffer.from(`user@example.org:${password}`).toString('base64')}`;

/** The mail server: `good` works, everything else is refused, each answer after a short wait. */
interface Stub { sent: string[]; inFlight: number; maxInFlight: number; good: Set<string>; failNext: number }
let stub: Stub;

beforeEach(async () => {
  vi.resetModules();
  stub = { sent: [], inFlight: 0, maxInFlight: 0, good: new Set(), failNext: 0 };
  (await import('@/lib/stalwart/stored-credential-budget')).resetStoredCredentialBudgetForTests();
  vi.stubGlobal('fetch', vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
    const auth = new Headers(init?.headers).get('authorization') ?? '';
    stub.sent.push(auth);
    stub.inFlight++;
    stub.maxInFlight = Math.max(stub.maxInFlight, stub.inFlight);
    try {
      await new Promise((resolve) => setTimeout(resolve, 30));
      if (stub.failNext > 0) {
        stub.failNext--;
        throw new TypeError('fetch failed');
      }
      if (!stub.good.has(auth)) return new Response('', { status: 401 });
      if (String(url).endsWith('/.well-known/jmap')) return Response.json({ primaryAccounts: { 'urn:stalwart:jmap': 'a1' } });
      return Response.json({ methodResponses: [['x:Tenant/query', { ids: [] }, '0']] });
    } finally {
      stub.inFlight--;
    }
  }));
});

async function passthrough(auth: string): Promise<Response> {
  const { fetchJmapServer } = await import('@/lib/stalwart/server-fetch');
  return fetchJmapServer(`${SERVER}/jmap/`, { method: 'POST', headers: { Authorization: auth }, body: '{}' }, true);
}

describe('the stored-credential budget under requests that overlap', () => {
  it('sends a stale credential once when 25 requests carry it at the same time', async () => {
    const answers = await Promise.all(Array.from({ length: 25 }, () => passthrough(basic('revoked'))));
    expect(stub.sent).toHaveLength(1);
    expect(answers.every((res) => res.status === 401)).toBe(true);
  });

  it('keeps the ceiling of 20 when 40 stale credentials are sent at the same time', async () => {
    await Promise.all(Array.from({ length: 40 }, (_, i) => passthrough(basic(`revoked-${i}`))));
    expect(stub.sent).toHaveLength(20);
  });

  it('counts requests in flight with the refusals already recorded', async () => {
    const { recordStoredCredentialStatus } = await import('@/lib/stalwart/stored-credential-budget');
    for (let i = 0; i < 18; i++) await recordStoredCredentialStatus(basic(`earlier-${i}`), 401);
    await Promise.all(Array.from({ length: 10 }, (_, i) => passthrough(basic(`burst-${i}`))));
    expect(stub.sent).toHaveLength(2);
  });

  it('gives a place back when the answer is not a refusal', async () => {
    for (let i = 0; i < 25; i++) stub.good.add(basic(`works-${i}`));
    await Promise.all(Array.from({ length: 25 }, (_, i) => passthrough(basic(`works-${i}`))));
    // Every one was answered, and the ceiling still has all its room for stale ones.
    await Promise.all(Array.from({ length: 30 }, (_, i) => passthrough(basic(`revoked-${i}`))));
    expect(stub.sent).toHaveLength(25 + 20);
  });

  it('lets the others go when the deciding request gets no answer at all', async () => {
    const auth = basic('server-down-for-a-moment');
    stub.good.add(auth);
    stub.failNext = 1;
    const answers = await Promise.allSettled(Array.from({ length: 6 }, () => passthrough(auth)));
    expect(answers.filter((a) => a.status === 'rejected')).toHaveLength(1);
    expect(answers.filter((a) => a.status === 'fulfilled' && a.value.status === 200)).toHaveLength(5);
    // The five went out together after the first failed, not one after another.
    expect(stub.maxInFlight).toBe(5);
  });
});

describe('honest use: a page firing several requests with a good cookie', () => {
  it('waits for the first answer once, then sends the rest side by side', async () => {
    const auth = basic('the-right-password');
    stub.good.add(auth);
    const answers = await Promise.all(Array.from({ length: 8 }, () => passthrough(auth)));
    expect(answers.every((res) => res.status === 200)).toBe(true);
    expect(stub.sent).toHaveLength(8);
    // One request first, then the other seven at once.
    expect(stub.maxInFlight).toBe(7);
  });

  it('sends every request at once when the credential worked lately (a page load after sign-in)', async () => {
    const auth = basic('the-right-password');
    stub.good.add(auth);
    const { recordStoredCredentialStatus } = await import('@/lib/stalwart/stored-credential-budget');
    await recordStoredCredentialStatus(auth, 200);
    await Promise.all(Array.from({ length: 8 }, () => passthrough(auth)));
    expect(stub.maxInFlight).toBe(8);
    stub.maxInFlight = 0;
    await Promise.all(Array.from({ length: 12 }, () => passthrough(auth)));
    expect(stub.maxInFlight).toBe(12);
  });
});

describe('the admin status check under requests that overlap', () => {
  async function adminStatus(auth?: string) {
    const { GET } = await import('@/app/api/admin/auth/route');
    const res = await GET(new NextRequest('https://webmail.example/api/admin/auth', {
      headers: { 'X-JMAP-Cookie-Slot': '0', ...(auth ? { 'x-test-credential': auth } : {}) },
    }));
    return (await res.json()) as { stalwartAdmin: boolean };
  }

  it('sends one stale credential once, however many status checks run at the same time', async () => {
    credential.value = basic('revoked-app-password');
    await Promise.all(Array.from({ length: 25 }, () => adminStatus()));
    expect(stub.sent).toHaveLength(1);
  });

  it('keeps the ceiling when 40 stale credentials are checked at the same time', async () => {
    await Promise.all(Array.from({ length: 40 }, (_, i) => adminStatus(basic(`revoked-${i}`))));
    expect(stub.sent.length).toBeLessThanOrEqual(20);
  });

  it('does not remember the budget\'s own refusal as "not an admin" (control: the admin is found once there is room)', async () => {
    const admin = basic('admin-password');
    stub.good.add(admin);
    const { recordStoredCredentialStatus } = await import('@/lib/stalwart/stored-credential-budget');
    for (let i = 0; i < 20; i++) await recordStoredCredentialStatus(basic(`elsewhere-${i}`), 401);
    expect((await adminStatus(admin)).stalwartAdmin).toBe(false);
    expect(stub.sent).toHaveLength(0);
    // The window ends: room again, and the next check asks.
    (await import('@/lib/stalwart/stored-credential-budget')).resetStoredCredentialBudgetForTests();
    expect((await adminStatus(admin)).stalwartAdmin).toBe(true);
  });
});
