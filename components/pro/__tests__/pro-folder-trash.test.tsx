/** Real folder, reader, stores/actions, plugin hooks and scheduler; only client
 * services and browser APIs are mocked. No real mailbox access. */
import React from 'react';
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { useAuthStore } from '@/stores/auth-store';
import { useEmailStore } from '@/stores/email-store';
import { useSettingsStore } from '@/stores/settings-store';
import { usePolicyStore } from '@/stores/policy-store';
import { rememberedTrashOrigin } from '@/lib/trash-origin';
import { useToastStore } from '@/stores/toast-store';
import { clearAllHooks, emailHooks } from '@/lib/plugin-hooks';
import { clearUndoHistory, undoHistory } from '@/lib/undo-history';
import type { Email, Mailbox } from '@/lib/jmap/types';
import type { ProFolderTabData } from '@/stores/pro-tab-store';

import { PaneSizeContext } from '@/hooks/use-pane-size';
import { TourProvider } from '@/components/tour/tour-provider';
class NoopResizeObserver { observe() {} unobserve() {} disconnect() {} }
const { ToastContainer } = await import('@/components/ui/toast');
const { ProFolderTabBody } = await import('@/components/pro/pro-folder-tab-body');

function deferred<T = void>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
const clone = <T,>(value: T): T => JSON.parse(JSON.stringify(value));
function message(id: string): Email {
  return {
    id, threadId: id, blobId: `blob-${id}`, mailboxIds: { inbox: true }, keywords: { $seen: id === 'e2' },
    from: [{ name: `Sender ${id}`, email: 'sender@example.invalid' }], to: [{ email: 'reader@example.invalid' }],
    subject: `Subject ${id}`, receivedAt: '2026-11-07T00:00:00Z', preview: '', hasAttachment: false, size: 1,
    textBody: [{ partId: '1', type: 'text/plain', blobId: `body-${id}`, size: 1 }], htmlBody: [], attachments: [],
    bodyValues: { '1': { value: `Body ${id}`, isTruncated: false } },
  } as Email;
}
const folders: Mailbox[] = ['inbox', 'archive', 'trash'].map(id => ({
  id, name: id, role: id, accountId: 'owner', sortOrder: 0, isSubscribed: true,
  totalEmails: 2, totalThreads: 2, unreadEmails: 1, unreadThreads: 1,
  myRights: { mayReadItems: true, mayAddItems: true, mayRemoveItems: true, maySetSeen: true, maySetKeywords: true,
    mayCreateChild: true, mayRename: true, mayDelete: true, maySubmit: true },
}));
let server: Map<string, Email>;
let removal: ReturnType<typeof deferred<void>>;
let read: ReturnType<typeof deferred<void>>;
let restore: ReturnType<typeof deferred<void>>;
let clients: ReturnType<typeof makeClient>[];
function makeClient(owner = 'owner') {
  return {
    getAccountId: () => owner, getSieveAccountId: () => null, getUsername: () => 'reader@example.invalid',
    getEmails: vi.fn(async (mailbox?: string, account?: string) => {
      const id = account && account !== owner ? `${account}:${mailbox}` : mailbox;
      const emails = [...server.values()].filter(e => !id || e.mailboxIds[id]);
      return { emails: clone(emails), total: emails.length, hasMore: false };
    }),
    getEmail: vi.fn(async (id: string) => clone(server.get(id)!)),
    getAllMailboxes: vi.fn(async () => clone(folders)),
    markAsRead: vi.fn(async (id: string, seen: boolean, _account?: string) => {
      await read.promise; server.get(id)!.keywords.$seen = seen;
    }),
    moveToTrash: vi.fn(async (id: string, destination: string, _account?: string, _read?: boolean) => {
      await removal.promise; server.get(id)!.mailboxIds = { [_account && _account !== owner ? `${_account}:${destination}` : destination]: true };
    }),
    restoreEmails: vi.fn(async (points: Array<{id:string;mailboxIds:Record<string,boolean>;seen:boolean}>, _account?: string) => {
      await restore.promise;
      for (const point of points) { server.get(point.id)!.mailboxIds = Object.fromEntries(Object.keys(point.mailboxIds).map(id => [_account && _account !== owner ? `${_account}:${id}` : id, true])); server.get(point.id)!.keywords.$seen = point.seen; }
    }),
    deleteEmail: vi.fn(async () => { throw new Error('Permanent delete forbidden'); }),
    batchDeleteEmails: vi.fn(async () => { throw new Error('Permanent batch delete forbidden'); }),
  };
}
let client: ReturnType<typeof makeClient>;
const spyOnErrors = () => vi.spyOn(console, 'error').mockImplementation(() => {});
let errors: ReturnType<typeof spyOnErrors>;
let moved = vi.fn<() => void>();
let archived = vi.fn<() => void>();
let openingSharedReader = false;
let expectedErrors: string[];
const sharedReaderWarning = [
  'Cannot update a component (`%s`) while rendering a different component (`%s`). To locate the bad setState() call inside `%s`, follow the stack trace as described in https://react.dev/link/setstate-in-render',
  'EmailViewer', 'EmailViewer', 'EmailViewer',
];
const flush = async () => { await act(async () => {}); };
const advance = async (ms: number) => { await act(async () => { await vi.advanceTimersByTimeAsync(ms); }); };
function row(id = 'e1') {
  return screen.queryAllByRole('button', { name: new RegExp(`Sender ${id}`) })
    .find(el => el.tagName === 'DIV' && el.hasAttribute('tabindex')) ?? null;
}
const body = (id = 'e1') => screen.queryByText(`Body ${id}`);
const data: ProFolderTabData = { accountId: null, mailboxId: 'inbox', title: 'Inbox' };
function surface(folder = data) {
  return <PaneSizeContext.Provider value={1200}><TourProvider><ProFolderTabBody tabId="delete-folder" data={folder} /><Toasts /></TourProvider></PaneSizeContext.Provider>;
}
async function show(folder = data) {
  const view = render(surface(folder)); await flush(); return view;
}
async function open(id = 'e1') { fireEvent.click(row(id)!); await flush(); expect(body(id)).toBeInTheDocument(); }
async function remove() { fireEvent.click(screen.getByTestId('reader-delete')); await flush(); }
const stillOpen = () => { expect(row()).toBeInTheDocument(); expect(body()).toBeInTheDocument(); };
const closed = () => { expect(row()).not.toBeInTheDocument(); expect(body()).not.toBeInTheDocument(); };
function globalAbsent() { expect(useEmailStore.getState().emails).toEqual([]); expect(useEmailStore.getState().selectedEmail).toBeNull(); }

beforeEach(() => {
  vi.useFakeTimers(); clearAllHooks(); clearUndoHistory(); openingSharedReader = false; expectedErrors = [];
  localStorage.removeItem('bulwark.trashOrigin.v1');
  useToastStore.getState().clearToasts();
  usePolicyStore.setState(usePolicyStore.getInitialState(), true);
  useEmailStore.setState(useEmailStore.getInitialState(), true);
  useEmailStore.setState({ mailboxes: clone(folders), selectedMailbox: '' });
  useSettingsStore.setState({ tourCompleted: true, markAsReadDelay: -1, deleteAction: 'trash', permanentlyDeleteJunk: false, confirmDelete: false, confirmArchive: false, singleKeyShortcuts: false, archiveMode: 'single' });
  server = new Map([['e1', message('e1')], ['e2', message('e2')]]);
  removal = deferred(); read = deferred(); restore = deferred(); client = makeClient(); clients = [client];
  useAuthStore.setState({ client: client as never, activeAccountId: 'login',
    getClientForAccount: ((id: string) => id === 'login' ? client : undefined) as never });
  vi.stubGlobal('ResizeObserver', NoopResizeObserver);
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    if (url === '/api/config') return new Response('{}', { status: 200, headers: { 'Content-Type': 'application/json' } });
    throw new Error(`Network forbidden in Trash regression: ${url}`);
  }));
  errors = spyOnErrors(); moved = vi.fn<() => void>(); archived = vi.fn<() => void>();
  emailHooks.onAfterEmailMove.register('move-observer', moved);
  emailHooks.onEmailArchive.register('archive-observer', archived);
});
afterEach(() => {
  for (const c of clients) { expect(c.deleteEmail).not.toHaveBeenCalled(); expect(c.batchDeleteEmails).not.toHaveBeenCalled(); }
  cleanup();
  expect(vi.mocked(fetch).mock.calls.every(([url]) => url === '/api/config')).toBe(true);
  // Opening a shared reader already produces this exact React warning on
  // untouched upstream, before Delete. Reject every other unexpected error.
  const unexpected = errors.mock.calls.filter(call => !(call[0] === 'Delete failed:' && expectedErrors.includes((call[1] as Error).message))
    && !(openingSharedReader && JSON.stringify(call) === JSON.stringify(sharedReaderWarning)));
  expect(unexpected).toEqual([]);
  vi.useRealTimers(); vi.unstubAllGlobals(); vi.restoreAllMocks(); clearAllHooks(); clearUndoHistory();
});


function Toasts() {
  const toasts = useToastStore(s => s.toasts);
  return <ToastContainer toasts={toasts} onClose={useToastStore.getState().removeToast} />;
}
function protectedState() {
 const s = useEmailStore.getState();
 return { emails: s.emails, selectedEmail: s.selectedEmail, selectedEmailKeys: s.selectedEmailKeys,
   mailboxes: s.mailboxes, accountMailboxes: s.accountMailboxes, tagCounts: s.tagCounts,
   unifiedCounts: s.unifiedCounts, crossUnreadCount: s.crossUnreadCount };
}
function checkProtected(before: ReturnType<typeof protectedState>) {
 const after = protectedState();
 for (const k of Object.keys(before) as (keyof typeof before)[]) expect(after[k]).toBe(before[k]);
}
const beforeDelete = vi.fn(() => true);
const afterDelete = vi.fn();
function observeHooks() {
 beforeDelete.mockClear(); afterDelete.mockClear();
 emailHooks.onBeforeEmailDelete.register('audit-observer', beforeDelete);
 emailHooks.onAfterEmailDelete.register('audit-observer', afterDelete);
}
function noDispatch() {
 for (const c of clients) { expect(c.moveToTrash).not.toHaveBeenCalled(); expect(c.restoreEmails).not.toHaveBeenCalled(); }
 expect(undoHistory()).toHaveLength(0); expect(useToastStore.getState().toasts).toEqual([]);
}

it('moves a folder-only message through the actual reader Delete after confirmed success', async () => {
 observeHooks(); await show(); await open(); globalAbsent(); const before = protectedState(); await remove();
 expect(client.moveToTrash).toHaveBeenCalledExactlyOnceWith('e1', 'trash', 'owner', false);
 stillOpen(); checkProtected(before); expect(undoHistory()).toHaveLength(0); expect(afterDelete).not.toHaveBeenCalled();
 await act(async () => removal.resolve()); closed(); globalAbsent();
 expect(afterDelete).toHaveBeenCalledExactlyOnceWith({emailIds:['e1'],permanent:false});
 expect(undoHistory()).toHaveLength(1);
});
it('dispatches a folder-only Delete after actual confirmation acceptance', async () => {
 useSettingsStore.setState({confirmDelete:true});await show();await open();await remove();
 const dialog=screen.getByRole('alertdialog');expect(client.moveToTrash).not.toHaveBeenCalled();
 fireEvent.click(within(dialog).getByRole('button',{name:'delete'}));await flush();
 expect(client.moveToTrash).toHaveBeenCalledExactlyOnceWith('e1','trash','owner',false);stillOpen();
 await act(async()=>removal.resolve());closed();
});
it('preserves the existing matching-global-list Delete behavior', async () => {
 const target=clone(server.get('e1')!);const unrelated=message('global-other');
 useEmailStore.setState({emails:[target,unrelated],selectedEmail:unrelated,selectedEmailKeys:new Set(['global-other'])});
 observeHooks();await show();await open();const before=protectedState();await remove();
 expect(client.moveToTrash).toHaveBeenCalledTimes(1);
 const args=client.moveToTrash.mock.calls[0];expect([args[0],args[1],args[2]??client.getAccountId(),args[3]]).toEqual(['e1','trash','owner',false]);
 stillOpen();checkProtected(before);await act(async()=>removal.resolve());closed();
 const state=useEmailStore.getState();expect(state.emails).toEqual([unrelated]);expect(state.selectedEmail).toBe(unrelated);
 expect(state.selectedEmailKeys).toBe(before.selectedEmailKeys);expect(afterDelete).toHaveBeenCalledTimes(1);expect(undoHistory()).toHaveLength(1);
 fireEvent.click(screen.getByRole('button',{name:'notifications.undo'}));await flush();
 expect(client.restoreEmails).toHaveBeenCalledTimes(1);expect(client.restoreEmails.mock.calls[0][0]).toEqual([{id:'e1',mailboxIds:{inbox:true},seen:false}]);
});


it('retains rows and global state on rejection, preserves the read deadline, then permits retry', async () => {
  useSettingsStore.setState({ markAsReadDelay: 3000 }); observeHooks();
  await show(); await open(); const before = protectedState(); await advance(1000); await remove();
  expectedErrors.push('trash refused');
  await act(async () => removal.reject(new Error('trash refused')));
  stillOpen(); checkProtected(before); expect(undoHistory()).toHaveLength(0); expect(afterDelete).not.toHaveBeenCalled();
  expect(useToastStore.getState().toasts).toEqual([expect.objectContaining({ type: 'error', title: 'error_deleting' })]);
  await advance(1999); expect(client.markAsRead).not.toHaveBeenCalled(); await advance(1);
  expect(client.markAsRead).toHaveBeenCalledExactlyOnceWith('e1', true, undefined);
  await act(async () => read.resolve());
  removal = deferred(); await remove(); expect(client.moveToTrash).toHaveBeenCalledTimes(2);
  await act(async () => removal.resolve()); closed(); expect(afterDelete).toHaveBeenCalledTimes(1); expect(undoHistory()).toHaveLength(1);
});

it('cancellation keeps the actual reader and delayed read while deduplicating the question', async () => {
  useSettingsStore.setState({ confirmDelete: true, markAsReadDelay: 3000 }); observeHooks();
  await show(); await open(); const before = protectedState(); await advance(1000); await remove(); await remove();
  expect(screen.getAllByRole('alertdialog')).toHaveLength(1);
  fireEvent.click(within(screen.getByRole('alertdialog')).getByRole('button', { name: 'cancel' })); await flush();
  stillOpen(); checkProtected(before); noDispatch(); expect(beforeDelete).not.toHaveBeenCalled();
  await advance(2000); expect(client.markAsRead).toHaveBeenCalledTimes(1); await act(async () => read.resolve());
});

it('deduplicates a deferred plugin veto, preserves the read intent and allows a later attempt', async () => {
  useSettingsStore.setState({ markAsReadDelay: 3000 });
  const gate = deferred<boolean>(); const veto = vi.fn(() => gate.promise);
  emailHooks.onBeforeEmailDelete.register('veto', veto);
  await show(); await open(); const before = protectedState(); await advance(1000); await remove(); await remove();
  expect(veto).toHaveBeenCalledExactlyOnceWith({ emailIds: ['e1'], permanent: false });
  expect(client.moveToTrash).not.toHaveBeenCalled(); stillOpen(); checkProtected(before);
  await act(async () => gate.resolve(false)); stillOpen(); noDispatch(); checkProtected(before);
  await advance(2000); expect(client.markAsRead).toHaveBeenCalledTimes(1); await act(async () => read.resolve());
  emailHooks.onBeforeEmailDelete.removePlugin('veto'); await remove();
  expect(client.moveToTrash).toHaveBeenCalledTimes(1); await act(async () => removal.resolve()); closed();
});

it('deduplicates requests and emits only delete completion hooks and one Undo', async () => {
  observeHooks(); await show(); await open(); await remove(); await remove();
  expect(client.moveToTrash).toHaveBeenCalledTimes(1); expect(beforeDelete).toHaveBeenCalledTimes(1);
  await act(async () => removal.resolve()); closed(); expect(afterDelete).toHaveBeenCalledTimes(1);
  expect(moved).not.toHaveBeenCalled(); expect(archived).not.toHaveBeenCalled(); expect(undoHistory()).toHaveLength(1);
});

it('reports missing owning Trash and retains the message without any destructive fallback', async () => {
  const boxes = clone(folders.filter(m => m.role !== 'trash'));
  useEmailStore.setState({ mailboxes: boxes }); expectedErrors.push('Trash mailbox not found - cannot move email to trash');
  await show(); await open(); const before = protectedState(); await remove(); stillOpen(); checkProtected(before);
  expect(rememberedTrashOrigin({ id: 'e1' }, folders)).toBeUndefined();
  expect(client.moveToTrash).not.toHaveBeenCalled(); expect(undoHistory()).toHaveLength(0);
  expect(useToastStore.getState().toasts).toEqual([expect.objectContaining({ type: 'error', title: 'error_deleting' })]);
});

it.each(['source', 'destination'])('honors explicit %s rights denial and rechecks after plugin approval', async denied => {
  const gate = deferred<boolean>(); emailHooks.onBeforeEmailDelete.register('gate', () => gate.promise);
  await show(); await open(); await remove(); expect(client.moveToTrash).not.toHaveBeenCalled();
  const boxes = clone(folders); boxes[denied === 'source' ? 0 : 2].myRights[denied === 'source' ? 'mayRemoveItems' : 'mayAddItems'] = false;
  act(() => useEmailStore.setState({ mailboxes: boxes }));
  await act(async () => gate.resolve(true)); stillOpen(); noDispatch();
  await remove(); noDispatch();
});

function scopedFolder(shared: boolean, matching = false) {
  const other = makeClient(); clients.push(other); const owner = shared ? 'team' : 'owner';
  const scoped = folders.map(m => ({ ...clone(m),
    id: shared ? `team:${m.id === 'trash' ? 'bin' : m.id}` : m.id === 'trash' ? 'other-trash' : m.id,
    ...(shared ? { originalId: m.id === 'trash' ? 'bin' : m.id, accountId: 'team', isShared: true } : {}),
  }));
  if (shared) for (const e of server.values()) e.mailboxIds = { 'team:inbox': true };
  const collision = { ...message('e1'), subject: 'Global collision', sourceClientAccountId: 'login', sourceAccountId: 'owner' };
  const listed = { ...clone(server.get('e1')!), sourceClientAccountId: 'other', sourceAccountId: owner };
  useEmailStore.setState({ accountMailboxes: { other: scoped, [owner]: [{ ...clone(folders[2]), id: 'wrong-cache-trash' }] },
    emails: matching ? [collision, listed] : [collision], selectedEmail: collision,
    selectedEmailKeys: new Set(['login/owner:e1']), viewingAccountId: 'login' });
  useAuthStore.setState({ getClientForAccount: ((id: string) => id === 'other' ? other : id === 'login' ? client : undefined) as never });
  other.getAllMailboxes.mockResolvedValue(clone(scoped));
  return { other, owner, scoped, collision, listed, data: { accountId: 'other', mailboxId: shared ? 'team:inbox' : 'inbox', title: 'Other Inbox' } };
}

it.each([false, true])('routes folder-only Trash and actual Undo through the owner (shared=%s), protecting colliding global state', async shared => {
  const scope = scopedFolder(shared); observeHooks();
  // Only the reader response has the full membership: Undo must not use the folder envelope.
  const memberships: Record<string, boolean> = shared ? { 'team:inbox': true, 'team:archive': true } : { inbox: true, archive: true };
  scope.other.getEmail.mockImplementation(async id => ({ ...clone(server.get(id)!), mailboxIds: memberships }));
  await show(scope.data); openingSharedReader = shared; await open(); const before = protectedState(); await remove();
  expect(scope.other.moveToTrash).toHaveBeenCalledExactlyOnceWith('e1', shared ? 'bin' : 'other-trash', scope.owner, false);
  expect(client.moveToTrash).not.toHaveBeenCalled(); stillOpen(); checkProtected(before);
  await act(async () => removal.resolve()); closed(); checkProtected(before);
  expect(rememberedTrashOrigin({ id: 'e1' }, scope.scoped)?.id).toBe(shared ? 'team:inbox' : 'inbox');
  expect(afterDelete).toHaveBeenCalledExactlyOnceWith({ emailIds: ['e1'], permanent: false });
  fireEvent.click(screen.getByRole('button', { name: 'notifications.undo' })); await flush();
  expect(scope.other.restoreEmails).toHaveBeenCalledExactlyOnceWith([{ id: 'e1', mailboxIds: { inbox: true, archive: true }, seen: false }], scope.owner);
  expect(client.restoreEmails).not.toHaveBeenCalled();
  await act(async () => restore.resolve());
  expect(client.getAllMailboxes).toHaveBeenCalledTimes(1);
  expect(scope.other.getAllMailboxes).not.toHaveBeenCalled();
  expect(useEmailStore.getState().mailboxes).toEqual(before.mailboxes);
  expect(server.get('e1')!.mailboxIds).toEqual(memberships);
  expect(server.get('e1')!.keywords.$seen).toBe(false);
  expect(undoHistory()).toHaveLength(0);
  fireEvent.click(screen.getByRole('button', { name: 'common.refresh' })); await flush(); expect(row()).toBeInTheDocument();
  expect(useEmailStore.getState().emails).toBe(before.emails); expect(useEmailStore.getState().selectedEmail).toBe(before.selectedEmail);
});

it.each([false, true])('completes only the matching global row and owner counters (shared=%s)', async shared => {
  const scope = scopedFolder(shared, true); observeHooks(); await show(scope.data); openingSharedReader = shared; await open();
  const before = protectedState(); await remove(); checkProtected(before); await act(async () => removal.resolve()); closed();
  const state = useEmailStore.getState(); expect(state.emails).toEqual([scope.collision]); expect(state.selectedEmail).toBe(scope.collision);
  expect(state.selectedEmailKeys).toBe(before.selectedEmailKeys); expect(state.mailboxes).toBe(before.mailboxes);
  expect(state.accountMailboxes[scope.owner]).toBe(before.accountMailboxes[scope.owner]);
  const boxes = state.accountMailboxes.other;
  expect(boxes.find(m => m.role === 'inbox')!.totalEmails).toBe(1);
  expect(boxes.find(m => m.role === 'inbox')!.unreadEmails).toBe(0);
  expect(boxes.find(m => m.role === 'trash')!.totalEmails).toBe(3);
  expect(boxes.find(m => m.role === 'trash')!.unreadEmails).toBe(2);
  expect(afterDelete).toHaveBeenCalledTimes(1); expect(undoHistory()).toHaveLength(1);
});

it("finds another login's owning Trash when absent from unrelated global mailbox metadata", async () => {
  const scope = scopedFolder(false); useEmailStore.setState({ mailboxes: clone(folders.filter(m => m.role !== 'trash')) });
  await show(scope.data); await open(); await remove();
  expect(scope.other.moveToTrash).toHaveBeenCalledExactlyOnceWith('e1', 'other-trash', 'owner', false);
  await act(async () => removal.resolve()); closed();
});

it.each([false, true])('never substitutes unrelated Trash for missing owning Trash (shared=%s)', async shared => {
  const scope = scopedFolder(shared); useEmailStore.setState({ accountMailboxes: { other: scope.scoped.filter(m => m.role !== 'trash'),
    [scope.owner]: [{ ...clone(folders[2]), id: 'wrong-cache-trash' }] } });
  expectedErrors.push('Trash mailbox not found - cannot move email to trash');
  await show(scope.data); openingSharedReader = shared; await open(); const before = protectedState(); await remove();
  stillOpen(); checkProtected(before); expect(scope.other.moveToTrash).not.toHaveBeenCalled(); expect(client.moveToTrash).not.toHaveBeenCalled();
  expect(useToastStore.getState().toasts).toEqual([expect.objectContaining({ type: 'error', title: 'error_deleting' })]);
});

it('uses the folder role instead of an unrelated globally selected Trash', async () => {
  useEmailStore.setState({ selectedMailbox: 'trash' }); await show(); await open(); await remove();
  expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();
  expect(client.moveToTrash).toHaveBeenCalledExactlyOnceWith('e1', 'trash', 'owner', false);
  await act(async () => removal.resolve()); closed();
});

it.each(['selection', 'reselection', 'client', 'login', 'mailbox', 'unmount', 'settings', 'disconnect'])('does not dispatch after %s changes during plugin approval', async change => {
  const gate = deferred<boolean>(); emailHooks.onBeforeEmailDelete.register('gate', () => gate.promise);
  const view = await show(); await open(); await remove();
  if (change === 'selection' || change === 'reselection') { await open('e2'); if (change === 'reselection') await open(); }
  else if (change === 'client') act(() => useAuthStore.setState({ client: makeClient() as never }));
  else if (change === 'login') act(() => useAuthStore.setState({ activeAccountId: 'replacement' }));
  else if (change === 'mailbox') { view.rerender(surface({ ...data, mailboxId: 'archive' })); await flush(); }
  else if (change === 'unmount') view.unmount();
  else if (change === 'settings') act(() => useSettingsStore.setState({ deleteAction: 'trash-and-read' }));
  else act(() => useAuthStore.setState({ getClientForAccount: () => undefined }));
  const before = protectedState(); await act(async () => gate.resolve(true)); checkProtected(before);
  expect(client.moveToTrash).not.toHaveBeenCalled(); expect(undoHistory()).toHaveLength(0);
});

it.each(['success', 'failure'])('protects a replacement selection on stale service %s', async outcome => {
  observeHooks(); await show(); await open(); await remove(); await open('e2'); const before = protectedState();
  if (outcome === 'success') await act(async () => removal.resolve());
  else { expectedErrors.push('late failure'); await act(async () => removal.reject(new Error('late failure'))); }
  expect(body('e2')).toBeInTheDocument(); expect(row('e2')).toBeInTheDocument(); checkProtected(before);
  expect(undoHistory()).toHaveLength(outcome === 'success' ? 1 : 0); expect(afterDelete).toHaveBeenCalledTimes(outcome === 'success' ? 1 : 0);
});

it.each(['client', 'login', 'mailbox', 'unmount', 'reselection'])('does not apply old UI completion after %s changes', async change => {
  observeHooks(); const view = await show(); await open(); await remove();
  if (change === 'client') act(() => useAuthStore.setState({ client: makeClient() as never }));
  else if (change === 'login') act(() => useAuthStore.setState({ activeAccountId: 'replacement' }));
  else if (change === 'mailbox') { view.rerender(surface({ ...data, mailboxId: 'archive' })); await flush(); }
  else if (change === 'unmount') view.unmount();
  else { await open('e2'); await open(); }
  await flush(); const before = protectedState(); await act(async () => removal.resolve()); checkProtected(before);
  if (change === 'reselection') stillOpen(); expect(afterDelete).toHaveBeenCalledTimes(1); expect(undoHistory()).toHaveLength(1);
});

it('keeps a changed global view and colliding message intact after service success', async () => {
  const target = clone(server.get('e1')!); useEmailStore.setState({ emails: [target], selectedEmail: target });
  await show(); await open(); await remove(); const replacement = { ...message('e1'), subject: 'Replacement global' };
  act(() => useEmailStore.setState({ viewToken: useEmailStore.getState().viewToken + 1, emails: [replacement], selectedEmail: replacement }));
  const before = protectedState(); await act(async () => removal.resolve()); checkProtected(before); closed();
});

it('uses current matching global fields and preserves a new global selection at completion', async () => {
  const target = clone(server.get('e1')!); const other = message('global-other');
  useEmailStore.setState({ emails: [target, other], selectedEmail: target }); await show(); await open(); await remove();
  act(() => useEmailStore.setState({ emails: [{ ...target, keywords: { $seen: true } }, other], selectedEmail: other }));
  await act(async () => removal.resolve());
  expect(useEmailStore.getState().emails).toEqual([other]); expect(useEmailStore.getState().selectedEmail).toBe(other);
  expect(useEmailStore.getState().mailboxes.find(m => m.id === 'inbox')!.unreadEmails).toBe(1);
});

it('revokes the pending automatic-read timer only after successful removal', async () => {
  useSettingsStore.setState({ markAsReadDelay: 3000 }); await show(); await open(); await advance(1000); await remove();
  expect(client.markAsRead).not.toHaveBeenCalled(); await act(async () => removal.resolve()); closed();
  await advance(10000); expect(client.markAsRead).not.toHaveBeenCalled();
});

it('revokes a read waiting inside the before-read hook after successful removal', async () => {
  useSettingsStore.setState({ markAsReadDelay: 3000 }); const gate = deferred<boolean>(); const before = vi.fn(() => gate.promise);
  emailHooks.onBeforeEmailReadStateChange.register('read', before);
  await show(); await open(); await advance(3000); expect(before).toHaveBeenCalledTimes(1); expect(client.markAsRead).not.toHaveBeenCalled();
  await remove(); await act(async () => removal.resolve()); closed(); await act(async () => gate.resolve(true));
  await advance(10000); expect(client.markAsRead).not.toHaveBeenCalled();
});

it('leaves an already dispatched read untouched', async () => {
  useSettingsStore.setState({ markAsReadDelay: 3000 }); await show(); await open(); await remove(); await advance(3000);
  expect(client.markAsRead).toHaveBeenCalledExactlyOnceWith('e1', true, undefined);
  await act(async () => removal.resolve()); closed(); await act(async () => read.resolve());
  expect(server.get('e1')!.keywords.$seen).toBe(true); await advance(10000); expect(client.markAsRead).toHaveBeenCalledTimes(1);
});

it('rejects an older in-flight folder Refresh after successful removal', async () => {
  await show(); await open(); await remove(); const response = { emails: clone([...server.values()]), total: 2, hasMore: false };
  const refresh = deferred<typeof response>(); client.getEmails.mockImplementationOnce(() => refresh.promise);
  fireEvent.click(screen.getByRole('button', { name: 'common.refresh' })); await flush();
  await act(async () => removal.resolve()); closed(); await act(async () => refresh.resolve(response)); closed();
});


it('reuses the owning Deleted Items name fallback when no mailbox has the Trash role', async () => {
  const boxes = clone(folders); boxes[2] = { ...boxes[2], role: undefined, name: 'Deleted Items', id: 'deleted-items' };
  useEmailStore.setState({ mailboxes: boxes }); await show(); await open(); await remove();
  expect(client.moveToTrash).toHaveBeenCalledExactlyOnceWith('e1', 'deleted-items', 'owner', false);
  await act(async () => removal.resolve()); closed();
});

it('preserves next-selection and selected-key completion for a globally selected matching row', async () => {
  const target = clone(server.get('e1')!); const next = clone(server.get('e2')!); const keys = new Set(['e1', 'e2']);
  useEmailStore.setState({ emails: [target, next], selectedEmail: target, selectedEmailKeys: keys });
  await show(); await open(); await remove(); await act(async () => removal.resolve()); closed();
  const state = useEmailStore.getState(); expect(state.emails).toEqual([next]); expect(state.selectedEmail).toBe(next);
  expect(state.selectedEmailKeys).toBe(keys);
});


it('restores through the original login after an active-login switch while refreshing the current global login', async () => {
  const scope = scopedFolder(false); await show(scope.data); await open(); await remove(); await act(async () => removal.resolve());
  const replacement = makeClient('replacement-owner'); clients.push(replacement);
  act(() => useAuthStore.setState({ client: replacement as never, activeAccountId: 'replacement' }));
  fireEvent.click(screen.getByRole('button', { name: 'notifications.undo' })); await flush();
  expect(scope.other.restoreEmails).toHaveBeenCalledExactlyOnceWith([{ id: 'e1', mailboxIds: { inbox: true }, seen: false }], 'owner');
  await act(async () => restore.resolve());
  expect(replacement.getAllMailboxes).toHaveBeenCalledTimes(1); expect(client.getAllMailboxes).not.toHaveBeenCalled();
  expect(scope.other.getAllMailboxes).not.toHaveBeenCalled(); expect(replacement.restoreEmails).not.toHaveBeenCalled();
});
