import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useEmailStore } from '../email-store';
import { useAuthStore } from '../auth-store';
import { useSettingsStore } from '../settings-store';
import { clearAllHooks, emailHooks } from '@/lib/plugin-hooks';
import { emailKeyFor, threadKeyFor } from '@/lib/thread-utils';
import type { Email, Mailbox } from '@/lib/jmap/types';
import type { IJMAPClient } from '@/lib/jmap/client-interface';

function deferred() {
  let resolve!: () => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<void>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
const makeClient = (account: string) => ({ getAccountId: () => account, markAsRead: vi.fn<(...args: unknown[]) => Promise<void>>() });
type Client = ReturnType<typeof makeClient>;
const asClient = (client: Client) => client as unknown as IJMAPClient;
let loginA: Client;
let loginB: Client;

function message(login: string, owner: string, seen?: boolean, shared = false): Email {
  return {
    id: 'same-id', threadId: 'same-thread', blobId: `${owner}-blob`, subject: owner,
    size: 42, hasAttachment: false,
    receivedAt: '2026-11-06T00:00:00Z', mailboxIds: { [shared ? `${owner}:inbox` : 'inbox']: true },
    keywords: { '$label:work': true, $flagged: true, ...(seen === undefined ? {} : { $seen: seen }) },
    sourceClientAccountId: login, sourceAccountId: owner,
  } as Email;
}
function folder(owner: string, seen?: boolean, shared = false): Mailbox {
  const unread = seen ? 0 : 1;
  return {
    id: shared ? `${owner}:inbox` : 'inbox', originalId: 'inbox', accountId: owner, isShared: shared,
    name: 'Inbox', role: 'inbox', totalEmails: 1, totalThreads: 1,
    unreadEmails: unread, unreadThreads: unread,
  } as Mailbox;
}
function seed(kind: 'logins' | 'shared', seen?: boolean) {
  const shared = kind === 'shared';
  if (shared) loginA.getAccountId = () => 'primary-account';
  const first = message('login-a', 'owner-a', seen, shared);
  const second = message(shared ? 'login-a' : 'login-b', 'owner-b', seen, shared);
  useEmailStore.setState({
    isUnifiedView: true, unifiedRole: 'inbox', emails: [first, second], selectedEmail: second,
    mailboxes: shared ? [folder('owner-a', seen, true), folder('owner-b', seen, true)] : [folder('owner-a', seen)],
    accountMailboxes: kind === 'shared' ? {} : { 'login-b': [folder('owner-b', seen)] },
    tagCounts: { work: { total: 2, unread: seen ? 0 : 2 } },
    threadEmailsCache: new Map([[threadKeyFor(first), [first]], [threadKeyFor(second), [second]]]),
  });
  return { first, second, client: kind === 'shared' ? loginA : loginB };
}
function pending(client: Client) {
  const request = deferred();
  client.markAsRead.mockImplementationOnce(() => request.promise);
  return request;
}
function act(row: Email, read: boolean) {
  return useEmailStore.getState().markAsRead(asClient(loginA), row.id, read, emailKeyFor(row));
}
function counts() {
  const state = useEmailStore.getState();
  return {
    folders: [...state.mailboxes, ...Object.values(state.accountMailboxes).flat()].map(m => ({
      owner: m.accountId, total: m.totalEmails, threads: m.totalThreads,
      unread: m.unreadEmails, unreadThreads: m.unreadThreads,
    })),
    tags: state.tagCounts,
  };
}
function expectRows(first: Email, second: Email) {
  const state = useEmailStore.getState();
  expect(state.emails).toEqual([first, second]);
  expect(state.selectedEmail).toEqual(second);
  expect(state.threadEmailsCache.get(threadKeyFor(first))).toEqual([first]);
  expect(state.threadEmailsCache.get(threadKeyFor(second))).toEqual([second]);
}
beforeEach(() => {
  clearAllHooks();
  useEmailStore.setState(useEmailStore.getInitialState(), true);
  loginA = makeClient('owner-a'); loginB = makeClient('owner-b');
  useAuthStore.setState({ activeAccountId: 'login-a', client: asClient(loginA) as never,
    getClientForAccount: ((id: string) => id === 'login-a' ? loginA : id === 'login-b' ? loginB : undefined) as never });
  useSettingsStore.setState({ emailKeywords: [{ id: 'work', label: 'Work', color: 'blue' }] } as never);
  vi.stubGlobal('fetch', vi.fn(() => { throw new Error('No network in read-state regressions'); }));
});
afterEach(() => {
  expect(globalThis.fetch).not.toHaveBeenCalled();
  vi.unstubAllGlobals();
  clearAllHooks();
});

for (const kind of ['logins', 'shared'] as const) {
  describe(`same id across ${kind}`, () => {
    for (const read of [true, false]) {
      it(`cleans up a failed ${read ? 'read' : 'unread'} and retries after navigation without clearing another pending action`, async () => {
        const { first, second, client } = seed(kind, !read);
        const before = counts();
        const other = pending(loginA);
        const otherResult = act(first, read);
        const request = pending(client);
        const failed = act(second, read);
        const rejection = expect(failed).rejects.toThrow('refused');
        const firstKey = `${emailKeyFor(first)}-${read}`;
        const secondKey = `${emailKeyFor(second)}-${read}`;
        expect(useEmailStore.getState().processingReadStatus).toEqual(new Set([firstKey, secondKey]));
        // Failure arrives after navigating to a different account/folder.
        useEmailStore.getState().selectAccountMailbox('login-a', 'archive');
        request.reject(new Error('refused'));
        await rejection;
        expect(useEmailStore.getState().processingReadStatus).toEqual(new Set([firstKey]));
        expect(counts()).toEqual(before);
        // Model a loaded folder after returning; use actual selection actions.
        useEmailStore.getState().selectMailbox('inbox');
        useEmailStore.getState().setEmails([first, second]);
        useEmailStore.getState().selectEmail(second);
        const retry = pending(client);
        const retried = act(second, read);
        expect(client.markAsRead.mock.calls.filter(call => call[2] === 'owner-b')).toEqual([
          [second.id, read, 'owner-b'], [second.id, read, 'owner-b'],
        ]);
        expectRowsAfterNavigation(first, second);
        retry.resolve(); expect(await retried).toBe(true);
        expect(useEmailStore.getState().processingReadStatus).toEqual(new Set([firstKey]));
        other.resolve(); expect(await otherResult).toBe(true);
        expect(useEmailStore.getState().processingReadStatus.size).toBe(0);
        const result = useEmailStore.getState();
        expect(result.emails).toEqual([first, second].map(e => ({ ...e, keywords: { ...e.keywords, $seen: read } })));
        expect(result.selectedEmail).toEqual(result.emails[1]);
        expect(counts()).toEqual({ folders: ['owner-a', 'owner-b'].map(owner => ({
          owner, total: 1, threads: 1, unread: read ? 0 : 1, unreadThreads: read ? 0 : 1,
        })), tags: { work: { total: 2, unread: read ? 0 : 2 } } });
      });

      it(`deduplicates pending ${read ? 'read' : 'unread'}, updates the right owner exactly once, and cleans up success`, async () => {
        const { first, second, client } = seed(kind, !read);
        const before = counts();
        const request = pending(client);
        const changing = act(second, read);
        expect(await act(second, read)).toBe(true);
        expect(client.markAsRead).toHaveBeenCalledExactlyOnceWith(second.id, read, 'owner-b');
        expectRows(first, second); expect(counts()).toEqual(before);
        request.resolve(); expect(await changing).toBe(true);
        const changed = { ...second, keywords: { ...second.keywords, $seen: read } };
        expectRows(first, changed);
        expect(useEmailStore.getState().processingReadStatus.size).toBe(0);
        const expected = { folders: [
          { owner: 'owner-a', total: 1, threads: 1, unread: read ? 1 : 0, unreadThreads: read ? 1 : 0 },
          { owner: 'owner-b', total: 1, threads: 1, unread: read ? 0 : 1, unreadThreads: read ? 0 : 1 },
        ], tags: { work: { total: 2, unread: 1 } } };
        expect(counts()).toEqual(expected);
        expect(await act(changed, read)).toBe(true);
        expect(client.markAsRead).toHaveBeenCalledTimes(1); expect(counts()).toEqual(expected);
      });
    }
  });
}

// Navigation clears thread caches, independently of mutation cleanup.
function expectRowsAfterNavigation(first: Email, second: Email) {
  const state = useEmailStore.getState();
  expect(state.emails).toEqual([first, second]);
  expect(state.selectedEmail).toEqual(second);
}

it.each([undefined, false])('already-unread $seen=%s sends no mutation and preserves counters and keywords', async seen => {
  const { first, second, client } = seed('logins', seen);
  const before = counts();
  expect(await act(second, false)).toBe(true);
  expect.soft(client.markAsRead).not.toHaveBeenCalled();
  expect.soft(counts()).toEqual(before); expectRows(first, second);
  expect(useEmailStore.getState().processingReadStatus.size).toBe(0);
});

it.each([undefined, false])('a genuine absent/false-to-read transition from %s updates counters once', async seen => {
  const { first, second, client } = seed('shared', seen);
  const request = pending(client); const changing = act(second, true);
  request.resolve(); expect(await changing).toBe(true);
  expectRows(first, { ...second, keywords: { ...second.keywords, $seen: true } });
  expect(counts().folders.map(m => m.unread)).toEqual([1, 0]);
  expect(counts().folders.map(m => m.unreadThreads)).toEqual([1, 0]);
  expect(counts().tags.work).toEqual({ total: 2, unread: 1 });
  expect(await act(second, true)).toBe(true);
  expect(client.markAsRead).toHaveBeenCalledTimes(1);
  expect(counts().tags.work.unread).toBe(1);
});

it.each([undefined, false])('post-response comparison treats current $seen=%s as already unread', async seen => {
  const { first, second, client } = seed('logins', true);
  const request = pending(client); const changing = act(second, false);
  // An independent refresh has already reflected the requested change and its
  // counters while the mutation is pending. The late success must not add again.
  const refreshed = { ...second, keywords: { ...second.keywords } };
  delete refreshed.keywords.$seen;
  if (seen !== undefined) refreshed.keywords.$seen = seen;
  useEmailStore.setState({ emails: [first, refreshed], selectedEmail: refreshed,
    accountMailboxes: { 'login-b': [folder('owner-b', seen)] },
    tagCounts: { work: { total: 2, unread: 1 } },
    threadEmailsCache: new Map([[threadKeyFor(first), [first]], [threadKeyFor(refreshed), [refreshed]]]),
  });
  const before = counts();
  request.resolve(); expect(await changing).toBe(true);
  expect(counts()).toEqual(before); expectRows(first, refreshed);
  expect(useEmailStore.getState().processingReadStatus.size).toBe(0);
});

it('a scoped failure preserves an actual bare-id request pending for another view of the same id', async () => {
  const { first, second, client } = seed('logins');
  const bare = pending(loginA);
  const bareResult = useEmailStore.getState().markAsRead(asClient(loginA), first.id, true).catch((error: unknown) => error);
  const scoped = pending(client); const scopedResult = act(second, true);
  const scopedRejection = expect(scopedResult).rejects.toThrow('scoped failure');
  scoped.reject(new Error('scoped failure')); await scopedRejection;
  expect(useEmailStore.getState().processingReadStatus).toEqual(new Set([`${first.id}-true`]));
  bare.reject(new Error('bare failure')); expect(await bareResult).toEqual(new Error('bare failure'));
  expect(useEmailStore.getState().processingReadStatus.size).toBe(0);
  expectRows(first, second);
});

it.each([true, false])('plugin veto of read=%s cleans up only its own guard without a mutation', async read => {
  const { first, second, client } = seed('shared', !read);
  const other = pending(loginA); const otherResult = act(first, read);
  const before = counts();
  emailHooks.onBeforeEmailReadStateChange.register('veto', () => false);
  expect(await act(second, read)).toBe(false);
  expect(client.markAsRead).toHaveBeenCalledExactlyOnceWith(first.id, read, 'owner-a');
  expect(useEmailStore.getState().processingReadStatus).toEqual(new Set([`${emailKeyFor(first)}-${read}`]));
  expectRows(first, second); expect(counts()).toEqual(before);
  other.resolve(); await otherResult;
  expect(useEmailStore.getState().processingReadStatus.size).toBe(0);
});
