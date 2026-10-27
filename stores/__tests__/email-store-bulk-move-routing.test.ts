import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { JMAPClient } from '@/lib/jmap/client';
import { clearAllHooks } from '@/lib/plugin-hooks';
import { emailKeyFor, threadKeyFor } from '@/lib/thread-utils';
import type { Email, Mailbox } from '@/lib/jmap/types';
import { useAuthStore } from '../auth-store';
import { useEmailStore } from '../email-store';

const initialStore = useEmailStore.getState();
const initialAuth = useAuthStore.getState();
const mailbox = (id: string, owner = 'owner', shared = false): Mailbox => ({
  id: shared ? `${owner}:${id}` : id, originalId: id, accountId: owner,
  name: id, isShared: shared, myRights: { mayAddItems: true },
} as Mailbox);
const email = (login: string, id: string, owner = 'owner'): Email => ({
  id, threadId: `thread-${id}`, sourceClientAccountId: login, sourceAccountId: owner,
  mailboxIds: { inbox: true }, keywords: {}, receivedAt: '2026-10-01T12:00:00Z',
  size: 100, hasAttachment: false,
} as Email);
const unstamped = (id: string): Email => ({
  ...email('a', id), sourceClientAccountId: undefined, sourceAccountId: undefined,
});

// Keep the real request serializer, authenticatedFetch and Email/set handling.
// A synthetic connected session avoids discovery and keepalive traffic.
function client(login: string, owner = 'owner'): JMAPClient {
  const server = `https://${login}.example.invalid`;
  const result = JMAPClient.withBearer(server, `token-${login}`, `${login}@example.invalid`);
  Object.assign(result, { accountId: owner, apiUrl: `${server}/jmap/api` });
  return result;
}

type SetArgs = { accountId: string; update: Record<string, { mailboxIds: Record<string, boolean> }> };
type Wire = { url: string; auth: string | null; args: SetArgs };
let a: JMAPClient;
let b: JMAPClient;
let clients: Map<string, JMAPClient>;
let requests: Wire[];
let serverMailboxes: Map<string, Record<string, boolean>>;
let refresh: ReturnType<typeof vi.fn<typeof initialStore.refreshCurrentMailbox>>;
let cross: ReturnType<typeof vi.fn<typeof initialStore.crossAccountMoveEmails>>;
const serverKey = (login: string, owner: string, id: string) => JSON.stringify([login, owner, id]);

function select(rows: Email[], selected = rows): void {
  useEmailStore.setState({
    emails: rows, selectedEmail: selected[0] ?? null,
    selectedEmailKeys: new Set(selected.map(emailKeyFor)),
  });
}

function expectRequests(expected: Array<[string, string, string[], string?]>): void {
  expect(requests).toEqual(expected.map(([login, owner, ids, dest = 'dest']) => ({
    url: `https://${login}.example.invalid/jmap/api`, auth: `Bearer token-${login}`,
    args: { accountId: owner, update: Object.fromEntries(ids.map(id => [id, { mailboxIds: { [dest]: true } }])) },
  })));
}

/**
 * The rows of a login that is gone stay where they are, listed and selected,
 * and nothing is written for them through another login; the rest move.
 */
async function expectNotConnected(stranded: Email, moved: Email): Promise<void> {
  await useEmailStore.getState().batchMoveToMailbox(a, 'dest');
  expectRequests([['a', 'owner', [moved.id]]]);
  expect(cross).not.toHaveBeenCalled();
  const after = useEmailStore.getState();
  expect(after.error).toMatch(/not connected/i);
  expect(after.isLoading).toBe(false);
  expect(after.emails).toEqual([stranded]);
  expect([...after.selectedEmailKeys]).toEqual([emailKeyFor(stranded)]);
}

/** The cross-account moves asked for: [from login, ids, owner]. */
function crossMoves(): Array<[string, string[], string | undefined]> {
  return cross.mock.calls.map(([sources, toLogin, mailboxId, toAccount, fromAccount]) => {
    expect([toLogin, mailboxId, toAccount]).toEqual(['a', 'dest', undefined]);
    const [[login, ids]] = [...sources];
    return [login, ids, fromAccount];
  });
}

beforeEach(() => {
  clearAllHooks();
  a = client('a'); b = client('b'); clients = new Map([['a', a], ['b', b]]);
  requests = []; serverMailboxes = new Map();
  refresh = vi.fn<typeof initialStore.refreshCurrentMailbox>().mockResolvedValue(undefined);
  // "Move to" offers the active login's folders: a message of another login
  // or account goes there across accounts (crossAccountMoveEmails has tests
  // of its own), since `dest` names another folder, or none, in its account.
  cross = vi.fn<typeof initialStore.crossAccountMoveEmails>().mockResolvedValue(true);
  vi.stubGlobal('fetch', vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body)) as { methodCalls: Array<[string, SetArgs, string]> };
    const responses = body.methodCalls.map(([method, args, tag]) => {
      expect(method).toBe('Email/set');
      const auth = new Headers(init?.headers).get('Authorization');
      const login = new URL(String(url)).hostname.split('.')[0];
      expect(auth).toBe(`Bearer token-${login}`);
      requests.push({ url: String(url), auth, args });
      // These responses explicitly confirm every requested ID. Partial-result
      // accounting is intentionally outside this routing regression suite.
      for (const [id, patch] of Object.entries(args.update)) {
        serverMailboxes.set(serverKey(login, args.accountId, id), patch.mailboxIds);
      }
      return [method, { accountId: args.accountId, updated: Object.fromEntries(Object.keys(args.update).map(id => [id, null])) }, tag];
    });
    return new Response(JSON.stringify({ methodResponses: responses }), {
      status: 200, headers: { 'Content-Type': 'application/json' },
    });
  }));
  useAuthStore.setState({
    activeAccountId: 'a', client: a,
    getClientForAccount: (id: string) => clients.get(id),
  });
  useEmailStore.setState({
    ...initialStore, isUnifiedView: true, unifiedRole: 'inbox', crossView: null,
    selectedMailbox: '__unified_inbox__', selectedKeyword: null, viewingAccountId: null,
    searchQuery: '', emails: [], selectedEmail: null, selectedEmailKeys: new Set(),
    mailboxes: [mailbox('inbox'), mailbox('dest')], accountMailboxes: {},
    threadEmailsCache: new Map(), expandedThreadIds: new Set(),
    error: null, isLoading: false, refreshCurrentMailbox: refresh, crossAccountMoveEmails: cross,
  });
});

afterEach(() => {
  clearAllHooks();
  vi.unstubAllGlobals();
  useEmailStore.setState(initialStore);
  useAuthStore.setState(initialAuth);
});

describe('bulk Move authenticated-client routing', () => {
  it('keeps colliding owner IDs on their own logins, leaving an unselected namesake alone', async () => {
    const selectedA = email('a', 'p'), namesakeA = email('a', 'q'), selectedB = email('b', 'q');
    select([selectedA, namesakeA, selectedB], [selectedA, selectedB]);
    serverMailboxes.set(serverKey('a', 'owner', 'q'), { inbox: true });

    expect(await useEmailStore.getState().batchMoveToMailbox(a, 'dest')).toBe(true);

    expectRequests([['a', 'owner', ['p']]]);
    expect(crossMoves()).toEqual([['b', ['q'], 'owner']]);
    expect(serverMailboxes.get(serverKey('a', 'owner', 'p'))).toEqual({ dest: true });
    expect(serverMailboxes.get(serverKey('a', 'owner', 'q'))).toEqual({ inbox: true });
    expect(useEmailStore.getState().emails).not.toContain(selectedA);
    expect(useEmailStore.getState().emails).toContain(namesakeA);
  });

  it('sends equal selected email IDs separately for each login', async () => {
    select([email('a', 'same'), email('b', 'same')]);
    expect(await useEmailStore.getState().batchMoveToMailbox(a, 'dest')).toBe(true);
    expectRequests([['a', 'owner', ['same']]]);
    expect(crossMoves()).toEqual([['b', ['same'], 'owner']]);
  });

  it('moves only the selected login\'s copy when another login has the same ID', async () => {
    const other = email('a', 'same'), selected = email('b', 'same');
    select([other, selected], [selected]);
    await useEmailStore.getState().batchMoveToMailbox(a, 'dest');
    expectRequests([]);
    expect(crossMoves()).toEqual([['b', ['same'], 'owner']]);
    expect(useEmailStore.getState().emails).toContain(other);
  });

  it('keeps delegated owners separate when they share a reaching login', async () => {
    select([email('a', 'p'), email('a', 'q', 'shared')]);
    await useEmailStore.getState().batchMoveToMailbox(a, 'dest');
    expectRequests([['a', 'owner', ['p']]]);
    expect(crossMoves()).toEqual([['a', ['q'], 'shared']]);
  });

  it('preserves personal-folder routing for unstamped messages', async () => {
    useEmailStore.setState({ isUnifiedView: false, selectedMailbox: 'inbox' });
    select([unstamped('p'), unstamped('q')]);
    await useEmailStore.getState().batchMoveToMailbox(a, 'dest');
    expectRequests([['a', 'owner', ['p', 'q']]]);
    expect(refresh).toHaveBeenCalledWith(a);
  });

  it.each([false, true])('preserves direct shared-folder routing (viewing account=%s)', async viewing => {
    const login = viewing ? 'b' : 'a';
    const folders = [mailbox('inbox', 'shared', true), mailbox('dest', 'shared', true)];
    useEmailStore.setState({
      isUnifiedView: false, selectedMailbox: 'shared:inbox', viewingAccountId: viewing ? 'b' : null,
      mailboxes: viewing ? [] : folders, accountMailboxes: viewing ? { b: folders } : {},
    });
    select([unstamped('p'), unstamped('q')]);
    await useEmailStore.getState().batchMoveToMailbox(a, 'shared:dest');
    expectRequests([[login, 'shared', ['p', 'q']]]);
  });

  it('uses the viewing client for an unstamped personal folder', async () => {
    b = client('b', 'owner-b'); clients.set('b', b);
    useEmailStore.setState({
      isUnifiedView: false, selectedMailbox: 'inbox', viewingAccountId: 'b',
      accountMailboxes: { b: [mailbox('inbox', 'owner-b'), mailbox('dest', 'owner-b')] },
    });
    select([unstamped('p'), unstamped('q')]);
    await useEmailStore.getState().batchMoveToMailbox(a, 'dest');
    expectRequests([['b', 'owner-b', ['p', 'q']]]);
  });

  it('routes selected expanded-thread members without moving an unselected list namesake', async () => {
    const other = email('a', 'same'), member = email('b', 'same');
    select([other], [member]);
    useEmailStore.setState({ threadEmailsCache: new Map([[threadKeyFor(member), [member]]]) });
    await useEmailStore.getState().batchMoveToMailbox(a, 'dest');
    expectRequests([]);
    expect(crossMoves()).toEqual([['b', ['same'], 'owner']]);
    expect(useEmailStore.getState().emails).toEqual([other]);
  });

  it('leaves a disconnected login\'s rows alone instead of using another login', async () => {
    clients.delete('b');
    const moved = email('a', 'p'), stranded = email('b', 'q');
    select([moved, stranded]);
    await expectNotConnected(stranded, moved);
  });

  it('rejects an owner stamp without a reaching login instead of using the active client', async () => {
    const moved = email('a', 'p'), stranded = { ...email('b', 'q'), sourceClientAccountId: undefined };
    select([moved, stranded]);
    await expectNotConnected(stranded, moved);
  });

  it('preserves explicit-target routing without using the unrelated selection', async () => {
    const selected = email('a', 'selected');
    select([selected]);
    await useEmailStore.getState().batchMoveToMailbox(a, 'dest', { client: b, accountId: 'shared', emailIds: ['unloaded'] });
    expectRequests([['b', 'shared', ['unloaded']]]);
    expect(useEmailStore.getState().emails).toEqual([selected]);
    expect([...useEmailStore.getState().selectedEmailKeys]).toEqual([emailKeyFor(selected)]);
  });
});
