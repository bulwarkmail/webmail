import { describe, it, expect, vi, beforeEach } from 'vitest';
import { endlessResponse } from './helpers/endless-body';
import { loginFingerprint } from '@/lib/pwa-notify/login-fingerprint';
import { DEFAULT_POLICY } from '@/lib/admin/types';

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

vi.mock('@/lib/stalwart/auth-context', () => {
  const read = (_store: unknown, slot: number) =>
    slot === 0 ? { serverUrl: 'https://mail.example.com/', authHeader: 'Bearer tok' } : null;
  return { readStalwartAuthContextFromStore: read, readCurrentStalwartAuthContext: async (store: unknown, slot: number) => read(store, slot) };
});

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

// The route reads the device policy (Organisation > Devices); none is set
// here, except where a test says so.
const devicePolicy = vi.hoisted(() => ({ current: null as Record<string, unknown> | null }));
vi.mock('@/lib/admin/config-manager', async () => {
  const { DEFAULT_POLICY } = await import('@/lib/admin/types');
  return { configManager: { ensureLoaded: async () => {}, getPolicy: () => devicePolicy.current ?? DEFAULT_POLICY } };
});

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

async function callRoute(accountId: string, emailId: string | null = null, extra: Record<string, string> = {}) {
  const { GET } = await import('@/app/api/push/preview/route');
  const request = {
    headers: new Headers(),
    nextUrl: { searchParams: { get: (k: string) => (k === 'accountId' ? accountId : k === 'emailId' ? emailId : extra[k] ?? null) } },
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

  it('names the login for a message, as the action route knows it', async () => {
    const { body } = await callRoute('a');
    expect(body.login).toBe(await loginFingerprint('https://mail.example.com', undefined));
  });

  it('names the login (cookie slot) the account belongs to', async () => {
    // The worker only knows the JMAP account id, which can repeat across
    // servers; the click must open the message in this login.
    const { body } = await callRoute('a');
    expect(body.slot).toBe(0);
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
    expect(await callRoute('a')).toEqual({ status: 200, body: { email: null, unreadTotal: 0, inboxUnread: 0, slot: 0 } });
  });

  // `total` is optional in a JMAP Email/query response.
  it('counts the ids when the server leaves out the total', async () => {
    fetchJmapServer.mockReset()
      .mockResolvedValueOnce(jsonResponse(SESSION))
      .mockResolvedValueOnce(jsonResponse({ methodResponses: [['Mailbox/query', { ids: ['inbox'] }, 'mb']] }))
      .mockResolvedValueOnce(jsonResponse({ methodResponses: [
        ['Email/query', { ids: [] }, 'eq'],
        ['Email/get', { list: [] }, 'eg'],
      ] }));
    // No Inbox count for the app badge: the ids stop at the query's limit.
    expect(await callRoute('a')).toEqual({ status: 200, body: { email: null, unreadTotal: 0, slot: 0 } });
  });

  it('previews the named message even when the Inbox lookups fail', async () => {
    fetchJmapServer.mockReset()
      .mockResolvedValueOnce(jsonResponse(SESSION))
      .mockResolvedValueOnce(jsonResponse({ methodResponses: [['Mailbox/query', { ids: ['inbox'] }, 'mb']] }))
      .mockResolvedValueOnce(jsonResponse({ methodResponses: [
        ['error', { type: 'serverFail' }, 'eq'],
        ['error', { type: 'resultReference' }, 'eg'],
        ['Email/get', { list: [{ id: 'd', threadId: 'td' }] }, 'delivered'],
      ] }));
    expect(await callRoute('a', 'd')).toEqual({
      status: 200, body: { email: { id: 'd', threadId: 'td' }, unreadTotal: 1, slot: 0, login: expect.any(String) },
    });
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
    // The app badge gets the Inbox as it is; the message filed elsewhere isn't in it.
    status: 200, body: { email: { id: 'filed', threadId: 't2' }, unreadTotal: 1, inboxUnread: 0, slot: 0, login: expect.any(String) },
  });
});

it('names no message when the delivered one cannot be read, rather than another', async () => {
  // The push named a message - deleted since, or filed where this login
  // cannot see it - and the Inbox happens to hold an older unread one. That
  // older message is not what arrived.
  fetchJmapServer.mockReset()
    .mockResolvedValueOnce(jsonResponse(SESSION))
    .mockResolvedValueOnce(jsonResponse({ methodResponses: [['Mailbox/query', { ids: ['inbox'] }, 'mb']] }))
    .mockResolvedValueOnce(jsonResponse({ methodResponses: [
      ['Email/query', { ids: ['stale'], total: 3 }, 'eq'],
      ['Email/get', { list: [{ id: 'stale', threadId: 't9' }] }, 'eg'],
      ['Email/get', { list: [] }, 'delivered'],
    ] }));
  expect(await callRoute('a', 'gone')).toEqual({
    status: 200, body: { email: null, unreadTotal: 3, inboxUnread: 3, slot: 0 },
  });
});

it('sends the method calls to the server address it was configured with, not the public one', async () => {
  // Stalwart advertises its own public hostname in apiUrl, which the webmail
  // may not reach when it talks to the server over an internal address (#627).
  fetchJmapServer.mockReset();
  mockJmap();
  const session = { ...SESSION, apiUrl: 'https://public.example.org/jmap/' };
  const reply = fetchJmapServer.getMockImplementation()!;
  fetchJmapServer.mockImplementation(async (url: string, init?: { body?: string }) =>
    url.endsWith('/.well-known/jmap') ? jsonResponse(session) : reply(url, init));

  expect((await callRoute('a')).status).toBe(200);
  const posted = fetchJmapServer.mock.calls.map(([url]) => url).filter((url) => !url.endsWith('/.well-known/jmap'));
  expect(posted).toEqual(['https://mail.example.com/jmap/', 'https://mail.example.com/jmap/']);
});

it('answers 502 instead of buffering a mailbox answer that never ends', async () => {
  fetchJmapServer.mockReset();
  mockJmap();
  const reply = fetchJmapServer.getMockImplementation()!;
  const endless = endlessResponse(500);
  fetchJmapServer.mockImplementation(async (url: string, init?: { body?: string }) =>
    url.endsWith('/.well-known/jmap') ? reply(url, init) : endless.response);

  expect((await callRoute('a')).status).toBe(502);
  expect(endless.pulled()).toBeLessThan(10);
});


// ── Team notes ───────────────────────────────────────────────────────────
// A note in a group account wakes every member's push (Stalwart 0.16 sends a
// plain state change for it). Only the members it mentions hear of it; for
// everyone else it is nothing, and never mail.

type Stored = Record<string, unknown> & {
  id: string; accountId: string; receivedAt: string;
  mailboxIds: Record<string, boolean>; keywords: Record<string, boolean>;
};
type Call = [string, Record<string, unknown>, string];

const ago = (ms: number) => new Date(Date.now() - ms).toISOString();
let store: Stored[] = [];
let threads: Record<string, string[]> = {};
let sent: Call[][] = [];

function matches(email: Stored, filter: Record<string, unknown>): boolean {
  if (filter.operator === 'AND') return (filter.conditions as Record<string, unknown>[]).every((c) => matches(email, c));
  if ('inMailbox' in filter) return email.mailboxIds[filter.inMailbox as string] === true;
  if ('hasKeyword' in filter) return email.keywords[filter.hasKeyword as string] === true;
  if ('notKeyword' in filter) return email.keywords[filter.notKeyword as string] !== true;
  if ('after' in filter) return Date.parse(email.receivedAt) > Date.parse(filter.after as string);
  throw new Error(`Filter not known to the fake: ${JSON.stringify(filter)}`);
}

function mockTeamServer() {
  sent = [];
  fetchJmapServer.mockImplementation(async (url: string, init?: { body?: string }) => {
    if (url.endsWith('/.well-known/jmap')) return jsonResponse(SESSION);
    const calls = (JSON.parse(init?.body ?? '{}') as { methodCalls: Call[] }).methodCalls;
    sent.push(calls);
    const results = new Map<string, Record<string, unknown>>();
    const refIds = (ref: { resultOf: string; path: string }): string[] => {
      const result = results.get(ref.resultOf);
      if (ref.path === '/ids') return (result?.ids as string[]) ?? [];
      if (ref.path === '/list/*/emailIds') return ((result?.list as { emailIds: string[] }[]) ?? []).flatMap((t) => t.emailIds);
      throw new Error(`Path not known to the fake: ${ref.path}`);
    };
    const methodResponses = calls.map(([name, args, id]) => {
      let result: Record<string, unknown>;
      if (name === 'Mailbox/query') {
        result = { ids: ['inbox'] };
      } else if (name === 'Email/query') {
        const found = store
          .filter((e) => e.accountId === args.accountId && matches(e, args.filter as Record<string, unknown>))
          .sort((x, y) => Date.parse(y.receivedAt) - Date.parse(x.receivedAt));
        result = { ids: found.slice(0, (args.limit as number) ?? 100).map((e) => e.id), ...(args.calculateTotal ? { total: found.length } : {}) };
      } else if (name === 'Email/get') {
        const ids = (args.ids as string[]) ?? refIds(args['#ids'] as { resultOf: string; path: string });
        const properties = args.properties as string[];
        result = {
          list: ids
            .map((wanted) => store.find((e) => e.id === wanted && e.accountId === args.accountId))
            .filter((e): e is Stored => !!e)
            .map((e) => Object.fromEntries(properties.filter((p) => p in e).map((p) => [p, e[p]]))),
        };
      } else if (name === 'Thread/get') {
        result = { list: (args.ids as string[]).filter((t) => threads[t]).map((t) => ({ id: t, emailIds: threads[t] })) };
      } else {
        throw new Error(`Method not known to the fake: ${name}`);
      }
      results.set(id, result);
      return [name, result, id];
    });
    return jsonResponse({ methodResponses });
  });
}

function note(id: string, opts: { kind?: string; mentions?: string[]; age?: number } = {}): Stored {
  const mentions = opts.mentions ?? ['a'];
  const kind = opts.kind ?? 'note';
  const keywords: Record<string, boolean> = { $seen: true, '$bulwark-note': true };
  for (const m of mentions) keywords[`$bulwark-mention-${m}`] = true;
  return {
    id, accountId: 'g', threadId: `own-${id}`, receivedAt: ago(opts.age ?? 20_000),
    mailboxIds: { notes: true }, keywords,
    from: [{ name: 'Mabel', email: 'mabel@example.com' }],
    subject: 'Note: Offer for the Mulberry project',
    preview: 'Waiting for the signed copy',
    messageId: [`${id}@notes.bulwark.invalid`],
    'header:X-Bulwark-Note-For:asText': ' <offer@client.example>',
    'header:X-Bulwark-Note-Thread:asText': 'T1',
    'header:X-Bulwark-Note-Kind:asText': kind,
    'header:X-Bulwark-Note-Mentions:asText': mentions.join(', '),
  };
}

function mail(id: string, opts: { account?: string; age?: number; seen?: boolean; messageId?: string; threadId?: string } = {}): Stored {
  return {
    id, accountId: opts.account ?? 'g', threadId: opts.threadId ?? `t-${id}`, receivedAt: ago(opts.age ?? 2 * 86_400_000),
    mailboxIds: { inbox: true }, keywords: opts.seen ? { $seen: true } : {},
    from: [{ name: 'Client', email: 'client@example.com' }], subject: `Mail ${id}`, preview: `Text of ${id}`,
    messageId: [opts.messageId ?? `${id}@client.example`],
  };
}

const MENTION = {
  noteId: 'n1', threadId: 'T1', forKey: 'offer@client.example', emailId: 'offer',
  from: 'Mabel', subject: 'Offer for the Mulberry project',
};

const emailGets = () => sent.flat().filter(([name]) => name === 'Email/get').map(([, args]) => args.properties as string[]);
const contentProperties = (properties: string[]) => properties.filter((p) => ['from', 'subject', 'preview'].includes(p));

describe('push preview for team notes', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    devicePolicy.current = null;
    // The message the notes are about, a later reply in its conversation, and an old unread mail.
    store = [
      mail('offer', { messageId: 'offer@client.example', threadId: 'T1', seen: true }),
      mail('reply', { threadId: 'T1', seen: true, age: 86_400_000 }),
      mail('old-unread'),
    ];
    threads = { T1: ['offer', 'reply'] };
    mockTeamServer();
  });

  describe('a push that names the note', () => {
    it('tells the member it mentions, and opens the message it is about', async () => {
      store.push(note('n1', { mentions: ['a', 'b'] }));
      expect(await callRoute('g', 'n1')).toEqual({ status: 200, body: { skip: true, mention: MENTION, slot: 0, login: expect.any(String) } });
    });

    it("opens the conversation's newest message when none has the Message-ID", async () => {
      store = store.filter((e) => e.id !== 'offer');
      threads = { T1: ['reply'] };
      store.push(note('n1'));
      expect((await callRoute('g', 'n1')).body.mention).toMatchObject({ noteId: 'n1', emailId: 'reply' });
    });

    it("is nothing for a member it doesn't mention", async () => {
      store.push(note('n1', { mentions: ['b'] }));
      expect(await callRoute('g', 'n1')).toEqual({ status: 200, body: { skip: true } });
    });

    it('takes the exact id: "ab" is not "a"', async () => {
      store.push(note('n1', { mentions: ['ab', 'ba'] }));
      expect((await callRoute('g', 'n1')).body).toEqual({ skip: true });
    });

    it('is nothing for a timeline entry, even one that names the user', async () => {
      store.push(note('n1', { kind: 'assigned', mentions: ['a'] }));
      expect((await callRoute('g', 'n1')).body).toEqual({ skip: true });
    });

    it('leaves out sender and subject under "Push without sender and subject"', async () => {
      devicePolicy.current = { ...DEFAULT_POLICY, organisation: { devices: { pushWithoutContent: true } } };
      store.push(note('n1'));
      const { body } = await callRoute('g', 'n1');
      const { from: _from, subject: _subject, ...withoutContent } = MENTION;
      expect(body).toEqual({ skip: true, mention: withoutContent, redacted: true, slot: 0, login: expect.any(String) });
      expect(JSON.stringify(body)).not.toMatch(/Mabel|Mulberry|signed copy/);
      for (const properties of emailGets()) expect(contentProperties(properties)).toEqual([]);
    });
  });

  describe('a state change (no message named)', () => {
    it('answers the newest fresh note that mentions the user, then the mail as before', async () => {
      store.push(note('n0', { age: 5 * 60_000 }), note('n1', { age: 3 * 60_000 }), note('other', { mentions: ['b'], age: 2 * 60_000 }));
      const { body } = await callRoute('g');
      expect(body).toMatchObject({ mention: MENTION, email: { id: 'old-unread' }, unreadTotal: 1, slot: 0 });
    });

    it('answers skip instead of an old unread mail when a note just woke it', async () => {
      store.push(note('n1', { mentions: ['b'] }));
      expect(await callRoute('g')).toEqual({ status: 200, body: { skip: true, slot: 0 } });
    });

    it('answers skip with the mention when the note that woke it mentions the user', async () => {
      store.push(note('n1'));
      expect((await callRoute('g')).body).toEqual({ skip: true, mention: MENTION, slot: 0, login: expect.any(String) });
    });

    it('still tells of mail that came with the note', async () => {
      store.push(note('n1', { mentions: ['b'] }), mail('new', { age: 10_000 }));
      const { body } = await callRoute('g');
      expect(body).toMatchObject({ email: { id: 'new' }, unreadTotal: 2 });
      expect(body.skip).toBeUndefined();
    });

    it('never mentions anyone for a timeline entry', async () => {
      store.push(note('n1', { kind: 'assigned', mentions: ['a'], age: 3 * 60_000 }));
      const { body } = await callRoute('g');
      expect(body.mention).toBeUndefined();
      expect(body.email).toMatchObject({ id: 'old-unread' });
    });

    it("doesn't go back further than ten minutes", async () => {
      store.push(note('n1', { age: 11 * 60_000 }));
      const { body } = await callRoute('g');
      expect(body.mention).toBeUndefined();
      expect(body.email).toMatchObject({ id: 'old-unread' });
    });

    it('leaves out sender and subject under "Push without sender and subject"', async () => {
      devicePolicy.current = { ...DEFAULT_POLICY, organisation: { devices: { pushWithoutContent: true } } };
      store.push(note('n1'));
      const { body } = await callRoute('g');
      expect(body.mention).toEqual({ noteId: 'n1', threadId: 'T1', forKey: 'offer@client.example', emailId: 'offer' });
      expect(JSON.stringify(body)).not.toMatch(/Mabel|Mulberry|signed copy/);
      for (const properties of emailGets()) expect(contentProperties(properties)).toEqual([]);
    });
  });

  describe('while the app lock hides content (locked=1)', () => {
    it('answers as under "Push without sender and subject": ids only, for notes and mail', async () => {
      store.push(note('n1'), mail('new', { age: 10_000 }));
      const named = (await callRoute('g', 'n1', { locked: '1' })).body;
      expect(named).toMatchObject({ skip: true, redacted: true, mention: { noteId: 'n1', emailId: 'offer' } });
      const mailAnswer = (await callRoute('g', 'new', { locked: '1' })).body;
      expect(mailAnswer).toMatchObject({ redacted: true, email: { id: 'new', threadId: 't-new' } });
      expect(JSON.stringify([named, mailAnswer])).not.toMatch(/Mabel|Mulberry|signed copy|Client|Mail new|Text of/);
      for (const properties of emailGets()) expect(contentProperties(properties)).toEqual([]);
    });
  });

  describe('mail', () => {
    it('answers a named message as before, without what told it from a note', async () => {
      store.push(mail('new', { age: 10_000 }));
      const { body } = await callRoute('g', 'new');
      expect(body).toEqual({
        email: { id: 'new', threadId: 't-new', from: [{ name: 'Client', email: 'client@example.com' }], subject: 'Mail new', preview: 'Text of new', receivedAt: expect.any(String) },
        unreadTotal: 2, inboxUnread: 2, slot: 0, login: expect.any(String),
      });
    });

    it("looks for no notes in the user's own account, and never offers one from the Inbox", async () => {
      store.push(mail('mine', { account: 'a', age: 10_000 }));
      const { body } = await callRoute('a');
      expect(body).toMatchObject({ email: { id: 'mine' }, unreadTotal: 1 });
      expect(body.mention).toBeUndefined();
      const queries = sent.flat().filter(([name]) => name === 'Email/query').map(([, args]) => args.filter);
      expect(queries).toEqual([{ operator: 'AND', conditions: [{ inMailbox: 'inbox' }, { notKeyword: '$seen' }, { notKeyword: '$bulwark-note' }] }]);
    });
  });
});
