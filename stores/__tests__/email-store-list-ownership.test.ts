import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useEmailStore as store } from '../email-store';
import { useAuthStore as auth } from '../auth-store';
import { useSettingsStore } from '../settings-store';
import { clearAllStores } from '@/lib/account-state-manager';
import { forgetFolderLists } from '@/lib/folder-list-cache';
import { DEFAULT_SEARCH_FILTERS } from '@/lib/jmap/search-utils';
import { clearAllHooks, emailHooks } from '@/lib/plugin-hooks';
import type { Email, Mailbox } from '@/lib/jmap/types';
import type { JMAPClient } from '@/lib/jmap/client';
import type { UnifiedAccountClient } from '@/lib/unified-mailbox';

// Exercise the real stores and plugin buses. Only read responses are deferred;
// no authenticated client or mail mutation is used.
const initial = store.getState();
const initialAuth = auth.getState();
const initialSettings = useSettingsStore.getState();
const row = (id: string): Email => ({
  id, threadId: `t-${id}`, mailboxIds: { inbox: true }, keywords: {}, subject: id,
  receivedAt: '2026-11-05T10:00:00Z', from: [], to: [], preview: '', size: 1, hasAttachment: false,
});
const page = (...ids: string[]) => ({
  emails: ids.map(row), hasMore: false, total: ids.length, threadCounts: {},
});
const mailbox = (id: string): Mailbox => ({
  id, name: id, role: id === 'inbox' ? 'inbox' : undefined, sortOrder: 0,
  totalEmails: 0, unreadEmails: 0, totalThreads: 0, unreadThreads: 0, isSubscribed: true,
  myRights: {
    mayReadItems: true, mayAddItems: true, mayRemoveItems: true, maySetSeen: true,
    maySetKeywords: true, mayCreateChild: true, mayRename: true, mayDelete: true, maySubmit: true,
  },
});
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
type Read = {
  method: string;
  account: string;
  args: unknown[];
  reply: ReturnType<typeof deferred<ReturnType<typeof page>>>;
};
let reads: Read[];
function client(account: string): JMAPClient {
  const request = (method: string) => vi.fn((...args: unknown[]) => {
    const reply = deferred<ReturnType<typeof page>>();
    reads.push({ method, account, args, reply });
    return reply.promise;
  });
  return {
    getAccountId: () => account,
    getEmails: request('getEmails'), searchEmails: request('searchEmails'),
    advancedSearchEmails: request('advancedSearchEmails'),
    getSomeEmails: vi.fn().mockResolvedValue([]), getThreadEmailCounts: vi.fn().mockResolvedValue({}),
  } as unknown as JMAPClient;
}
let a: JMAPClient, b: JMAPClient;
const tick = () => new Promise(resolve => setTimeout(resolve, 0));
function snapshot() {
  const state = store.getState();
  return {
    ids: state.emails.map(email => email.id), mailbox: state.selectedMailbox,
    viewing: state.viewingAccountId, active: auth.getState().activeAccountId, query: state.searchQuery,
    loading: state.isLoading, loadingMore: state.isLoadingMore, error: state.error,
  };
}
function visible(ids: string[], overrides: Partial<ReturnType<typeof snapshot>> = {}) {
  expect(snapshot()).toEqual({
    ids, mailbox: 'inbox', viewing: null, active: 'login-a', query: '',
    loading: false, loadingMore: false, error: null, ...overrides,
  });
}
function settle(read: Read, outcome: 'success' | 'error', id = 'stale') {
  if (outcome === 'success') read.reply.resolve(page(id));
  else read.reply.reject(new Error('stale failure'));
}
const kinds = ['folder', 'quick', 'advanced'] as const;
type Kind = typeof kinds[number];
function load(kind: Kind) {
  if (kind === 'folder') return store.getState().fetchEmails(a);
  if (kind === 'advanced') {
    store.getState().setSearchQuery('invoice');
    return store.getState().advancedSearch(a);
  }
  return store.getState().searchEmails(a, 'invoice');
}
function leaveSearch(destination: 'clear' | 'viewing account' | 'reset') {
  if (destination === 'viewing account') store.getState().selectAccountMailbox('login-b', 'inbox');
  if (destination === 'reset') {
    clearAllStores();
    auth.setState({ client: b, activeAccountId: 'login-b' });
    store.setState({ mailboxes: [mailbox('inbox')], viewingAccountId: null });
    store.getState().selectMailbox('inbox');
  } else {
    store.getState().setSearchQuery('');
    store.getState().clearSearchFilters();
  }
}
const scope = (destination: 'clear' | 'viewing account' | 'reset') =>
  destination === 'reset' ? { active: 'login-b' } : destination === 'viewing account' ? { viewing: 'login-b' } : {};

beforeEach(() => {
  clearAllHooks();
  forgetFolderLists();
  reads = [];
  store.setState(initial, true);
  a = client('owner-a'); b = client('owner-b');
  auth.setState({
    client: a, activeAccountId: 'login-a',
    getClientForAccount: id => id === 'login-a' ? a : id === 'login-b' ? b : undefined,
    getAllConnectedClients: () => new Map([['login-a', a], ['login-b', b]]),
  });
  useSettingsStore.setState({ emailsPerPage: 25, interfaceLayout: 'default', mvInboxType: 'default' });
  store.setState({
    selectedMailbox: 'inbox', mailboxes: [mailbox('inbox'), mailbox('later')],
    accountMailboxes: { 'login-b': [mailbox('inbox')] }, searchMailboxId: 'inbox',
    searchFilters: { ...DEFAULT_SEARCH_FILTERS }, emails: [], isLoading: false,
  });
  vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.stubGlobal('fetch', vi.fn(() => { throw new Error('Unexpected network access'); }));
});
afterEach(async () => {
  store.getState().searchAbortController?.abort();
  await tick(); // Drain deferred loading callbacks before restoring the stores.
  clearAllHooks();
  store.setState(initial, true);
  auth.setState(initialAuth, true);
  useSettingsStore.setState(initialSettings, true);
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('message-list replacement ownership', () => {
  for (const kind of kinds) {
    it.each(['success', 'error'] as const)(`${kind}: preserves normal completion and current %s`, async outcome => {
      const done = load(kind);
      await tick();
      const query = kind === 'folder' ? '' : 'invoice';
      visible([], { query, loading: true });
      settle(reads[0], outcome, 'current');
      await done;
      visible(outcome === 'success' ? ['current'] : [], {
        query, error: outcome === 'error' ? 'stale failure' : null,
      });
      await tick();
      visible(outcome === 'success' ? ['current'] : [], {
        query, error: outcome === 'error' ? 'stale failure' : null,
      });
    });
  }

  for (const navigation of ['folder', 'viewing account'] as const) {
    for (const outcome of ['success', 'error'] as const) {
      it.each([false, true])(`A -> B -> A (${navigation}): ignores old A ${outcome}, newer pending=%s`, async pending => {
        const old = load('folder');
        if (navigation === 'folder') store.getState().selectMailbox('later');
        else store.getState().selectAccountMailbox('login-b', 'inbox');
        const middle = load('folder');
        expect(reads[1].account).toBe(navigation === 'folder' ? 'owner-a' : 'owner-b');
        store.getState().selectAccountMailbox(null, 'inbox');
        const current = load('folder');
        if (!pending) { reads[2].reply.resolve(page('a-new')); await current; }
        const before = snapshot();
        settle(reads[0], outcome, 'a-old');
        await old;
        expect(snapshot()).toEqual(before);
        reads[1].reply.resolve(page('b-middle')); await middle;
        expect(snapshot()).toEqual(before);
        if (pending) { reads[2].reply.resolve(page('a-new')); await current; }
        visible(['a-new']);
      });
    }
  }

  it.each(['success', 'error'] as const)('drops older same-folder %s without navigation', async outcome => {
    const old = load('folder');
    const current = load('folder');
    reads[1].reply.resolve(page('new')); await current;
    settle(reads[0], outcome, 'old'); await old;
    visible(['new']);
  });

  it.each(['success', 'error'] as const)('older folder %s cannot replace a newer search or its error', async outcome => {
    const old = load('folder');
    const current = load('quick'); await tick();
    reads[1].reply.resolve(page('invoice-hit')); await current;
    settle(reads[0], outcome, 'unfiltered'); await old;
    visible(['invoice-hit'], { query: 'invoice' });
  });

  for (const kind of ['quick', 'advanced'] as const) {
    for (const destination of ['clear', 'viewing account', 'reset'] as const) {
      for (const outcome of ['success', 'error'] as const) {
        it.each([false, true])(`${kind}: ignores ${outcome} after ${destination}, newer pending=%s`, async pending => {
          const old = load(kind); await tick();
          expect(reads[0].account).toBe('owner-a');
          leaveSearch(destination);
          const current = store.getState().fetchEmails(destination === 'reset' ? b : a);
          expect(reads[1].account).toBe(destination === 'clear' ? 'owner-a' : 'owner-b');
          if (!pending) { reads[1].reply.resolve(page('current-folder')); await current; }
          const before = snapshot();
          settle(reads[0], outcome, 'a-stale-search'); await old;
          expect(snapshot()).toEqual(before);
          if (pending) { reads[1].reply.resolve(page('current-folder')); await current; }
          visible(['current-folder'], scope(destination));
        });
      }
      it(`${kind}: delayed loading cannot resurrect a search after ${destination}`, async () => {
        const old = load(kind); // Do not yield to afterRequestDispatch yet.
        leaveSearch(destination);
        store.setState({ emails: [row('current')], isLoading: false, error: 'current error' });
        await tick();
        visible(['current'], { ...scope(destination), error: 'current error' });
        reads[0].reply.resolve(page('old-hit')); await old;
        visible(['current'], { ...scope(destination), error: 'current error' });
      });
    }
    it(`${kind}: navigation without starting another request rejects old results`, async () => {
      const old = load(kind); await tick();
      store.getState().selectAccountMailbox('login-b', 'inbox');
      store.setState({ emails: [row('b-visible')], isLoading: false, error: 'B error' });
      reads[0].reply.resolve(page('a-stale')); await old;
      visible(['b-visible'], { viewing: 'login-b', query: 'invoice', error: 'B error' });
    });
    it(`${kind}: checks ownership after onSearch before dispatching reads`, async () => {
      const transformed = deferred<{ query: string; filters: typeof DEFAULT_SEARCH_FILTERS }>();
      emailHooks.onSearch.register('ownership-test', () => transformed.promise);
      const old = load(kind);
      store.getState().selectAccountMailbox('login-b', 'inbox');
      store.setState({ emails: [row('b-visible')], isLoading: false });
      transformed.resolve({ query: 'invoice', filters: { ...DEFAULT_SEARCH_FILTERS } });
      await tick();
      // Settle an incorrectly dispatched read too, so the base fails an
      // ownership assertion rather than hanging on its mocked transport.
      for (const read of reads) read.reply.resolve(page('old'));
      await old;
      expect(reads).toHaveLength(0);
      visible(['b-visible'], { viewing: 'login-b', query: kind === 'advanced' ? 'invoice' : '' });
    });
  }

  for (const kind of kinds) {
    it(`${kind}: checks ownership after an awaited onEmailsFetched transform`, async () => {
      const transformed = deferred<Email[]>();
      const entered = deferred<void>();
      emailHooks.onEmailsFetched.register('ownership-test', (emails: Email[]) => {
        if (emails[0]?.id !== 'old') return emails;
        entered.resolve();
        return transformed.promise;
      });
      const old = load(kind); await tick();
      reads[0].reply.resolve(page('old')); await entered.promise;
      const current = load('quick'); await tick();
      reads[1].reply.resolve(page('new-hit')); await current;
      transformed.resolve([row('old')]); await old;
      visible(['new-hit'], { query: 'invoice' });
    });
  }

  it('keeps a newer current error when an old folder request completes', async () => {
    const old = load('folder');
    const current = load('quick'); await tick();
    reads[1].reply.reject(new Error('current error')); await current;
    reads[0].reply.resolve(page('old')); await old;
    visible([], { query: 'invoice', error: 'current error' });
  });
});

describe('pagination and refresh compatibility', () => {
  function seed() {
    store.setState({ emails: [row('head')], totalEmails: 2, hasMoreEmails: true });
  }
  it.each(['pagination', 'refresh'] as const)('%s still commits within the current view', async operation => {
    seed();
    const done = operation === 'pagination' ? store.getState().loadMoreEmails(a) : store.getState().refreshCurrentMailbox(a);
    expect(reads[0].account).toBe('owner-a');
    reads[0].reply.resolve(operation === 'pagination' ? page('page-two') : page('fresh-head'));
    await done;
    visible(operation === 'pagination' ? ['head', 'page-two'] : ['fresh-head']);
  });
  for (const operation of ['pagination', 'refresh'] as const) {
    for (const outcome of ['success', 'error'] as const) {
      it.each([false, true])(`${operation} before the query write preserves search ${outcome}, deferred=%s`, async delayed => {
        seed();
        const search = load('quick'); // searchQuery has not been written yet.
        const passive = operation === 'pagination'
          ? store.getState().loadMoreEmails(a) : store.getState().refreshCurrentMailbox(a);
        expect(reads[1].method).toBe('getEmails');
        if (delayed) await tick();
        settle(reads[0], outcome, 'search-hit'); await search;
        reads[1].reply.resolve(page('unfiltered-folder-row')); await passive;
        visible(outcome === 'success' ? ['search-hit'] : [], {
          query: 'invoice', error: outcome === 'error' ? 'stale failure' : null,
        });
      });
    }
  }
  it('starting pagination does not invalidate an in-flight refresh', async () => {
    seed();
    const refresh = store.getState().refreshCurrentMailbox(a);
    const more = store.getState().loadMoreEmails(a);
    reads[1].reply.resolve(page('page-two')); await more;
    reads[0].reply.resolve(page('fresh-head')); await refresh;
    visible(['fresh-head']);
  });
  it('starting refresh does not invalidate pagination', async () => {
    seed();
    const more = store.getState().loadMoreEmails(a);
    const refresh = store.getState().refreshCurrentMailbox(a);
    reads[1].reply.resolve(page('fresh-head')); await refresh;
    reads[0].reply.resolve(page('page-two')); await more;
    visible(['fresh-head', 'page-two']);
  });
  for (const operation of ['pagination', 'refresh'] as const) {
    it(`${operation}: navigation A -> B -> A drops the old response`, async () => {
      seed();
      const old = operation === 'pagination' ? store.getState().loadMoreEmails(a) : store.getState().refreshCurrentMailbox(a);
      store.getState().selectMailbox('later'); store.getState().selectMailbox('inbox');
      store.setState({ emails: [row('new-a')], isLoading: false });
      reads[0].reply.resolve(page('old-a')); await old;
      visible(['new-a']);
    });
    it(`${operation}: an older response cannot change a newer search`, async () => {
      seed();
      const old = operation === 'pagination' ? store.getState().loadMoreEmails(a) : store.getState().refreshCurrentMailbox(a);
      const current = load('quick'); await tick();
      reads[1].reply.resolve(page('search-hit')); await current;
      reads[0].reply.resolve(page('stale-page')); await old;
      visible(['search-hit'], { query: 'invoice' });
    });
  }
  for (const view of ['unified', 'cross'] as const) {
    it(`${view}: normal completion keeps account stamps and allows returning to a folder`, async () => {
      const accounts: UnifiedAccountClient[] = [{
        accountId: 'login-a', accountLabel: 'A', client: a, mailboxes: [mailbox('inbox')],
        clientAccountId: 'login-a', jmapAccountId: 'owner-a',
      }];
      const done = view === 'unified'
        ? store.getState().fetchUnifiedEmails(accounts, 'inbox')
        : store.getState().fetchCrossView(accounts, 'all');
      await vi.waitFor(() => expect(reads).toHaveLength(1));
      reads[0].reply.resolve(page('unified-head')); await done;
      visible(['unified-head']);
      expect(store.getState().emails[0]).toMatchObject({ sourceAccountId: 'owner-a', sourceClientAccountId: 'login-a' });
      // fetchEmails' virtual-id routing is covered by the existing dedicated tests;
      // leave this view through the real navigation action, not a manual flag edit.
      store.getState().selectMailbox('inbox');
      const folder = load('folder'); reads[1].reply.resolve(page('folder')); await folder;
      visible(['folder']);
    });
  }
});
