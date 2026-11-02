import { describe, it, expect, vi, beforeEach } from 'vitest';

// Organisation > Devices > Push without sender and subject, held by the
// server: the preview route never reads the sender, subject or text of a
// message for a login the policy covers, so they can't reach the
// notification. Who is covered comes from the login's own JMAP session,
// with every non-personal account counted as a group.

vi.mock('next/server', () => ({
  NextResponse: {
    json: (data: unknown, init?: { status?: number }) => ({ json: async () => data, status: init?.status ?? 200 }),
  },
}));
vi.mock('next/headers', () => ({ cookies: async () => ({ get: () => undefined }) }));
vi.mock('@/lib/logger', () => ({ logger: { warn: vi.fn(), error: vi.fn(), debug: vi.fn(), info: vi.fn() } }));
vi.mock('@/lib/account-utils', () => ({ MAX_ACCOUNT_SLOTS: 1 }));

const login = vi.hoisted(() => ({ username: 'alice@example.org' }));
vi.mock('@/lib/stalwart/auth-context', () => ({
  readStalwartAuthContextFromStore: (_store: unknown, slot: number) =>
    slot === 0 ? { serverUrl: 'https://mail.example.org', authHeader: `Bearer ${login.username}`, username: login.username } : null,
}));
vi.mock('@/lib/stalwart/credentials', () => ({ getStalwartCredentials: vi.fn() }));

const policy = vi.hoisted(() => ({ current: {} as Record<string, unknown> }));
vi.mock('@/lib/admin/config-manager', () => ({
  configManager: { ensureLoaded: async () => {}, getPolicy: () => policy.current },
}));

const fetchJmapServer = vi.fn();
vi.mock('@/lib/stalwart/server-fetch', () => ({
  fetchJmapServer: (...args: unknown[]) => fetchJmapServer(...args),
  isTrustedJmapServerUrl: async () => true,
}));
vi.mock('@/lib/security/url-guard', () => ({ DisallowedUrlError: class DisallowedUrlError extends Error {} }));

import { DEFAULT_POLICY } from '@/lib/admin/types';
import { clearServerDeviceSubjects } from '@/lib/admin/server-device-policy';

const SESSION = {
  apiUrl: 'https://mail.example.org/jmap',
  primaryAccounts: { 'urn:ietf:params:jmap:mail': 'a' },
  accounts: { a: { name: 'alice@example.org', isPersonal: true }, g: { name: 'team@example.org', isPersonal: false } },
};

const json = (data: unknown) => ({ ok: true, json: async () => data, headers: new Headers() });

let emailGets: Array<Record<string, unknown>> = [];
/** Session reads after the first (the route's own) fail, as a server error would. */
let failSessionAfterFirst = false;
function mockJmap() {
  emailGets = [];
  let sessions = 0;
  fetchJmapServer.mockImplementation(async (url: string, init?: { body?: string }) => {
    if (url.endsWith('/.well-known/jmap') || url.endsWith('/jmap/session')) {
      sessions++;
      if (failSessionAfterFirst && sessions > 1) return { ok: false, status: 503, json: async () => ({}), headers: new Headers() };
      return json(SESSION);
    }
    const body = JSON.parse(init?.body ?? '{}') as { methodCalls: [string, Record<string, unknown>, string][] };
    if (body.methodCalls[0][0] === 'Mailbox/query') return json({ methodResponses: [['Mailbox/query', { ids: ['inbox'] }, 'mb']] });
    for (const call of body.methodCalls) if (call[0] === 'Email/get') emailGets.push(call[1]);
    // The server answers with everything, whatever was asked.
    return json({
      methodResponses: [
        ['Email/query', { ids: ['e1'], total: 1 }, 'eq'],
        ['Email/get', { list: [{ id: 'e1', threadId: 't1', subject: 'Salary list', preview: 'All salaries', from: [{ name: 'Boss', email: 'boss@example.org' }], receivedAt: '2026-11-01T10:00:00Z' }] }, 'eg'],
      ],
    });
  });
}

async function callRoute() {
  const { GET } = await import('@/app/api/push/preview/route');
  const request = { headers: new Headers(), nextUrl: { searchParams: { get: (k: string) => (k === 'accountId' ? 'a' : null) } } };
  const res = (await GET(request as unknown as Parameters<typeof GET>[0])) as unknown as { status: number; json: () => Promise<Record<string, unknown>> };
  return { status: res.status, body: await res.json() };
}

const withDevices = (devices: Record<string, boolean>, scope?: { domains?: string[]; groups?: string[] }) => {
  policy.current = scope
    ? { ...DEFAULT_POLICY, scopes: [{ id: 's', label: 'S', match: scope, policy: { organisation: { devices } } }] }
    : { ...DEFAULT_POLICY, organisation: { devices } };
};

describe('push preview under "Push without sender and subject"', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    clearServerDeviceSubjects();
    login.username = 'alice@example.org';
    mockJmap();
  });

  it('shows sender and subject when the policy is off', async () => {
    withDevices({ pushWithoutContent: false });
    const { body } = await callRoute();
    expect(body.redacted).toBeUndefined();
    expect(body.email).toMatchObject({ subject: 'Salary list', from: [{ email: 'boss@example.org' }] });
  });

  it('neither asks for nor returns sender, subject or text when it is on', async () => {
    withDevices({ pushWithoutContent: true });
    const { status, body } = await callRoute();
    expect(status).toBe(200);
    expect(body.redacted).toBe(true);
    expect(body.email).toEqual({ id: 'e1', threadId: 't1', receivedAt: '2026-11-01T10:00:00Z' });
    expect(emailGets.length).toBeGreaterThan(0);
    for (const get of emailGets) {
      expect(get.properties).not.toContain('from');
      expect(get.properties).not.toContain('subject');
      expect(get.properties).not.toContain('preview');
    }
  });

  it('applies a group scope from the login’s own session, counting every non-personal account', async () => {
    withDevices({ pushWithoutContent: true }, { groups: ['team@example.org'] });
    const { body } = await callRoute();
    expect(body.redacted).toBe(true);
    expect(JSON.stringify(body)).not.toContain('Salary');
  });

  it('applies a group scope’s switch when the session can’t be read, and asks again next time', async () => {
    withDevices({ pushWithoutContent: true }, { groups: ['other-team@example.org'] });
    failSessionAfterFirst = true;
    try {
      expect((await callRoute()).body.redacted).toBe(true);
    } finally {
      failSessionAfterFirst = false;
    }
    // The failed read wasn't kept: with the session back, alice isn't in that group.
    mockJmap();
    expect((await callRoute()).body.redacted).toBeUndefined();
  });

  it('leaves logins outside the scope alone', async () => {
    withDevices({ pushWithoutContent: true }, { domains: ['other.example'] });
    const { body } = await callRoute();
    expect(body.redacted).toBeUndefined();
    expect(body.email).toMatchObject({ subject: 'Salary list' });
  });
});
