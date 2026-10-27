import { describe, it, expect, vi, beforeEach } from 'vitest';

// Two logins in one browser: slot 0 is Bob, slot 1 is Alice, and Alice shares
// a folder with Bob. Alice's account is then listed in Bob's session too, but
// Bob sees only the shared folder - not her Inbox, nor the message that just
// arrived there.

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

const AUTH = ['Basic bob', 'Basic alice'];
vi.mock('@/lib/stalwart/auth-context', () => ({
  readStalwartAuthContextFromStore: (_store: unknown, slot: number) =>
    slot < 2 ? { serverUrl: 'https://mail.example.com', authHeader: AUTH[slot] } : null,
}));

vi.mock('@/lib/stalwart/credentials', () => ({
  getStalwartCredentials: vi.fn(),
}));

const SESSIONS: Record<string, unknown> = {
  'Basic bob': {
    apiUrl: 'https://mail.example.com/jmap/',
    primaryAccounts: { 'urn:ietf:params:jmap:mail': 'n' },
    accounts: { n: { name: 'bob@example.com' }, m: { name: 'alice@example.com' } },
  },
  'Basic alice': {
    apiUrl: 'https://mail.example.com/jmap/',
    primaryAccounts: { 'urn:ietf:params:jmap:mail': 'm' },
    accounts: { m: { name: 'alice@example.com' } },
  },
};

const NEW_MAIL = { id: 'e9', threadId: 't9', subject: 'For Alice', from: [{ email: 'carol@example.com' }] };

const fetchJmapServer = vi.fn(async (url: string, init?: { headers?: Record<string, string>; body?: string }) => {
  const auth = init?.headers?.Authorization ?? '';
  const json = (data: unknown) => ({ ok: true, json: async () => data });
  if (url.endsWith('/.well-known/jmap')) return json(SESSIONS[auth]);
  const isOwner = auth === 'Basic alice';
  const calls = (JSON.parse(init?.body ?? '{}') as { methodCalls: [string, Record<string, unknown>, string][] }).methodCalls;
  return json({
    methodResponses: calls.map(([name, , id]) => {
      if (name === 'Mailbox/query') return [name, { ids: isOwner ? ['inbox'] : [] }, id];
      if (name === 'Email/query') return [name, { ids: isOwner ? ['e9'] : [], total: isOwner ? 1 : 0 }, id];
      return [name, { list: isOwner ? [NEW_MAIL] : [], notFound: isOwner ? [] : ['e9'] }, id];
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

async function callRoute(accountId: string, emailId: string | null) {
  const { GET } = await import('@/app/api/push/preview/route');
  const request = {
    headers: new Headers(),
    nextUrl: { searchParams: { get: (k: string) => (k === 'accountId' ? accountId : k === 'emailId' ? emailId : null) } },
  };
  const res = (await GET(request as unknown as Parameters<typeof GET>[0])) as unknown as {
    status: number;
    json: () => Promise<Record<string, unknown>>;
  };
  return { status: res.status, body: await res.json() };
}

describe('push preview for an account shared into another login', () => {
  beforeEach(() => {
    fetchJmapServer.mockClear();
  });

  it.each([
    ['the delivered message', 'e9'],
    ['the newest unread Inbox message', null],
  ])('reads %s through the login that owns the account', async (_label, emailId) => {
    const { status, body } = await callRoute('m', emailId);

    expect(status).toBe(200);
    // Through Bob's login the preview came back empty, and the service worker
    // drops a push whose preview reports no mail: Alice got no notification.
    expect(body.email).toMatchObject({ id: 'e9' });
    expect(body.unreadTotal).toBe(1);
    expect(body.slot).toBe(1);
  });

  it('still resolves an account only another login shares in', async () => {
    const { status, body } = await callRoute('n', 'e9');
    expect(status).toBe(200);
    expect(body.slot).toBe(0);
  });
});
