import { describe, it, expect, vi, beforeEach } from 'vitest';

// The push names only the JMAP account id, and ids repeat: Stalwart numbers
// accounts alike on every install, and a group account is listed in the
// session of each member. When two signed-in logins could be the one the
// push is for, the preview must not pick one of them.

vi.mock('next/server', () => ({
  NextResponse: {
    json: (data: unknown, init?: { status?: number }) => ({
      json: async () => data,
      status: init?.status ?? 200,
    }),
  },
}));

vi.mock('next/headers', () => ({
  cookies: async () => ({ get: () => undefined }),
}));

vi.mock('@/lib/logger', () => ({
  logger: { warn: vi.fn(), error: vi.fn(), debug: vi.fn(), info: vi.fn() },
}));

vi.mock('@/lib/account-utils', () => ({ MAX_ACCOUNT_SLOTS: 3 }));

// slot 0: alice on one.example, slot 1: bob on two.example, slot 2: carol on one.example
const LOGINS = [
  { serverUrl: 'https://one.example', authHeader: 'Basic alice' },
  { serverUrl: 'https://two.example', authHeader: 'Basic bob' },
  { serverUrl: 'https://one.example', authHeader: 'Basic carol' },
];
vi.mock('@/lib/stalwart/auth-context', () => ({
  readStalwartAuthContextFromStore: (_store: unknown, slot: number) => LOGINS[slot] ?? null,
}));

vi.mock('@/lib/stalwart/credentials', () => ({
  getStalwartCredentials: vi.fn(),
}));

const session = (server: string, own: string, others: string[] = []) => ({
  apiUrl: `${server}/jmap/`,
  primaryAccounts: { 'urn:ietf:params:jmap:mail': own },
  accounts: Object.fromEntries([own, ...others].map((id) => [id, { name: id }])),
});
let SESSIONS: Record<string, unknown> = {};

const fetchJmapServer = vi.fn(async (url: string, init?: { headers?: Record<string, string>; body?: string }) => {
  const auth = init?.headers?.Authorization ?? '';
  const json = (data: unknown) => ({ ok: true, json: async () => data });
  if (url.endsWith('/.well-known/jmap')) return json(SESSIONS[auth]);
  const calls = (JSON.parse(init?.body ?? '{}') as { methodCalls: [string, Record<string, unknown>, string][] }).methodCalls;
  return json({
    methodResponses: calls.map(([name, , id]) => {
      if (name === 'Mailbox/query') return [name, { ids: ['inbox'] }, id];
      if (name === 'Email/query') return [name, { ids: ['e1'], total: 1 }, id];
      return [name, { list: [{ id: 'e1', threadId: 't1', subject: `mail of ${auth}` }] }, id];
    }),
  });
});
vi.mock('@/lib/stalwart/server-fetch', () => ({
  fetchJmapServer: (...args: Parameters<typeof fetchJmapServer>) => fetchJmapServer(...args),
  isTrustedJmapServerUrl: async () => true,
}));

vi.mock('@/lib/security/url-guard', () => ({
  DisallowedUrlError: class DisallowedUrlError extends Error {},
}));

async function callRoute(accountId: string) {
  const { GET } = await import('@/app/api/push/preview/route');
  const request = {
    nextUrl: { searchParams: { get: (k: string) => (k === 'accountId' ? accountId : k === 'emailId' ? 'e1' : null) } },
    headers: new Headers(),
  };
  const res = (await GET(request as unknown as Parameters<typeof GET>[0])) as unknown as {
    status: number;
    json: () => Promise<Record<string, unknown>>;
  };
  return { status: res.status, body: await res.json() };
}

const mailCalls = () => fetchJmapServer.mock.calls.filter(([url]) => !url.endsWith('/.well-known/jmap'));

describe('push preview when the account id is in more than one login', () => {
  beforeEach(() => {
    fetchJmapServer.mockClear();
  });

  it('shows no preview and names no login when two servers use the same id', async () => {
    SESSIONS = {
      'Basic alice': session('https://one.example', 'a'),
      'Basic bob': session('https://two.example', 'z'),
      'Basic carol': session('https://one.example', 'z'),
    };
    const { status, body } = await callRoute('z');

    // A non-2xx answer: the service worker shows its generic "New mail" and a
    // click opens the app in the login that is active, without switching.
    expect(status).toBeGreaterThanOrEqual(400);
    expect(body.email).toBeUndefined();
    expect(body.slot).toBeUndefined();
    expect(mailCalls()).toHaveLength(0);
  });

  it('shows no preview for a group account two signed-in members share', async () => {
    SESSIONS = {
      'Basic alice': session('https://one.example', 'a', ['g']),
      'Basic bob': session('https://two.example', 'b'),
      'Basic carol': session('https://one.example', 'c', ['g']),
    };
    const { status, body } = await callRoute('g');

    expect(status).toBeGreaterThanOrEqual(400);
    expect(body.slot).toBeUndefined();
    expect(mailCalls()).toHaveLength(0);
  });

  it('takes the one login whose own account it is over logins it is shared into', async () => {
    SESSIONS = {
      'Basic alice': session('https://one.example', 'a', ['c']),
      'Basic bob': session('https://two.example', 'b'),
      'Basic carol': session('https://one.example', 'c'),
    };
    const { status, body } = await callRoute('c');

    expect(status).toBe(200);
    expect(body.slot).toBe(2);
    expect(body.email).toMatchObject({ subject: 'mail of Basic carol' });
  });

  it('takes the only login that lists the account', async () => {
    SESSIONS = {
      'Basic alice': session('https://one.example', 'a', ['g']),
      'Basic bob': session('https://two.example', 'b'),
      'Basic carol': session('https://one.example', 'c'),
    };
    const { status, body } = await callRoute('g');

    expect(status).toBe(200);
    expect(body.slot).toBe(0);
  });
});
