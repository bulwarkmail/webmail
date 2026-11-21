import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { useEmailStore } from '../email-store';
import { useAuthStore } from '../auth-store';
import { useSettingsStore } from '../settings-store';
import { clearAllStores } from '@/lib/account-state-manager';
import { clearAllHooks, emailHooks } from '@/lib/plugin-hooks';
import { jmapError } from '@/lib/jmap/jmap-error';
import type { Email, Mailbox } from '@/lib/jmap/types';
import type { IJMAPClient } from '@/lib/jmap/client-interface';

function deferred<T = void>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
const mail = (account: string, id: string, seen: boolean, folder = 'inbox'): Email => ({
  id, blobId: `${account}-${id}`, threadId: `t-${id}`, subject: `${account} ${id}`,
  mailboxIds: { [folder]: true }, keywords: { $seen: seen, '$label:work': true },
  receivedAt: '2026-11-13T09:00:00Z', size: 10, hasAttachment: false,
}) as Email;
const boxes = (unread: number): Mailbox[] => ['inbox', 'archive'].map(id => ({
  id, name: id, role: id, totalEmails: 2, totalThreads: 2, unreadEmails: unread,
  unreadThreads: unread, myRights: {},
}) as Mailbox);
function client(account: string) {
  return {
    getAccountId: () => `owner-${account}`,
    batchMarkAsRead: vi.fn<(...args: unknown[]) => Promise<void>>(),
    getTagCounts: vi.fn().mockResolvedValue({ work: { total: 2, unread: 0 } }),
  };
}
let a: ReturnType<typeof client>, b: ReturnType<typeof client>;
const asClient = (c: ReturnType<typeof client>) => c as unknown as IJMAPClient;
function seed(account: 'A' | 'B', seen: boolean) {
  const rows = [mail(account, 'shared', seen), mail(account, `${account.toLowerCase()}-only`, seen)];
  useAuthStore.setState({ client: asClient(account === 'A' ? a : b), activeAccountId: account });
  useEmailStore.setState({ emails: rows, selectedMailbox: 'inbox', mailboxes: boxes(seen ? 0 : 2),
    selectedEmailKeys: new Set(rows.map(e => e.id)), tagCounts: { work: { total: 2, unread: seen ? 0 : 2 } },
    isLoading: false, error: null });
  return rows;
}
function state() {
  const s = useEmailStore.getState();
  return { rows: s.emails, reader: s.selectedEmail, boxes: s.mailboxes, tags: s.tagCounts,
    selection: s.selectedEmailKeys, loading: s.isLoading, error: s.error };
}
function finish(service: ReturnType<typeof deferred<void>>, outcome: string) {
  if (outcome === 'accepted') service.resolve();
  else if (outcome === 'partial') {
    const error = jmapError('A refused a-only', { type: 'forbidden' });
    error.jmapFailedIds = ['a-only']; service.reject(error);
  } else service.reject(new TypeError('A outcome unknown'));
}
beforeEach(() => {
  clearAllHooks(); clearAllStores(); useEmailStore.setState(useEmailStore.getInitialState(), true);
  a = client('A'); b = client('B');
  useAuthStore.setState({ getClientForAccount: ((id: string) => id === 'A' ? asClient(a) : asClient(b)) as never });
  useSettingsStore.setState({ emailKeywords: [{ id: 'work', label: 'Work', color: 'blue' }],
    disableThreading: true, messageListOrder: [], emailsPerPage: 50 } as never);
});
afterEach(() => { clearAllHooks(); vi.restoreAllMocks(); });

for (const read of [true, false]) {
  it.each(['accepted', 'partial', 'rejected'])(`read=${read}: a %s completion for account A leaves account B's list alone`, async outcome => {
    seed('A', !read);
    const service = deferred(); a.batchMarkAsRead.mockReturnValueOnce(service.promise);
    const running = useEmailStore.getState().batchMarkAsRead(asClient(a), read);
    clearAllStores(); const rows = seed('B', !read);
    useEmailStore.setState({ selectedEmail: rows[0], selectedEmailKeys: new Set(['b-only']),
      isLoading: true, error: 'B folder refresh failed' });
    const before = state();
    finish(service, outcome);
    // The write went out for A; losing its list does not undo it.
    expect(await running).toBe(outcome !== 'rejected');
    expect(a.batchMarkAsRead).toHaveBeenCalledExactlyOnceWith(['shared', 'a-only'], read, undefined);
    expect(state()).toEqual(before);
    expect(b.batchMarkAsRead).not.toHaveBeenCalled();
  });

  it(`read=${read}: patches the rows of a folder opened meanwhile and keeps its selection`, async () => {
    seed('A', !read);
    const service = deferred(); a.batchMarkAsRead.mockReturnValueOnce(service.promise);
    const running = useEmailStore.getState().batchMarkAsRead(asClient(a), read);
    useEmailStore.getState().selectMailbox('archive');
    const latest = [mail('A', 'shared', !read, 'archive'), mail('A', 'archive-only', !read, 'archive')];
    const selected = new Set(['archive-only']);
    useEmailStore.setState({ emails: latest, selectedEmailKeys: selected });
    service.resolve(); expect(await running).toBe(true);
    expect(useEmailStore.getState().emails).toEqual(latest.map(e => e.id === 'shared'
      ? { ...e, keywords: { ...e.keywords, $seen: read } } : e));
    expect(useEmailStore.getState().selectedEmailKeys).toBe(selected);
  });
}

it('sends nothing when the account changed while a plugin was asked', async () => {
  seed('A', false);
  const answer = deferred<boolean>();
  emailHooks.onBeforeEmailReadStateChange.register('test-wait', () => answer.promise);
  const running = useEmailStore.getState().batchMarkAsRead(asClient(a), true);
  clearAllStores(); seed('B', false); const before = state();
  answer.resolve(true);
  expect(await running).toBe(false);
  expect(a.batchMarkAsRead).not.toHaveBeenCalled(); expect(b.batchMarkAsRead).not.toHaveBeenCalled();
  expect(state()).toEqual(before);
});

it("drops tag counts that arrive after a switch to another account", async () => {
  seed('A', false);
  const counts = deferred<Record<string, { total: number; unread: number }>>();
  a.getTagCounts.mockReturnValueOnce(counts.promise);
  const running = useEmailStore.getState().fetchTagCounts(asClient(a));
  clearAllStores(); seed('B', false);
  counts.resolve({ work: { total: 99, unread: 99 } }); await running;
  expect(useEmailStore.getState().tagCounts).toEqual({ work: { total: 2, unread: 2 } });
});
