import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { markSelectionReadWithUndo } from '../email-action-toast';
import { useEmailStore } from '@/stores/email-store';
import { useAuthStore } from '@/stores/auth-store';
import { useSettingsStore } from '@/stores/settings-store';
import { clearAllStores } from '@/lib/account-state-manager';
import { clearAllHooks, emailHooks } from '@/lib/plugin-hooks';
import { forgetFolderLists } from '@/lib/folder-list-cache';
import { jmapError } from '@/lib/jmap/jmap-error';
import { clearUndoHistory, undoHistory } from '@/lib/undo-history';
import type { Email, Mailbox } from '@/lib/jmap/types';
import type { IJMAPClient } from '@/lib/jmap/client-interface';

const toast = vi.hoisted(() => ({ error: vi.fn(), success: vi.fn() }));
vi.mock('@/stores/toast-store', () => ({ toast }));
const words = { success: 'A marked read state', error: 'A bulk failed', labels: { undo: 'Undo', done: 'Done', failed: 'Undo failed' } };
function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
const mail = (id: string, read: boolean, folder = 'inbox'): Email => ({
  id, blobId: id, threadId: `t-${id}`, subject: `Synthetic ${id}`, mailboxIds: { [folder]: true },
  keywords: { $seen: read }, receivedAt: '2026-11-13T09:00:00Z', size: 10, hasAttachment: false,
}) as Email;
const boxes = ['inbox', 'archive'].map(id => ({ id, name: id, role: id,
  totalEmails: 2, totalThreads: 2, unreadEmails: 2, unreadThreads: 2, myRights: {} }) as Mailbox);
function makeClient() {
  return {
    getAccountId: () => 'owner-A',
    batchMarkAsRead: vi.fn<(...args: unknown[]) => Promise<void>>(),
    getEmails: vi.fn().mockResolvedValue({ emails: [mail('new-only', false)], hasMore: false, total: 1, threadCounts: {} }),
    getAllMailboxesWithState: vi.fn().mockResolvedValue({ mailboxes: boxes, states: {} }),
    getTagCounts: vi.fn().mockResolvedValue({}), getThreads: vi.fn().mockResolvedValue([]),
  };
}
let client: ReturnType<typeof makeClient>;
const asClient = () => client as unknown as IJMAPClient;
function visibleState() {
  const s = useEmailStore.getState();
  return { emails: s.emails, selection: [...s.selectedEmailKeys], loading: s.isLoading, error: s.error };
}
beforeEach(() => {
  clearAllHooks(); clearAllStores(); forgetFolderLists(); clearUndoHistory(); vi.clearAllMocks();
  useEmailStore.setState(useEmailStore.getInitialState(), true);
  client = makeClient();
  useAuthStore.setState({ activeAccountId: 'A', client: asClient() });
  useSettingsStore.setState({ emailKeywords: [], messageListOrder: [], disableThreading: true });
  useEmailStore.setState({ emails: [mail('a', false), mail('b', false)], mailboxes: boxes,
    selectedMailbox: 'inbox', selectedEmailKeys: new Set(['a', 'b']), isLoading: false });
  vi.stubGlobal('fetch', vi.fn(() => { throw new Error('Network denied in bulk feedback regression'); }));
});
afterEach(() => { expect(fetch).not.toHaveBeenCalled(); vi.unstubAllGlobals(); vi.restoreAllMocks(); clearAllHooks(); });
async function replaceList(navigation: string, read: boolean, currentClient = client) {
  const folder = navigation === 'folder' ? 'archive' : 'inbox';
  useEmailStore.setState({ mailboxes: boxes });
  if (navigation === 'folder') useEmailStore.getState().selectMailbox(folder);
  currentClient.getEmails.mockResolvedValue({ emails: [mail('new-only', !read, folder)], hasMore: false, total: 1, threadCounts: {} });
  // A real first-page read takes request ownership even in the same folder.
  await useEmailStore.getState().fetchEmails(currentClient as unknown as IJMAPClient, folder, { background: true });
  useEmailStore.setState({ selectedEmailKeys: new Set(['new-only']), isLoading: true, error: 'New view error' });
}
function refusal(outcome: string) {
  if (outcome === 'transport') return new TypeError('A transport outcome unknown');
  const error = jmapError(outcome === 'partial' ? 'A refused b' : 'A refused a and b', { type: 'forbidden' });
  error.jmapFailedIds = outcome === 'partial' ? ['b'] : ['a', 'b'];
  return error;
}

for (const read of [true, false]) for (const navigation of ['folder', 'refresh']) {
  it.each(['full', 'partial', 'transport'])(`read=${read} ${navigation} %s reports its own failure without touching the new view`, async outcome => {
    useEmailStore.getState().setEmails([mail('a', !read), mail('b', !read)]);
    const service = deferred<void>(); client.batchMarkAsRead.mockReturnValueOnce(service.promise);
    const running = markSelectionReadWithUndo(asClient(), read, words);
    expect(client.batchMarkAsRead).toHaveBeenCalledExactlyOnceWith(['a', 'b'], read, undefined);
    await replaceList(navigation, read); const before = visibleState();
    const error = refusal(outcome); service.reject(error); await running;
    expect(visibleState()).toEqual(before);
    expect(toast.error).toHaveBeenCalledExactlyOnceWith(words.error, error.message);
    expect(toast.success).not.toHaveBeenCalled(); expect(undoHistory()).toEqual([]);
  });
}

it.each(['folder', 'refresh'])('successful completion stays quiet after %s and does not consume its error', async navigation => {
  const service = deferred<void>(); client.batchMarkAsRead.mockReturnValueOnce(service.promise);
  const running = markSelectionReadWithUndo(asClient(), true, words);
  await replaceList(navigation, true); const before = visibleState();
  service.resolve(); await running;
  expect(visibleState()).toEqual(before);
  expect(toast.error).not.toHaveBeenCalled(); expect(toast.success).not.toHaveBeenCalled(); expect(undoHistory()).toEqual([]);
});

it.each(['B', 'A after B'])('suppresses abandoned-account failure feedback in %s', async destination => {
  const service = deferred<void>(); client.batchMarkAsRead.mockReturnValueOnce(service.promise);
  const running = markSelectionReadWithUndo(asClient(), true, words);
  const other = makeClient();
  clearAllStores(); useAuthStore.setState({ activeAccountId: 'B', client: other as never });
  if (destination === 'A after B') { clearAllStores(); useAuthStore.setState({ activeAccountId: 'A', client: asClient() }); }
  await replaceList('folder', true, destination === 'B' ? other : client);
  service.reject(refusal('full')); await running;
  expect(useEmailStore.getState()).toMatchObject({ error: 'New view error', isLoading: true });
  expect(toast.error).not.toHaveBeenCalled(); expect(toast.success).not.toHaveBeenCalled(); expect(undoHistory()).toEqual([]);
});

it.each(['veto', 'empty selection'])('does not turn %s into a failure', async kind => {
  if (kind === 'veto') emailHooks.onBeforeEmailReadStateChange.register('test-veto', () => false);
  else useEmailStore.setState({ selectedEmailKeys: new Set() });
  await markSelectionReadWithUndo(asClient(), true, words);
  expect(client.batchMarkAsRead).not.toHaveBeenCalled(); expect(toast.error).not.toHaveBeenCalled(); expect(undoHistory()).toEqual([]);
  if (kind === 'veto') expect(toast.success).not.toHaveBeenCalled();
});

it('reports an unexpected thrown failure after same-account navigation', async () => {
  const service = deferred<boolean>(); useEmailStore.setState({ batchMarkAsRead: () => service.promise });
  const running = markSelectionReadWithUndo(asClient(), true, words);
  await replaceList('folder', true); const before = visibleState();
  service.reject(new Error('Unexpected A failure')); await running;
  expect(visibleState()).toEqual(before);
  expect(toast.error).toHaveBeenCalledExactlyOnceWith(words.error, 'Unexpected A failure');
  expect(toast.success).not.toHaveBeenCalled(); expect(undoHistory()).toEqual([]);
});
