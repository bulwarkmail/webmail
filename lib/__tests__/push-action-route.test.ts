// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { loginFingerprint } from '@/lib/pwa-notify/login-fingerprint';

// POST /api/push/action: a notification's Mark read and Archive with no tab
// open. Every refusal must leave the mail alone: the worker opens the message
// in the app instead.

vi.mock('next/headers', () => ({ cookies: async () => ({ get: () => undefined }) }));
vi.mock('@/lib/logger', () => ({ logger: { warn: vi.fn(), error: vi.fn(), debug: vi.fn(), info: vi.fn() } }));
vi.mock('@/lib/account-utils', () => ({ MAX_ACCOUNT_SLOTS: 3 }));

type Login = { serverUrl: string; username: string; authHeader: string };
let LOGINS: Array<Login | null> = [];
vi.mock('@/lib/stalwart/auth-context', () => ({
  readStalwartAuthContextFromStore: (_store: unknown, slot: number) => LOGINS[slot] ?? null,
}));

const ALICE: Login = { serverUrl: 'https://one.example/', username: 'alice@example.org', authHeader: 'Bearer alice' };
const BOB: Login = { serverUrl: 'https://one.example', username: 'bob@example.org', authHeader: 'Bearer bob' };

let policy: Record<string, unknown> = {};
vi.mock('@/lib/admin/config-manager', () => ({
  configManager: { ensureLoaded: async () => {}, getPolicy: () => policy },
}));
let subject: { email: string; groups: string[] } | null = { email: 'alice@example.org', groups: [] };
vi.mock('@/lib/admin/server-device-policy', () => ({ strictDeviceSubject: async () => subject }));

type Calls = Array<[string, Record<string, unknown>, string]>;
const writes: Array<{ auth: string; url: string; calls: Calls }> = [];
let session: Record<string, unknown>;
let sessionStatus = 200;
let mailboxes: Array<Record<string, unknown>>;
let email: Record<string, unknown> | null;
let emailSetResult: Record<string, unknown> | null = null;
let sessionsAsked = 0;

const json = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });
vi.mock('@/lib/stalwart/server-fetch', () => ({
  isTrustedJmapServerUrl: async () => true,
  fetchJmapServer: async (url: string, init?: { headers?: Record<string, string>; body?: string }) => {
    if (url.endsWith('/.well-known/jmap')) {
      sessionsAsked++;
      return sessionStatus === 200 ? json(session) : new Response('', { status: sessionStatus });
    }
    const calls = (JSON.parse(init?.body ?? '{}') as { methodCalls: Calls }).methodCalls;
    if (calls.some(([name]) => name.endsWith('/set'))) {
      writes.push({ auth: init?.headers?.Authorization ?? '', url, calls });
    }
    return json({
      methodResponses: calls.map(([name, args, id]) => {
        if (name === 'Mailbox/get') return [name, { list: mailboxes }, id];
        if (name === 'Email/get') return [name, { list: email ? [email] : [] }, id];
        if (name === 'Mailbox/set') return [name, { created: {} }, id];
        const emailId = Object.keys(args.update as Record<string, unknown>)[0];
        return [name, emailSetResult ?? { updated: { [emailId]: null } }, id];
      }),
    });
  },
}));

const INBOX = { id: 'inbox', name: 'Inbox', role: 'inbox' };
const ARCHIVE = { id: 'arch', name: 'Archive', role: 'archive' };

async function call(body: Record<string, unknown>, headers: Record<string, string> = { 'sec-fetch-site': 'same-origin' }) {
  const { POST } = await import('@/app/api/push/action/route');
  const res = await POST(new NextRequest('https://mail.example.com/api/push/action', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify(body),
  }));
  return { status: res.status, body: await res.json() };
}

const fingerprint = (login: Login) => loginFingerprint(login.serverUrl, login.username);
const markRead = async (over: Record<string, unknown> = {}) => ({
  action: 'mark-read', accountId: 'a', emailId: 'e1', login: await fingerprint(ALICE), ...over,
});
const archive = async (over: Record<string, unknown> = {}) => ({ ...(await markRead()), action: 'archive', ...over });
const emailSet = () => {
  const call = writes[0].calls.find(([name]) => name === 'Email/set');
  return call?.[1] as { accountId: string; update: Record<string, Record<string, unknown>> };
};
const mailboxSet = () => writes[0].calls.find(([name]) => name === 'Mailbox/set')?.[1] as { create: Record<string, Record<string, unknown>> } | undefined;

beforeEach(() => {
  LOGINS = [ALICE];
  policy = {};
  subject = { email: 'alice@example.org', groups: [] };
  writes.length = 0;
  sessionsAsked = 0;
  sessionStatus = 200;
  session = {
    apiUrl: 'https://one.example/jmap/',
    primaryAccounts: { 'urn:ietf:params:jmap:mail': 'a' },
    accounts: { a: { name: 'alice@example.org', accountCapabilities: { 'urn:ietf:params:jmap:mail': {} } } },
  };
  mailboxes = [INBOX, ARCHIVE];
  email = { id: 'e1', receivedAt: '2026-03-31T23:30:00Z' };
  emailSetResult = null;
});

describe('who may ask', () => {
  it('refuses a request from another site before reading anything', async () => {
    const res = await call(await markRead(), { 'sec-fetch-site': 'same-site' });
    expect(res.status).toBe(403);
    expect(sessionsAsked).toBe(0);
    expect(writes).toHaveLength(0);
  });

  it('accepts what a service worker sends', async () => {
    expect((await call(await markRead())).status).toBe(200);
    expect(writes).toHaveLength(1);
  });

  it.each([
    ['an unknown action', { action: 'delete' }],
    ['an id that is no JMAP id', { emailId: '../../x' }],
    ['no account', { accountId: undefined }],
    ['no login', { login: undefined }],
  ])('refuses %s', async (_name, over) => {
    const res = await call(await markRead(over));
    expect(res.status).toBe(400);
    expect(sessionsAsked).toBe(0);
  });
});

describe('which login', () => {
  it('answers 401 with no cookie, without asking the mail server', async () => {
    LOGINS = [];
    expect((await call(await markRead())).status).toBe(401);
    expect(sessionsAsked).toBe(0);
    expect(writes).toHaveLength(0);
  });

  it('answers 401 when the slot went to someone else since the notification', async () => {
    // Account ids repeat, so bob's session would accept account `a` as well.
    LOGINS = [BOB];
    expect((await call(await markRead())).status).toBe(401);
    expect(sessionsAsked).toBe(0);
    expect(writes).toHaveLength(0);
  });

  it('finds the login in whichever slot it holds now and uses its credential', async () => {
    LOGINS = [BOB, null, ALICE];
    expect((await call(await markRead())).status).toBe(200);
    expect(writes[0].auth).toBe('Bearer alice');
  });

  it('answers 409 when the login is in two slots', async () => {
    LOGINS = [ALICE, { ...ALICE, authHeader: 'Bearer stale' }];
    expect((await call(await markRead())).status).toBe(409);
    expect(writes).toHaveLength(0);
  });

  it('answers 401 for an expired token: only a page refreshes it', async () => {
    sessionStatus = 401;
    expect((await call(await markRead())).status).toBe(401);
    expect(writes).toHaveLength(0);
  });

  it('answers 502 when the mail server is down, which says nothing about the token', async () => {
    sessionStatus = 503;
    expect((await call(await markRead())).status).toBe(502);
    expect(writes).toHaveLength(0);
  });

  it('refuses an account this login has no part in', async () => {
    const res = await call(await markRead({ accountId: 'stranger' }));
    expect(res.status).toBe(403);
    expect(writes).toHaveLength(0);
  });

  it("doesn't take a name from Object.prototype for an account", async () => {
    const res = await call(await markRead({ accountId: 'constructor' }));
    expect(res.status).toBe(403);
    expect(writes).toHaveLength(0);
  });
});

describe('Mark read', () => {
  it('sets $seen on that message, at the rebased API address', async () => {
    expect(await call(await markRead())).toEqual({ status: 200, body: { ok: true } });
    expect(writes[0].url).toBe('https://one.example/jmap/');
    expect(emailSet()).toEqual({ accountId: 'a', update: { e1: { 'keywords/$seen': true } } });
    expect(mailboxSet()).toBeUndefined();
  });

  it('acts in a shared account the login reaches', async () => {
    session.accounts = { ...(session.accounts as object), team: { name: 'team@example.org' } };
    expect((await call(await markRead({ accountId: 'team' }))).status).toBe(200);
    expect(emailSet().accountId).toBe('team');
  });

  it('answers 404 for a message that is gone', async () => {
    emailSetResult = { notUpdated: { e1: { type: 'notFound' } } };
    expect((await call(await markRead())).status).toBe(404);
  });

  it('answers 502 when the server refuses', async () => {
    emailSetResult = { notUpdated: { e1: { type: 'forbidden' } } };
    expect((await call(await markRead())).status).toBe(502);
  });
});

describe('Archive', () => {
  it('moves the message into the Archive folder', async () => {
    expect((await call(await archive())).status).toBe(200);
    expect(emailSet().update.e1).toEqual({ mailboxIds: { arch: true } });
    expect(mailboxSet()).toBeUndefined();
  });

  it('finds an Archive by name when no folder has the role, as the app does', async () => {
    mailboxes = [INBOX, { id: 'named', name: 'archive' }];
    await call(await archive());
    expect(emailSet().update.e1).toEqual({ mailboxIds: { named: true } });
  });

  it('creates the Archive folder when the account has none, in the same request', async () => {
    mailboxes = [INBOX];
    expect((await call(await archive())).status).toBe(200);
    expect(mailboxSet()?.create).toEqual({ archive: { name: 'Archive', parentId: null, role: 'archive' } });
    expect(emailSet().update.e1).toEqual({ mailboxIds: { '#archive': true } });
  });

  it("doesn't try when the account may not create one", async () => {
    mailboxes = [INBOX];
    session.accounts = { a: { accountCapabilities: { 'urn:ietf:params:jmap:mail': { mayCreateTopLevelMailbox: false } } } };
    expect((await call(await archive())).status).toBe(403);
    expect(writes).toHaveLength(0);
  });

  it("doesn't try an Archive that takes no mail", async () => {
    mailboxes = [INBOX, { ...ARCHIVE, myRights: { mayAddItems: false } }];
    expect((await call(await archive())).status).toBe(403);
    expect(writes).toHaveLength(0);
  });

  it('files by year into an existing year folder', async () => {
    mailboxes = [INBOX, ARCHIVE, { id: 'y26', name: '2026', parentId: 'arch' }];
    await call(await archive({ archiveMode: 'year', timeZone: 'UTC' }));
    expect(emailSet().update.e1).toEqual({ mailboxIds: { y26: true } });
    expect(mailboxSet()).toBeUndefined();
  });

  it('ignores a folder named like the year elsewhere', async () => {
    mailboxes = [INBOX, ARCHIVE, { id: 'other', name: '2026', parentId: 'inbox' }];
    await call(await archive({ archiveMode: 'year', timeZone: 'UTC' }));
    expect(mailboxSet()?.create).toEqual({ year: { name: '2026', parentId: 'arch' } });
    expect(emailSet().update.e1).toEqual({ mailboxIds: { '#year': true } });
  });

  it("files by month in the user's time zone, not the server's", async () => {
    mailboxes = [INBOX, ARCHIVE, { id: 'y26', name: '2026', parentId: 'arch' }, { id: 'm03', name: '03', parentId: 'y26' }];
    // 23:30 UTC on 31 March is 1 April in Berlin.
    await call(await archive({ archiveMode: 'month', timeZone: 'Europe/Berlin' }));
    expect(mailboxSet()?.create).toEqual({ month: { name: '04', parentId: 'y26' } });
    expect(emailSet().update.e1).toEqual({ mailboxIds: { '#month': true } });

    writes.length = 0;
    await call(await archive({ archiveMode: 'month', timeZone: 'UTC' }));
    expect(emailSet().update.e1).toEqual({ mailboxIds: { m03: true } });
  });

  it('creates the whole path in month mode on an account without an Archive', async () => {
    mailboxes = [INBOX];
    await call(await archive({ archiveMode: 'month', timeZone: 'UTC' }));
    expect(mailboxSet()?.create).toEqual({
      archive: { name: 'Archive', parentId: null, role: 'archive' },
      year: { name: '2026', parentId: '#archive' },
      month: { name: '03', parentId: '#year' },
    });
    expect(emailSet().update.e1).toEqual({ mailboxIds: { '#month': true } });
  });

  it('survives a time zone that is no time zone', async () => {
    mailboxes = [INBOX, ARCHIVE, { id: 'y26', name: '2026', parentId: 'arch' }];
    expect((await call(await archive({ archiveMode: 'year', timeZone: 'Mars/Olympus' }))).status).toBe(200);
    expect(emailSet().update.e1).toEqual({ mailboxIds: { y26: true } });
  });

  it('answers 404 for a message that is gone', async () => {
    email = null;
    expect((await call(await archive())).status).toBe(404);
    expect(writes).toHaveLength(0);
  });

  describe('the admin gate', () => {
    it('refuses when the admin turned Archive off, whatever the worker believes', async () => {
      policy = { features: { archiveActionEnabled: false } };
      expect((await call(await archive())).status).toBe(403);
      expect(writes).toHaveLength(0);
    });

    it('follows the scope this login is in', async () => {
      policy = { scopes: [{ id: 'team', label: 'Team', match: { domains: ['example.org'] }, policy: { features: { archiveActionEnabled: false } } }] };
      expect((await call(await archive())).status).toBe(403);
      expect(writes).toHaveLength(0);
    });

    it("refuses when the login's scopes can't be worked out", async () => {
      subject = null;
      expect((await call(await archive())).status).toBe(403);
      expect(writes).toHaveLength(0);
    });

    it('leaves Mark read alone', async () => {
      policy = { features: { archiveActionEnabled: false } };
      expect((await call(await markRead())).status).toBe(200);
    });
  });
});
