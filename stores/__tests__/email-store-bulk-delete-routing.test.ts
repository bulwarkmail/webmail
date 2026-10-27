import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useEmailStore } from '../email-store';
import { useAuthStore } from '../auth-store';
import { useSettingsStore } from '../settings-store';
import { JMAPClient } from '@/lib/jmap/client';
import { clearAllHooks } from '@/lib/plugin-hooks';
import { emailKeyFor, threadKeyFor } from '@/lib/thread-utils';
import type { Email, Mailbox } from '@/lib/jmap/types';

type Login = 'a' | 'b';
type Args = { accountId: string; destroy?: string[]; update?: Record<string, unknown> };
type Request = { login: Login; authorization: string | null; method: string; args: Args };
const server = (login: Login) => `https://${login}.example.invalid`;
const email = (login: Login, id: string, owner = 'c'): Email => ({
  id, threadId: 'thread', sourceClientAccountId: login, sourceAccountId: owner,
  receivedAt: '2026-10-01T00:00:00Z', mailboxIds: { inbox: true }, keywords: {}, size: 100, hasAttachment: false,
} as Email);
const mailbox = (id: string, owner = 'c', shared = false): Mailbox => ({
  id, accountId: owner, name: 'Trash', role: 'trash', isShared: shared,
  totalEmails: 0, unreadEmails: 0, totalThreads: 0, unreadThreads: 0,
  myRights: { mayReadItems: true, mayAddItems: true, mayRemoveItems: true },
} as Mailbox);
const unstamped = (id: string): Email => ({
  ...email('a', id), sourceClientAccountId: undefined, sourceAccountId: undefined,
});

// Exercise the real JMAP serialization and authentication. No connection/session
// request or keepalive is needed, and fetch is intercepted for every request.
function client(login: Login): JMAPClient {
  const result = JMAPClient.withBearer(server(login), `synthetic-${login}`, `${login}@example.invalid`);
  Object.assign(result, { accountId: 'c', apiUrl: `${server(login)}/jmap` });
  return result;
}

describe('bulk Delete/Trash authenticated-client routing', () => {
  let a: JMAPClient;
  let b: JMAPClient;
  let requests: Request[];
  let folders: Record<Login, Record<string, Mailbox[]>>;

  // Each login's folders as the unified views cache them, under login and
  // owner (sourceMailboxesKey); the list under the bare owner id stays the
  // colliding one set up below.
  function select(list: Email[], selected = list) {
    const cached = Object.fromEntries((['a', 'b'] as const).flatMap(login =>
      Object.entries(folders[login]).map(([owner, list]) => [`${login}|${owner}`, list])));
    useEmailStore.setState(state => ({
      emails: list, selectedEmailKeys: new Set(selected.map(emailKeyFor)),
      accountMailboxes: { ...state.accountMailboxes, ...cached },
    }));
  }
  function writes() {
    return requests.filter(r => r.method === 'Email/set');
  }
  function expectWrite(login: Login, args: Args) {
    expect(writes().filter(r => r.login === login)).toEqual([{
      login, authorization: `Bearer synthetic-${login}`, method: 'Email/set', args,
    }]);
  }

  beforeEach(() => {
    clearAllHooks();
    a = client('a'); b = client('b'); requests = [];
    folders = { a: { c: [mailbox('trash-a')] }, b: { c: [mailbox('trash-b')] } };
    vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit) => {
      const login = (['a', 'b'] as const).find(id => url === `${server(id)}/jmap`);
      if (!login) throw new Error(`Unexpected synthetic request: ${url}`);
      const body = JSON.parse(String(init.body)) as { methodCalls: [string, Args, string][] };
      const methodResponses = body.methodCalls.map(([method, args, tag]) => {
        requests.push({ login, authorization: new Headers(init.headers).get('Authorization'), method, args });
        if (method === 'Mailbox/get') return [method, { accountId: args.accountId, list: folders[login][args.accountId] ?? [] }, tag];
        if (method === 'Email/set') return [method, {
          accountId: args.accountId, destroyed: args.destroy,
          updated: args.update && Object.fromEntries(Object.keys(args.update).map(id => [id, null])),
        }, tag];
        throw new Error(`Unexpected synthetic method: ${method}`);
      });
      return new Response(JSON.stringify({ methodResponses }), { status: 200 });
    }));
    useAuthStore.setState({
      activeAccountId: 'a', client: a,
      getClientForAccount: (id: string) => id === 'a' ? a : id === 'b' ? b : undefined,
    } as never);
    useSettingsStore.setState({ deleteAction: 'trash', permanentlyDeleteJunk: false });
    useEmailStore.setState({
      isUnifiedView: true, unifiedRole: 'inbox', selectedMailbox: '__unified_inbox__', viewingAccountId: null,
      selectedKeyword: null, searchQuery: '', emails: [], selectedEmail: null, selectedEmailKeys: new Set(),
      mailboxes: [mailbox('wrong-active-trash')],
      // This cache cannot distinguish the two servers' owner c. Never use it
      // as a stamped message's authoritative Trash destination.
      accountMailboxes: { c: [mailbox('wrong-cached-trash')] },
      threadEmailsCache: new Map(), unifiedScope: [], error: null, isLoading: false,
    });
  });
  afterEach(() => { clearAllHooks(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

  it('destroys selected A/c:p and B/c:q through their own clients, leaving unselected A/c:q alone', async () => {
    const p = email('a', 'p'), unselected = email('a', 'q'), q = email('b', 'q');
    select([p, unselected, q], [p, q]);
    expect(await useEmailStore.getState().batchDelete(a, true)).toBe(true);
    expectWrite('a', { accountId: 'c', destroy: ['p'] });
    expectWrite('b', { accountId: 'c', destroy: ['q'] });
    expect(useEmailStore.getState().emails).toEqual([unselected]);
    expect(useEmailStore.getState().selectedEmailKeys.size).toBe(0);
    expect(requests.filter(r => r.method === 'Mailbox/get')).toEqual([]);
  });

  it('resolves each Trash in the same login and owner, despite a colliding folder cache', async () => {
    const p = email('a', 'p'), unselected = email('a', 'q'), q = email('b', 'q');
    select([p, unselected, q], [p, q]);
    expect(await useEmailStore.getState().batchDelete(a)).toBe(true);
    for (const login of ['a', 'b'] as const) {
      expectWrite(login, { accountId: 'c', update: { [login === 'a' ? 'p' : 'q']: { mailboxIds: { [`trash-${login}`]: true } } } });
    }
    expect(useEmailStore.getState().emails).toEqual([unselected]);
  });

  it.each([false, true])('keeps equal raw email and mailbox IDs on distinct clients (permanent=%s)', async permanent => {
    folders.a.c = [mailbox('trash')]; folders.b.c = [mailbox('trash')];
    select([email('a', 'same'), email('b', 'same')]);
    expect(await useEmailStore.getState().batchDelete(a, permanent)).toBe(true);
    for (const login of ['a', 'b'] as const) expectWrite(login, permanent
      ? { accountId: 'c', destroy: ['same'] }
      : { accountId: 'c', update: { same: { mailboxIds: { trash: true } } } });
    expect(useEmailStore.getState().emails).toEqual([]);
  });

  it('keeps owners reached through one client separate and uses the delegated owner Trash', async () => {
    folders.a.d = [mailbox('delegated-trash', 'd', true)];
    select([email('a', 'p'), email('a', 'q', 'd')]);
    expect(await useEmailStore.getState().batchDelete(a)).toBe(true);
    expect(writes().map(r => [r.login, r.authorization, r.args])).toEqual([
      ['a', 'Bearer synthetic-a', { accountId: 'c', update: { p: { mailboxIds: { 'trash-a': true } } } }],
      ['a', 'Bearer synthetic-a', { accountId: 'd', update: { q: { mailboxIds: { 'delegated-trash': true } } } }],
    ]);
  });

  it.each([false, true])('preserves unstamped primary-folder requests (permanent=%s)', async permanent => {
    useEmailStore.setState({ isUnifiedView: false, selectedMailbox: 'inbox', mailboxes: [mailbox('primary-trash')] });
    select([unstamped('p')]);
    expect(await useEmailStore.getState().batchDelete(a, permanent)).toBe(true);
    expectWrite('a', permanent ? { accountId: 'c', destroy: ['p'] }
      : { accountId: 'c', update: { p: { mailboxIds: { 'primary-trash': true } } } });
    expect(requests).toHaveLength(1);
  });

  it.each([false, true])('preserves direct shared-folder routing through the viewing client (permanent=%s)', async permanent => {
    const trash = { ...mailbox('d:trash', 'd', true), originalId: 'trash' };
    useEmailStore.setState({ isUnifiedView: false, selectedMailbox: 'd:inbox', viewingAccountId: 'b',
      accountMailboxes: { b: [{ ...trash, id: 'd:inbox', role: 'inbox' }, trash], d: [mailbox('wrong-owner-cache', 'd', true)] },
    });
    select([unstamped('p')]);
    expect(await useEmailStore.getState().batchDelete(a, permanent)).toBe(true);
    expectWrite('b', permanent ? { accountId: 'd', destroy: ['p'] }
      : { accountId: 'd', update: { p: { mailboxIds: { trash: true } } } });
    expect(requests).toHaveLength(1);
  });

  it.each([false, true])('routes selected expanded-thread members with colliding IDs (permanent=%s)', async permanent => {
    const row = email('a', 'row'), memberA = email('a', 'same'), memberB = email('b', 'same');
    select([row], [memberA, memberB]);
    useEmailStore.setState({ threadEmailsCache: new Map([[threadKeyFor(memberA), [row, memberA]], [threadKeyFor(memberB), [memberB]]]) });
    expect(await useEmailStore.getState().batchDelete(a, permanent)).toBe(true);
    expect(writes()).toHaveLength(2);
    for (const login of ['a', 'b'] as const) expectWrite(login, permanent
      ? { accountId: 'c', destroy: ['same'] }
      : { accountId: 'c', update: { same: { mailboxIds: { [`trash-${login}`]: true } } } });
    expect(useEmailStore.getState().emails).toEqual([row]);
  });

  it.each([false, true])('does not merge an unavailable stamped source into a connected source with the same owner (permanent=%s)', async permanent => {
    useAuthStore.setState({ getClientForAccount: (id: string) => id === 'a' ? a : undefined } as never);
    select([email('a', 'p'), email('b', 'q')]);
    await useEmailStore.getState().batchDelete(a, permanent);
    expectWrite('a', permanent ? { accountId: 'c', destroy: ['p'] }
      : { accountId: 'c', update: { p: { mailboxIds: { 'trash-a': true } } } });
    expect(requests.every(r => r.login === 'a')).toBe(true);
  });

  it('does not use another client’s cached Trash when the source owner has no Trash', async () => {
    folders.b.c = [];
    const q = email('b', 'q'); select([q]);
    expect(await useEmailStore.getState().batchDelete(a)).toBe(false);
    expect(writes()).toEqual([]);
    expect(useEmailStore.getState().emails).toEqual([q]);
    expect([...useEmailStore.getState().selectedEmailKeys]).toEqual([emailKeyFor(q)]);
  });
});
