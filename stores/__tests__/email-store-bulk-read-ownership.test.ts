import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { useEmailStore } from '../email-store';
import { useAuthStore } from '../auth-store';
import { useSettingsStore } from '../settings-store';
import { clearAllStores } from '@/lib/account-state-manager';
import { clearAllHooks } from '@/lib/plugin-hooks';
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
    getEmails: vi.fn().mockResolvedValue({ emails: [], hasMore: false, total: 0, threadCounts: {} }),
    getAllMailboxesWithState: vi.fn().mockResolvedValue({ mailboxes: boxes(0), states: {} }),
    getTagCounts: vi.fn().mockResolvedValue({ work: { total: 2, unread: 0 } }),
    getThreads: vi.fn().mockResolvedValue([]),
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
  vi.stubGlobal('fetch', vi.fn(() => { throw new Error('Network denied in bulk completion regression'); }));
});
afterEach(() => {
  expect(fetch).not.toHaveBeenCalled(); vi.unstubAllGlobals(); clearAllHooks(); vi.restoreAllMocks();
});

for (const read of [true, false]) {
  it.each(['accepted', 'partial', 'rejected'])(`read=${read}: %s A completion leaves B's state and pending loading/error alone`, async outcome => {
    seed('A', !read);
    const service = deferred(); a.batchMarkAsRead.mockReturnValueOnce(service.promise);
    const running = useEmailStore.getState().batchMarkAsRead(asClient(a), read);
    clearAllStores(); const rows = seed('B', !read);
    useEmailStore.setState({ selectedEmail: rows[0], selectedEmailKeys: new Set(['b-only']),
      isLoading: true, error: 'B folder refresh failed' });
    const before = state();
    finish(service, outcome);
    // Dispatch happened on A. Losing the UI does not turn its acceptance into cancellation.
    expect(await running).toBe(outcome !== 'rejected');
    expect(a.batchMarkAsRead).toHaveBeenCalledExactlyOnceWith(['shared', 'a-only'], read, undefined);
    expect(state()).toEqual(before);
    expect(b.getEmails).not.toHaveBeenCalled(); expect(b.batchMarkAsRead).not.toHaveBeenCalled();
  });

  it.each(['accepted', 'partial'])(`read=${read}: A-B-A %s reconciles from the server without restoring old rows or selection`, async outcome => {
    seed('A', !read);
    const service = deferred(); a.batchMarkAsRead.mockReturnValueOnce(service.promise);
    const running = useEmailStore.getState().batchMarkAsRead(asClient(a), read);
    clearAllStores(); seed('B', !read); clearAllStores(); seed('A', !read);
    const latest = [mail('latest A', 'shared', !read), mail('latest A', 'new-only', !read)];
    const selected = new Set(['new-only']);
    useEmailStore.setState({ emails: latest, selectedEmailKeys: selected, isLoading: true, error: 'New A view error' });
    const authoritative = latest.map(e => e.id === 'shared' ? { ...e, keywords: { ...e.keywords, $seen: read } } : e);
    a.getEmails.mockResolvedValueOnce({ emails: authoritative, hasMore: false, total: 2, threadCounts: {} });
    finish(service, outcome); expect(await running).toBe(true);
    await vi.waitFor(() => expect(useEmailStore.getState().emails).toEqual(authoritative));
    expect(a.getEmails).toHaveBeenCalledTimes(1);
    expect(useEmailStore.getState().selectedEmailKeys).toBe(selected);
    expect(useEmailStore.getState()).toMatchObject({ isLoading: true, error: 'New A view error' });
  });

  it(`read=${read}: patches current folder rows and preserves a newer folder's selection/loading/error`, async () => {
    const original = seed('A', !read);
    original[0].mailboxIds.archive = true;
    const service = deferred(); a.batchMarkAsRead.mockReturnValueOnce(service.promise);
    const running = useEmailStore.getState().batchMarkAsRead(asClient(a), read);
    useEmailStore.getState().selectMailbox('archive');
    const latest = [mail('new archive', 'shared', !read, 'archive'), mail('new archive', 'archive-only', !read, 'archive')];
    const selected = new Set(['archive-only']);
    useEmailStore.setState({ emails: latest, selectedEmailKeys: selected, isLoading: true, error: 'Archive read error' });
    service.resolve(); expect(await running).toBe(true);
    expect(useEmailStore.getState().emails).toEqual(latest.map(e => e.id === 'shared'
      ? { ...e, keywords: { ...e.keywords, $seen: read } } : e));
    expect(useEmailStore.getState().selectedEmailKeys).toBe(selected);
    expect(useEmailStore.getState()).toMatchObject({ isLoading: true, error: 'Archive read error' });
  });
}

it.each([false, true])('a second switch drops reconciliation, including an already pending refresh (%s)', async alreadyPending => {
  seed('A', false); const write = deferred(); a.batchMarkAsRead.mockReturnValueOnce(write.promise);
  const running = useEmailStore.getState().batchMarkAsRead(asClient(a), true);
  clearAllStores(); seed('B', false); clearAllStores(); seed('A', false);
  const page = deferred<{ emails: Email[]; hasMore: boolean; total: number }>();
  const folders = deferred<{ mailboxes: Mailbox[]; states: Record<string, string> }>();
  const tags = deferred<{ work: { total: number; unread: number } }>();
  a.getEmails.mockReturnValueOnce(page.promise); a.getAllMailboxesWithState.mockReturnValueOnce(folders.promise);
  a.getTagCounts.mockReturnValueOnce(tags.promise);
  const earlier = alreadyPending ? Promise.all([
    useEmailStore.getState().refreshCurrentMailbox(asClient(a)),
    useEmailStore.getState().fetchMailboxes(asClient(a)),
    useEmailStore.getState().fetchTagCounts(asClient(a)),
  ]) : Promise.resolve();
  write.resolve(); await running;
  await vi.waitFor(() => expect(a.getTagCounts).toHaveBeenCalledTimes(1));
  clearAllStores(); seed('B', false); const before = state();
  page.resolve({ emails: [mail('A late reconciliation', 'shared', true)], hasMore: false, total: 1 });
  folders.resolve({ mailboxes: boxes(0), states: {} }); tags.resolve({ work: { total: 99, unread: 99 } });
  await Promise.all([page.promise, folders.promise, tags.promise, earlier]);
  await new Promise(resolve => setTimeout(resolve, 0));
  expect(state()).toEqual(before);
});
