import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { useEmailStore } from '../email-store';
import { useAuthStore } from '../auth-store';
import { useSettingsStore } from '../settings-store';
import { useToastStore } from '../toast-store';
import { clearAllStores } from '@/lib/account-state-manager';
import { currentStoreEpoch } from '@/lib/store-epoch';
import { undoKeywordAction } from '@/lib/email-action-toast';
import { emailKeyFor } from '@/lib/thread-utils';
import type { IJMAPClient } from '@/lib/jmap/client-interface';
import type { Email, Mailbox } from '@/lib/jmap/types';

const mail = (owner: string, seen: boolean) => ({
  id: 'same', blobId: `${owner}-body`, subject: `${owner} message`,
  keywords: { $seen: seen, '$label:work': true, $flagged: true }, mailboxIds: { inbox: true },
  bodyValues: { body: { value: `${owner} body` } },
}) as unknown as Email;
const folder = (id: string, unread: number) => ({
  id, name: id, totalEmails: 12, totalThreads: 12, unreadEmails: unread, unreadThreads: unread,
}) as Mailbox;
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(yes => { resolve = yes; });
  return { promise, resolve };
}
function client(owner: string) {
  return { getAccountId: () => owner, batchUpdateKeywords: vi.fn().mockResolvedValue(undefined) } as unknown as IJMAPClient;
}
const snapshot = () => {
  const state = useEmailStore.getState();
  return JSON.parse(JSON.stringify({ keywords: state.emails.map(e => e.keywords), reader: state.selectedEmail,
    folders: state.mailboxes, tags: state.tagCounts, error: state.error }));
};
beforeEach(() => {
  useEmailStore.setState(useEmailStore.getInitialState(), true);
  useSettingsStore.setState({ emailKeywords: [{ id: 'work', label: 'Work', color: 'blue' }] } as never);
  useToastStore.setState({ toasts: [] });
  vi.stubGlobal('fetch', vi.fn(() => { throw new Error('Unexpected network'); }));
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

it.each([false, true])('keeps B unchanged after A keyword Undo confirms (restored seen=%s)', async restoredRead => {
  const ca = client('owner-a'), cb = client('owner-b');
  const serverA = mail('A', !restoredRead), serverB = mail('B', !restoredRead);
  const pending = deferred();
  vi.mocked(ca.batchUpdateKeywords).mockImplementation(() => pending.promise.then(() => {
    serverA.keywords.$seen = restoredRead;
  }));
  useAuthStore.setState({ client: ca, activeAccountId: 'login-a',
    getClientForAccount: ((id: string) => id === 'login-a' ? ca : cb) as never });
  useEmailStore.setState({ emails: [serverA], selectedEmail: serverA, selectedMailbox: 'inbox',
    mailboxes: [folder('inbox', 3)], tagCounts: { work: { total: 12, unread: 3 } } });
  expect(emailKeyFor(serverA)).toBe('same');
  const undo = undoKeywordAction(ca, [{ id: 'same', key: 'same', changes: { $seen: restoredRead } }],
    { undo: 'Undo', done: 'Done', failed: 'Failed', undone: 'Undone' });
  undo!.onClick();
  expect(ca.batchUpdateKeywords).toHaveBeenCalledWith(['same'], { 'keywords/$seen': restoredRead ? true : null }, undefined);
  const epoch = currentStoreEpoch();
  // The real account-switch lifecycle clears account-scoped state and advances
  // its epoch before the next login's unstamped rows are restored/loaded.
  clearAllStores();
  useAuthStore.setState({ client: cb, activeAccountId: 'login-b' });
  useEmailStore.setState({ emails: [serverB], selectedEmail: { ...serverB }, selectedMailbox: 'inbox',
    mailboxes: [folder('inbox', restoredRead ? 4 : 3)], tagCounts: { work: { total: 12, unread: restoredRead ? 4 : 3 } } });
  expect(currentStoreEpoch()).not.toBe(epoch);
  expect(emailKeyFor(serverB)).toBe('same');
  const before = snapshot();
  pending.resolve();
  await vi.waitFor(() => expect(useToastStore.getState().toasts.at(-1)?.title).toBe('Undone'));
  expect(serverA.keywords.$seen).toBe(restoredRead);
  expect(cb.batchUpdateKeywords).not.toHaveBeenCalled();
  const after = snapshot();
  if (process.env.KEYWORD_OWNERSHIP_OBSERVATIONS === '1') console.info('OWNERSHIP_OBSERVATION', JSON.stringify({
    restoredRead, before, after, serverASeen: serverA.keywords.$seen, serverBSeen: serverB.keywords.$seen,
    changed: Object.fromEntries(['folders', 'keywords', 'reader', 'tags'].map(k => [k, JSON.stringify(before[k]) !== JSON.stringify(after[k])])),
  }));
  // Separate assertions identify the introduced counter effect independently
  // of the keyword/tag/reader corruption already present on audited production.
  expect.soft(after.folders, 'folder counter completion ownership').toEqual(before.folders);
  expect.soft(after.keywords, 'message keyword completion ownership').toEqual(before.keywords);
  expect.soft(after.reader, 'reader completion ownership').toEqual(before.reader);
  expect.soft(after.tags, 'tag completion ownership').toEqual(before.tags);
});

it('keeps confirmed same-account restoration after folder navigation and matches a reader outside the list', async () => {
  const ca = client('owner-a'); const pending = deferred();
  vi.mocked(ca.batchUpdateKeywords).mockReturnValue(pending.promise);
  useAuthStore.setState({ client: ca, activeAccountId: 'login-a', getClientForAccount: (() => ca) as never });
  useEmailStore.setState({ emails: [mail('A', true)], selectedMailbox: 'inbox',
    mailboxes: [folder('inbox', 3), folder('archive', 4)], tagCounts: { work: { total: 12, unread: 3 } } });
  const restore = useEmailStore.getState().patchEmailKeywords(ca, 'same', { $seen: false }, 'same');
  const epoch = currentStoreEpoch();
  useEmailStore.getState().selectMailbox('archive');
  useEmailStore.setState({ emails: [], selectedEmail: { ...mail('A', true), mailboxIds: { archive: true } } });
  expect(currentStoreEpoch()).toBe(epoch);
  pending.resolve(); expect(await restore).toBe(true);
  expect(useEmailStore.getState().mailboxes.map(m => m.unreadEmails)).toEqual([3, 5]);
  expect(useEmailStore.getState().mailboxes.map(m => m.unreadThreads)).toEqual([3, 5]);
  expect(!!useEmailStore.getState().selectedEmail?.keywords.$seen).toBe(false);
  expect(useEmailStore.getState().selectedEmail?.bodyValues?.body?.value).toBe('A body');
});
