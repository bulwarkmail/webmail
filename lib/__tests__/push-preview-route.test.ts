import { describe, it, expect, vi, beforeEach } from 'vitest';

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

vi.mock('@/lib/account-utils', () => ({ MAX_ACCOUNT_SLOTS: 2 }));

vi.mock('@/lib/stalwart/auth-context', () => ({
  readStalwartAuthContextFromStore: (_store: unknown, slot: number) =>
    slot === 0 ? { serverUrl: 'https://mail.example.com/', authHeader: 'Bearer tok' } : null,
}));

vi.mock('@/lib/stalwart/credentials', () => ({
  getStalwartCredentials: vi.fn(),
}));

const fetchJmapServer = vi.fn();
vi.mock('@/lib/stalwart/server-fetch', () => ({
  fetchJmapServer: (...args: unknown[]) => fetchJmapServer(...args),
  isTrustedJmapServerUrl: async () => true,
}));

vi.mock('@/lib/security/url-guard', () => ({
  DisallowedUrlError: class DisallowedUrlError extends Error {},
}));

function jsonResponse(data: unknown) {
  return { ok: true, json: async () => data };
}

const SESSION = {
  apiUrl: 'https://mail.example.com/jmap',
  primaryAccounts: { 'urn:ietf:params:jmap:mail': 'a' },
  accounts: { a: { name: 'me@example.com' }, g: { name: 'group@example.com' } },
};

function mockJmap() {
  fetchJmapServer.mockImplementation(async (url: string, init?: { body?: string }) => {
    if (url.endsWith('/.well-known/jmap')) return jsonResponse(SESSION);
    const body = JSON.parse(init?.body ?? '{}') as { methodCalls: [string, Record<string, unknown>, string][] };
    const first = body.methodCalls[0];
    if (first[0] === 'Mailbox/query') {
      return jsonResponse({ methodResponses: [['Mailbox/query', { ids: ['inbox'] }, 'mb']] });
    }
    return jsonResponse({
      methodResponses: [
        ['Email/query', { ids: ['e1'], total: 1 }, 'eq'],
        ['Email/get', { list: [{ id: 'e1', threadId: 't1', subject: 'Hi' }] }, 'eg'],
      ],
    });
  });
}

async function callRoute(accountId: string, emailId: string | null = null) {
  const { GET } = await import('@/app/api/push/preview/route');
  const request = {
    nextUrl: { searchParams: { get: (k: string) => (k === 'accountId' ? accountId : k === 'emailId' ? emailId : null) } },
  };
  const res = (await GET(request as unknown as Parameters<typeof GET>[0])) as unknown as {
    status: number;
    json: () => Promise<Record<string, unknown>>;
  };
  return { status: res.status, body: await res.json() };
}

describe('push preview route account resolution', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockJmap();
  });

  it('resolves the primary mail account', async () => {
    const { status } = await callRoute('a');
    expect(status).toBe(200);
  });

  it('resolves a shared/group account listed in session.accounts', async () => {
    const { status, body } = await callRoute('g');

    expect(status).not.toBe(401);
    expect(status).toBe(200);
    expect(body.email).toMatchObject({ id: 'e1' });

    // The Inbox lookup must be scoped to the shared account, not the primary.
    const mailboxQuery = fetchJmapServer.mock.calls
      .map(([, init]) => (init as { body?: string })?.body)
      .filter((b): b is string => typeof b === 'string')
      .map((b) => JSON.parse(b) as { methodCalls: [string, Record<string, unknown>, string][] })
      .find((b) => b.methodCalls[0][0] === 'Mailbox/query');
    expect(mailboxQuery?.methodCalls[0][1].accountId).toBe('g');
  });

  it('rejects an account the session does not know', async () => {
    const { status } = await callRoute('stranger');
    expect(status).toBe(401);
  });
});


describe('push preview JMAP failures', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockJmap();
  });

  it.each([
    ['error', { type: 'unsupportedFilter' }, 'mb'],
    ['Mailbox/query', {}, 'mb'],
  ])('does not silence a push when mailbox lookup fails (%s)', async (method, body, id) => {
    fetchJmapServer.mockReset()
      .mockResolvedValueOnce(jsonResponse(SESSION))
      .mockResolvedValueOnce(jsonResponse({ methodResponses: [[method, body, id]] }));
    expect((await callRoute('a')).status).toBe(502);
  });

  it.each([
    [['error', { type: 'serverFail' }, 'eq'], ['error', { type: 'resultReference' }, 'eg']],
    [['Email/query', { ids: ['e1'], total: 1 }, 'eq'], ['error', { type: 'serverFail' }, 'eg']],
    [['Email/query', { ids: [] }, 'eq'], ['Email/get', { list: [] }, 'eg']],
  ])('does not report zero unread on an email method failure', async (query, get) => {
    fetchJmapServer.mockReset()
      .mockResolvedValueOnce(jsonResponse(SESSION))
      .mockResolvedValueOnce(jsonResponse({ methodResponses: [['Mailbox/query', { ids: ['inbox'] }, 'mb']] }))
      .mockResolvedValueOnce(jsonResponse({ methodResponses: [query, get] }));
    expect((await callRoute('a')).status).toBe(502);
  });

  it('still reports genuinely empty unread results', async () => {
    fetchJmapServer.mockReset()
      .mockResolvedValueOnce(jsonResponse(SESSION))
      .mockResolvedValueOnce(jsonResponse({ methodResponses: [['Mailbox/query', { ids: ['inbox'] }, 'mb']] }))
      .mockResolvedValueOnce(jsonResponse({ methodResponses: [
        ['Email/query', { ids: [], total: 0 }, 'eq'],
        ['Email/get', { list: [] }, 'eg'],
      ] }));
    expect(await callRoute('a')).toEqual({ status: 200, body: { email: null, unreadTotal: 0 } });
  });
});


it('previews a delivered message outside an empty Inbox', async () => {
  fetchJmapServer.mockReset()
    .mockResolvedValueOnce(jsonResponse(SESSION))
    .mockResolvedValueOnce(jsonResponse({ methodResponses: [['Mailbox/query', { ids: ['inbox'] }, 'mb']] }))
    .mockResolvedValueOnce(jsonResponse({ methodResponses: [
      ['Email/query', { ids: [], total: 0 }, 'eq'],
      ['Email/get', { list: [] }, 'eg'],
      ['Email/get', { list: [{ id: 'filed', threadId: 't2' }] }, 'delivered'],
    ] }));
  expect(await callRoute('a', 'filed')).toEqual({
    status: 200, body: { email: { id: 'filed', threadId: 't2' }, unreadTotal: 1 },
  });
});
