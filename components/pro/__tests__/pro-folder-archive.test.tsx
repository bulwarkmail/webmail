/** Real folder, reader, stores/actions, plugin hooks and scheduler; only client
 * services and browser/presentation APIs are mocked. No real mailbox access. */
import React from 'react';
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { useAuthStore } from '@/stores/auth-store';
import { useEmailStore } from '@/stores/email-store';
import { useSettingsStore } from '@/stores/settings-store';
import { usePolicyStore } from '@/stores/policy-store';
import { useToastStore } from '@/stores/toast-store';
import { clearAllHooks, emailHooks } from '@/lib/plugin-hooks';
import { clearUndoHistory, undoHistory } from '@/lib/undo-history';
import type { Email, Mailbox } from '@/lib/jmap/types';
import type { ProFolderTabData } from '@/stores/pro-tab-store';

vi.mock('@/hooks/use-media-query', () => ({
  useDeviceDetection: () => ({ isMobile: false, isTablet: false, isDesktop: true }),
  useMediaQuery: () => false, useIsDesktop: () => true,
}));
vi.mock('@/components/tour/tour-provider', () => ({
  useTour: () => ({ activeTour: null, startTour: vi.fn(), endTour: vi.fn(), registerStep: vi.fn() }),
}));
vi.mock('@/components/plugins/plugin-slot', () => ({ PluginSlot: () => null }));
vi.mock('@/hooks/use-plugin-slot-offers', () => ({ usePluginSlotOffers: () => [] }));
class NoopResizeObserver { observe() {} unobserve() {} disconnect() {} }
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
function makeClient(owner = 'owner') {
  return {
    getAccountId: () => owner, getSieveAccountId: () => null, getUsername: () => 'reader@example.invalid',
    getEmails: vi.fn(async () => ({ emails: clone([...server.values()]), total: server.size, hasMore: false })),
    getEmail: vi.fn(async (id: string) => clone(server.get(id)!)),
    getAllMailboxes: vi.fn(async () => clone(folders)),
    markAsRead: vi.fn(async (id: string, seen: boolean, _account?: string) => {
      await read.promise; server.get(id)!.keywords.$seen = seen;
    }),
    moveEmail: vi.fn(async (id: string, destination: string, _account?: string) => {
      await removal.promise; server.get(id)!.mailboxIds = { [destination]: true };
    }),
    restoreEmails: vi.fn(async (_points: unknown, _account?: string) => {}),
  };
}
let client: ReturnType<typeof makeClient>;
const spyOnErrors = () => vi.spyOn(console, 'error').mockImplementation(() => {});
let errors: ReturnType<typeof spyOnErrors>;
let moved = vi.fn<() => void>();
let archived = vi.fn<() => void>();
let openingSharedReader = false;
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
async function show(folder = data) {
  const view = render(<ProFolderTabBody tabId="archive-folder" data={folder} />); await flush(); return view;
}
async function open(id = 'e1') { fireEvent.click(row(id)!); await flush(); expect(body(id)).toBeInTheDocument(); }
async function archive() { fireEvent.click(screen.getByTitle(/^archive(?:\s|$)/)); await flush(); }
const stillOpen = () => { expect(row()).toBeInTheDocument(); expect(body()).toBeInTheDocument(); };
const closed = () => { expect(row()).not.toBeInTheDocument(); expect(body()).not.toBeInTheDocument(); };
function globalAbsent() { expect(useEmailStore.getState().emails).toEqual([]); expect(useEmailStore.getState().selectedEmail).toBeNull(); }

beforeEach(() => {
  vi.useFakeTimers(); clearAllHooks(); clearUndoHistory(); openingSharedReader = false;
  useToastStore.getState().clearToasts();
  usePolicyStore.setState(usePolicyStore.getInitialState(), true);
  useEmailStore.setState(useEmailStore.getInitialState(), true);
  useEmailStore.setState({ mailboxes: clone(folders), selectedMailbox: 'inbox' });
  useSettingsStore.setState({ markAsReadDelay: 3000, confirmArchive: false, singleKeyShortcuts: false, archiveMode: 'single' });
  server = new Map([['e1', message('e1')], ['e2', message('e2')]]);
  removal = deferred(); read = deferred(); client = makeClient();
  useAuthStore.setState({ client: client as never, activeAccountId: 'login',
    getClientForAccount: ((id: string) => id === 'login' ? client : undefined) as never });
  vi.stubGlobal('ResizeObserver', NoopResizeObserver);
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    if (url === '/api/config') return new Response('{}', { status: 200, headers: { 'Content-Type': 'application/json' } });
    throw new Error(`Network forbidden in Archive regression: ${url}`);
  }));
  errors = spyOnErrors(); moved = vi.fn<() => void>(); archived = vi.fn<() => void>();
  emailHooks.onAfterEmailMove.register('move-observer', moved);
  emailHooks.onEmailArchive.register('archive-observer', archived);
});
afterEach(() => {
  cleanup();
  expect(vi.mocked(fetch).mock.calls.every(([url]) => url === '/api/config')).toBe(true);
  // Opening a shared reader already produces this exact React warning on
  // untouched upstream, before Archive. Reject every other unexpected error.
  const unexpected = errors.mock.calls.filter(call => call[0] !== 'Archive failed:'
    && !(openingSharedReader && JSON.stringify(call) === JSON.stringify(sharedReaderWarning)));
  expect(unexpected).toEqual([]);
  vi.useRealTimers(); vi.unstubAllGlobals(); vi.restoreAllMocks(); clearAllHooks(); clearUndoHistory();
});

it('archives the folder-only reader message only after confirmed success and cancels its delayed read', async () => {
  await show(); await open(); globalAbsent(); await advance(1000); await archive();
  expect(client.moveEmail).toHaveBeenCalledExactlyOnceWith('e1', 'archive', 'owner');
  stillOpen(); expect(undoHistory()).toHaveLength(0); expect(archived).not.toHaveBeenCalled();
  await act(async () => removal.resolve()); closed(); globalAbsent();
  expect(moved).toHaveBeenCalledTimes(1); expect(archived).toHaveBeenCalledExactlyOnceWith({ emailIds: ['e1'] });
  expect(undoHistory()).toHaveLength(1); await advance(10_000); expect(client.markAsRead).not.toHaveBeenCalled();
});

it('keeps refreshed row fields and the original read deadline when Archive rejects', async () => {
  await show(); await open(); await advance(1000); await archive();
  const refreshed = server.get('e1')!;
  refreshed.subject = 'Refreshed subject'; refreshed.preview = 'Fresh preview'; refreshed.keywords.custom = true;
  fireEvent.click(screen.getByRole('button', { name: 'common.refresh' })); await flush();
  await act(async () => removal.reject(new Error('move refused')));
  stillOpen(); globalAbsent(); expect(screen.getByText('Refreshed subject')).toBeInTheDocument();
  expect(screen.getByText('Fresh preview')).toBeInTheDocument();
  expect(undoHistory()).toHaveLength(0); expect(archived).not.toHaveBeenCalled();
  await advance(1999); expect(client.markAsRead).not.toHaveBeenCalled(); await advance(1);
  expect(client.markAsRead).toHaveBeenCalledExactlyOnceWith('e1', true, undefined);
  await act(async () => read.resolve()); expect(row()!.querySelector('.bg-primary')).toBeNull();
  expect(screen.getByText('Refreshed subject')).toBeInTheDocument();
});
it.each(['cancel', 'confirm'])('respects actual Archive confirmation: %s', async answer => {
  useSettingsStore.setState({ confirmArchive: true });
  await show(); await open(); await advance(1000); await archive();
  expect(screen.getByRole('alertdialog')).toBeInTheDocument(); expect(client.moveEmail).not.toHaveBeenCalled();
  fireEvent.click(within(screen.getByRole('alertdialog')).getByRole('button', { name: answer === 'cancel' ? 'cancel' : 'archive' }));
  await flush(); stillOpen();
  if (answer === 'cancel') {
    expect(client.moveEmail).not.toHaveBeenCalled(); await advance(2000);
    expect(client.markAsRead).toHaveBeenCalledTimes(1); await act(async () => read.resolve());
    expect(undoHistory()).toHaveLength(0);
  } else {
    expect(client.moveEmail).toHaveBeenCalledTimes(1); await act(async () => removal.resolve());
    closed(); await advance(10_000); expect(client.markAsRead).not.toHaveBeenCalled();
  }
});
it.each(['move', 'archive'])('preserves the delayed read when the %s plugin vetoes Archive', async hook => {
  const veto = vi.fn(() => false);
  (hook === 'move' ? emailHooks.onBeforeEmailMove : emailHooks.onBeforeEmailArchive).register('veto', veto);
  await show(); await open(); await advance(1000); await archive(); stillOpen();
  expect(veto).toHaveBeenCalledTimes(1); expect(client.moveEmail).not.toHaveBeenCalled();
  expect(moved).not.toHaveBeenCalled(); expect(archived).not.toHaveBeenCalled(); expect(undoHistory()).toHaveLength(0);
  await advance(2000); expect(client.markAsRead).toHaveBeenCalledTimes(1); await act(async () => read.resolve());
});
it('cancels dispatch when Archive succeeds while a before-read hook is pending', async () => {
  const gate = deferred(); const before = vi.fn(async () => { await gate.promise; return true; });
  emailHooks.onBeforeEmailReadStateChange.register('read-gate', before);
  await show(); await open(); await advance(3000); expect(before).toHaveBeenCalledTimes(1);
  expect(client.markAsRead).not.toHaveBeenCalled(); await archive(); stillOpen();
  await act(async () => removal.resolve()); closed(); await act(async () => gate.resolve());
  await advance(10_000); expect(client.markAsRead).not.toHaveBeenCalled();
});
it('leaves an already-dispatched read alone after successful Archive', async () => {
  const readEvents = vi.fn(); emailHooks.onEmailReadStateChange.register('read-observer', readEvents);
  await show(); await open(); await archive(); await advance(3000);
  expect(client.markAsRead).toHaveBeenCalledExactlyOnceWith('e1', true, undefined); stillOpen();
  await act(async () => removal.resolve()); closed(); await act(async () => read.resolve());
  expect(server.get('e1')!.keywords.$seen).toBe(true); expect(readEvents).toHaveBeenCalledTimes(1);
  await advance(10_000); expect(client.markAsRead).toHaveBeenCalledTimes(1);
  expect(client.restoreEmails).not.toHaveBeenCalled();
});
it('does not allow an older in-flight Refresh to reinsert a successfully archived row', async () => {
  await show(); await open(); await advance(1000); await archive();
  const response = { emails: clone([...server.values()]), total: 2, hasMore: false };
  const refresh = deferred<typeof response>(); client.getEmails.mockImplementationOnce(() => refresh.promise);
  fireEvent.click(screen.getByRole('button', { name: 'common.refresh' })); await flush();
  await act(async () => removal.resolve()); closed(); await act(async () => refresh.resolve(response)); closed();
  await advance(10_000); expect(client.markAsRead).not.toHaveBeenCalled(); globalAbsent();
});
it('deduplicates Archive clicks while confirmation or the request is pending', async () => {
  useSettingsStore.setState({ confirmArchive: true });
  await show(); await open(); await archive(); await archive();
  expect(screen.getAllByRole('alertdialog')).toHaveLength(1);
  fireEvent.click(within(screen.getByRole('alertdialog')).getByRole('button', { name: 'archive' })); await flush();
  await archive(); expect(client.moveEmail).toHaveBeenCalledTimes(1);
  await act(async () => removal.resolve()); closed(); expect(undoHistory()).toHaveLength(1);
});
it.each(['source', 'destination'])('honors an explicit %s rights denial', async denied => {
  const mailboxes = clone(folders);
  if (denied === 'source') mailboxes[0].myRights.mayRemoveItems = false;
  else mailboxes[1].myRights.mayAddItems = false;
  useEmailStore.setState({ mailboxes }); await show(); await open(); await archive();
  stillOpen(); expect(client.moveEmail).not.toHaveBeenCalled(); expect(undoHistory()).toHaveLength(0);
});
it('keeps Archive hidden when policy disables it', async () => {
  const policy = usePolicyStore.getState().policy;
  usePolicyStore.setState({ policy: { ...policy, features: { ...policy.features, archiveActionEnabled: false } } });
  await show(); await open(); expect(screen.queryByTitle(/^archive(?:\s|$)/)).not.toBeInTheDocument();
  expect(client.moveEmail).not.toHaveBeenCalled(); stillOpen();
});
it.each(['selection', 'policy'])('does not dispatch after a %s change while the archive plugin waits', async change => {
  const gate = deferred(); emailHooks.onBeforeEmailArchive.register('archive-gate', async () => { await gate.promise; return true; });
  await show(); await open(); await archive(); expect(client.moveEmail).not.toHaveBeenCalled();
  if (change === 'selection') await open('e2');
  else {
    const policy = usePolicyStore.getState().policy;
    act(() => usePolicyStore.setState({ policy: { ...policy, features: { ...policy.features, archiveActionEnabled: false } } }));
  }
  await act(async () => gate.resolve()); expect(client.moveEmail).not.toHaveBeenCalled(); expect(undoHistory()).toHaveLength(0);
});
it.each(['success', 'failure'])('does not close or overwrite a replacement reader after stale Archive %s', async outcome => {
  await show(); await open(); await archive(); await open('e2');
  const global = useEmailStore.getState();
  if (outcome === 'success') await act(async () => removal.resolve());
  else await act(async () => removal.reject(new Error('late failure')));
  expect(body('e2')).toBeInTheDocument(); expect(row('e2')).toBeInTheDocument();
  expect(useEmailStore.getState()).toBe(global); expect(undoHistory()).toHaveLength(outcome === 'success' ? 1 : 0);
});
it('does not close a newly selected reader with the same message id after stale success', async () => {
  await show(); await open(); await archive(); await open('e2'); await open();
  await act(async () => removal.resolve()); stillOpen(); expect(undoHistory()).toHaveLength(1);
});
it.each(['client', 'login', 'mailbox', 'unmount'])('ignores old UI completion after a %s context change', async change => {
  const view = await show(); await open(); await archive();
  if (change === 'client') {
    const replacement = makeClient();
    act(() => useAuthStore.setState({ client: replacement as never }));
  } else if (change === 'login') act(() => useAuthStore.setState({ activeAccountId: 'replacement-login' }));
  else if (change === 'mailbox') view.rerender(<ProFolderTabBody tabId="archive-folder" data={{ ...data, mailboxId: 'other' }} />);
  else view.unmount();
  await flush();
  if (change !== 'unmount') await open();
  const state = useEmailStore.getState(); await act(async () => removal.resolve());
  if (change !== 'unmount') stillOpen();
  expect(useEmailStore.getState()).toBe(state); expect(undoHistory()).toHaveLength(1);
});
it.each(['other-login', 'shared'])('routes %s Archive and Undo independently of colliding global ids', async scope => {
  const other = makeClient();
  const shared = scope === 'shared'; const owner = shared ? 'team' : 'owner';
  const own = clone(folders);
  const scoped = shared ? folders.map(m => ({ ...clone(m), id: `team:${m.id}`, originalId: m.id,
    accountId: 'team', isShared: true })) : clone(folders);
  if (shared) for (const email of server.values()) email.mailboxIds = { 'team:inbox': true };
  const globalMessage = { ...message('e1'), subject: 'Global collision', sourceClientAccountId: 'login', sourceAccountId: 'owner' };
  useEmailStore.setState({ mailboxes: own, accountMailboxes: { other: [...own, ...scoped] },
    emails: [globalMessage], selectedEmail: globalMessage, selectedEmailKeys: new Set(['owner:e1']),
    viewingAccountId: 'login' });
  useAuthStore.setState({ getClientForAccount: ((id: string) => id === 'other' ? other : id === 'login' ? client : undefined) as never });
  const snapshot = useEmailStore.getState();
  await show({ accountId: 'other', mailboxId: shared ? 'team:inbox' : 'inbox', title: 'Other Inbox' });
  openingSharedReader = shared; await open(); await archive();
  expect(other.getEmail).toHaveBeenCalledWith('e1', owner);
  expect(other.moveEmail).toHaveBeenCalledExactlyOnceWith('e1', 'archive', owner);
  expect(client.moveEmail).not.toHaveBeenCalled();
  expect(useEmailStore.getState()).toBe(snapshot);
  await act(async () => removal.resolve()); closed(); expect(useEmailStore.getState()).toBe(snapshot);
  expect(moved).toHaveBeenCalledExactlyOnceWith({ emailIds: ['e1'], fromMailboxId: shared ? 'team:inbox' : 'inbox',
    toMailboxId: shared ? 'team:archive' : 'archive' });
  const undo = useToastStore.getState().toasts.find(t => t.action)?.action;
  expect(undo).toBeDefined(); act(() => undo!.onClick()); await flush();
  expect(other.restoreEmails).toHaveBeenCalledWith([{ id: 'e1', mailboxIds: { inbox: true }, seen: false }], owner);
  expect(client.restoreEmails).not.toHaveBeenCalled();
});

it('preserves the existing global-list Pro reader Archive path', async () => {
  useSettingsStore.setState({ markAsReadDelay: -1 });
  useEmailStore.setState({ emails: [clone(server.get('e1')!)], selectedEmail: clone(server.get('e1')!) });
  const { ProEmailView } = await import('@/components/pro/pro-email-tab-body'); const onClose = vi.fn();
  render(<ProEmailView emailId="e1" client={client as never} clientAccountId="login" onClose={onClose} />);
  await flush(); await archive();
  expect(client.moveEmail).toHaveBeenCalledExactlyOnceWith('e1', 'archive', undefined);
  expect(useEmailStore.getState().emails).toHaveLength(1); expect(onClose).not.toHaveBeenCalled();
  await act(async () => removal.resolve()); expect(useEmailStore.getState().emails).toEqual([]);
  expect(onClose).toHaveBeenCalledOnce(); expect(archived).toHaveBeenCalledOnce(); expect(undoHistory()).toHaveLength(1);
});

it('does not dispatch through a fallback login when its owning login disconnects during plugin approval', async () => {
  const other = makeClient(); let connected = true;
  useEmailStore.setState({ accountMailboxes: { other: clone(folders) } });
  useAuthStore.setState({ getClientForAccount: ((id: string) => id === 'other' && connected ? other : undefined) as never });
  const gate = deferred(); emailHooks.onBeforeEmailArchive.register('wait', async () => { await gate.promise; return true; });
  await show({ ...data, accountId: 'other' }); await open(); await archive(); connected = false;
  await act(async () => gate.resolve());
  expect(client.moveEmail).not.toHaveBeenCalled(); expect(other.moveEmail).not.toHaveBeenCalled(); stillOpen();
});
it('takes its Undo restore point from the full reader message rather than the folder summary', async () => {
  const full = { ...message('e1'), mailboxIds: { inbox: true, label: true }, keywords: { $seen: true } };
  client.getEmail.mockResolvedValueOnce(full);
  await show(); await open(); await archive(); await act(async () => removal.resolve()); closed();
  const undo = useToastStore.getState().toasts.find(t => t.action)?.action;
  expect(undo).toBeDefined(); act(() => undo!.onClick()); await flush();
  expect(client.restoreEmails).toHaveBeenCalledWith([{ id: 'e1', mailboxIds: { inbox: true, label: true }, seen: true }], 'owner');
});

it('releases a failed Archive attempt for a deliberate retry', async () => {
  useSettingsStore.setState({ markAsReadDelay: -1 });
  await show(); await open(); await archive(); await act(async () => removal.reject(new Error('refused')));
  stillOpen(); removal = deferred(); await archive(); expect(client.moveEmail).toHaveBeenCalledTimes(2);
  await act(async () => removal.resolve()); closed(); expect(undoHistory()).toHaveLength(1);
});


it('preserves shared membership when Archive originates in the actual Pro folder reader', async () => {
  const listed = clone(server.get('e1')!);
  useEmailStore.setState({ emails: [listed], selectedEmail: listed });
  await show(); await open();
  const before = clone(useEmailStore.getState().mailboxes);
  await advance(1000); await archive();
  expect(client.moveEmail).toHaveBeenCalledTimes(1);
  expect(client.moveEmail.mock.calls[0].slice(0, 2)).toEqual(['e1', 'archive']);
  expect(client.moveEmail.mock.calls[0][2] ?? client.getAccountId()).toBe('owner');
  stillOpen(); expect(useEmailStore.getState().emails).toEqual([listed]);
  expect(useEmailStore.getState().selectedEmail).toEqual(listed);
  expect(useEmailStore.getState().mailboxes).toEqual(before);
  expect(moved).not.toHaveBeenCalled(); expect(archived).not.toHaveBeenCalled(); expect(undoHistory()).toHaveLength(0);
  await act(async () => removal.resolve());
  const state = useEmailStore.getState();
  console.info('PRO_FOLDER_SHARED_MEMBERSHIP', JSON.stringify({
    serviceCalls: client.moveEmail.mock.calls,
    folderRowVisible: !!row(), readerVisible: !!body(),
    globalRows: state.emails.map(email => email.id), globalSelection: state.selectedEmail?.id ?? null,
    counters: state.mailboxes.map(({ id, totalEmails, unreadEmails, totalThreads, unreadThreads }) =>
      ({ id, totalEmails, unreadEmails, totalThreads, unreadThreads })),
    moveHooks: moved.mock.calls.length, archiveHooks: archived.mock.calls.length, undo: undoHistory().length,
  }));
  closed(); expect(moved).toHaveBeenCalledTimes(1); expect(archived).toHaveBeenCalledTimes(1);
  expect(undoHistory()).toHaveLength(1);
  expect.soft(state.emails).toEqual([]); expect.soft(state.selectedEmail).toBeNull();
  expect.soft(state.mailboxes.find(mb => mb.id === 'inbox')).toMatchObject({ totalEmails: 1, unreadEmails: 0, totalThreads: 1, unreadThreads: 0 });
  expect.soft(state.mailboxes.find(mb => mb.id === 'archive')).toMatchObject({ totalEmails: 3, unreadEmails: 2, totalThreads: 3, unreadThreads: 2 });
  expect(state.mailboxes.find(mb => mb.id === 'trash')).toEqual(before.find(mb => mb.id === 'trash'));
});


it('leaves a colliding global message of another JMAP owner and its counters untouched', async () => {
  const collision = { ...message('e1'), sourceClientAccountId: 'login', sourceAccountId: 'team', mailboxIds: { 'team:inbox': true } };
  useEmailStore.setState({ emails: [collision], selectedEmail: collision });
  const snapshot = useEmailStore.getState();
  await show(); await open(); await archive(); await act(async () => removal.resolve()); closed();
  expect(useEmailStore.getState()).toBe(snapshot);
  expect(client.moveEmail).toHaveBeenCalledExactlyOnceWith('e1', 'archive', 'owner');
  expect(moved).toHaveBeenCalledTimes(1); expect(archived).toHaveBeenCalledTimes(1); expect(undoHistory()).toHaveLength(1);
});
it('removes only the matching global row when another login has the same message and owner ids', async () => {
  const matching = message('e1');
  const collision = { ...message('e1'), sourceClientAccountId: 'other', sourceAccountId: 'owner' };
  const otherMailboxes = clone(folders);
  useEmailStore.setState({ emails: [matching, collision], selectedEmail: collision, accountMailboxes: { other: otherMailboxes } });
  await show(); await open(); await archive(); await act(async () => removal.resolve()); closed();
  const state = useEmailStore.getState();
  expect(state.emails).toEqual([collision]); expect(state.selectedEmail).toBe(collision);
  expect(state.accountMailboxes.other).toBe(otherMailboxes);
  expect(state.mailboxes.find(mb => mb.id === 'inbox')?.totalEmails).toBe(1);
  expect(client.moveEmail).toHaveBeenCalledTimes(1); expect(moved).toHaveBeenCalledTimes(1);
  expect(archived).toHaveBeenCalledTimes(1); expect(undoHistory()).toHaveLength(1);
});
it.each(['success', 'failure'])('does not apply listed Archive %s to a replacement global view', async outcome => {
  const listed = message('e1'); useEmailStore.setState({ emails: [listed], selectedEmail: listed });
  await show(); await open(); await archive();
  const replacement = { ...message('e1'), subject: 'Replacement global', sourceClientAccountId: 'other', sourceAccountId: 'owner' };
  act(() => useEmailStore.setState({ emails: [replacement], selectedEmail: replacement,
    selectedMailbox: 'trash', viewToken: useEmailStore.getState().viewToken + 1, mailboxes: clone(folders) }));
  await flush(); const snapshot = useEmailStore.getState();
  if (outcome === 'success') await act(async () => removal.resolve());
  else await act(async () => removal.reject(new Error('late Archive rejection')));
  expect(useEmailStore.getState()).toBe(snapshot);
  if (outcome === 'success') closed(); else stillOpen();
  expect(undoHistory()).toHaveLength(outcome === 'success' ? 1 : 0);
});
it('uses refreshed global fields and preserves the next global selection at completion', async () => {
  const listed = message('e1'); useEmailStore.setState({ emails: [listed], selectedEmail: listed });
  await show(); await open(); await archive();
  const refreshed = { ...listed, keywords: { $seen: true } };
  const next = { ...message('e2'), subject: 'Fresh unrelated subject', preview: 'Latest preview' };
  const mailboxes = clone(folders); mailboxes[0].unreadEmails = 0; mailboxes[0].unreadThreads = 0;
  act(() => useEmailStore.setState({ emails: [refreshed, next], selectedEmail: next, mailboxes }));
  await act(async () => removal.resolve()); closed();
  const state = useEmailStore.getState(); expect(state.emails).toEqual([next]); expect(state.selectedEmail).toBe(next);
  expect(state.mailboxes[0]).toMatchObject({ totalEmails: 1, unreadEmails: 0 });
  expect(state.mailboxes[1]).toMatchObject({ totalEmails: 3, unreadEmails: 1 });
});
it.each(['other-login', 'shared'])('preserves matching %s global membership completion in the owning mailbox counters', async scope => {
  const shared = scope === 'shared'; const other = makeClient();
  const owner = shared ? 'team' : 'owner'; const login = shared ? 'login' : 'other';
  const scoped = folders.map(mb => ({ ...clone(mb), ...(shared ? { id: `team:${mb.id}`, originalId: mb.id, isShared: true, accountId: owner } : {}) }));
  if (shared) for (const email of server.values()) email.mailboxIds = { 'team:inbox': true };
  const listed = { ...clone(server.get('e1')!), sourceClientAccountId: login, sourceAccountId: owner };
  const own = clone(folders);
  useEmailStore.setState({ emails: [listed], selectedEmail: listed,
    mailboxes: shared ? [...own, ...scoped] : own, accountMailboxes: { other: scoped } });
  useAuthStore.setState({ getClientForAccount: ((id: string) => id === 'login' ? client : id === 'other' ? other : undefined) as never });
  openingSharedReader = shared;
  await show({ ...data, accountId: shared ? null : 'other', mailboxId: shared ? 'team:inbox' : 'inbox' });
  await open(); await archive();
  const owning = shared ? client : other;
  expect(owning.moveEmail).toHaveBeenCalledExactlyOnceWith('e1', 'archive', owner);
  await act(async () => removal.resolve()); closed();
  const state = useEmailStore.getState(); expect(state.emails).toEqual([]); expect(state.selectedEmail).toBeNull();
  expect(state.mailboxes.filter(mb => !mb.isShared)).toEqual(own);
  const updated = shared ? state.mailboxes.filter(mb => mb.isShared) : state.accountMailboxes.other;
  expect(updated[0]).toMatchObject({ totalEmails: 1, unreadEmails: 0 });
  expect(updated[1]).toMatchObject({ totalEmails: 3, unreadEmails: 2 });
  expect(moved).toHaveBeenCalledTimes(1); expect(archived).toHaveBeenCalledTimes(1); expect(undoHistory()).toHaveLength(1);
});

it('makes the Archive folder when the account has none, then archives into it', async () => {
  const noArchive = clone(folders).filter(m => m.id !== 'archive');
  useEmailStore.setState({ mailboxes: noArchive });
  let serverFolders = clone(noArchive);
  const created = { ...clone(folders[1]), id: 'new-archive', name: 'Archive', totalEmails: 0, totalThreads: 0, unreadEmails: 0, unreadThreads: 0 };
  Object.assign(client, {
    getAllMailboxes: vi.fn(async () => clone(serverFolders)),
    createMailbox: vi.fn(async () => { serverFolders = [...serverFolders, created]; return clone(created); }),
  });
  await show(); await open(); await archive();
  expect((client as unknown as { createMailbox: ReturnType<typeof vi.fn> }).createMailbox)
    .toHaveBeenCalledExactlyOnceWith('Archive', undefined, undefined, { role: 'archive' });
  expect(client.moveEmail).toHaveBeenCalledExactlyOnceWith('e1', 'new-archive', 'owner');
  await act(async () => removal.resolve()); closed(); expect(undoHistory()).toHaveLength(1);
});
it.each(['year', 'month'] as const)('files into %s folders when archiveMode asks for it', async mode => {
  useSettingsStore.setState({ archiveMode: mode });
  const batchArchiveEmails = vi.fn(async (emails: Array<{ id: string }>) => {
    await removal.promise; for (const e of emails) server.get(e.id)!.mailboxIds = { 'archive-2026': true };
  });
  Object.assign(client, { batchArchiveEmails });
  await show(); await open(); await archive();
  expect(batchArchiveEmails).toHaveBeenCalledExactlyOnceWith(
    [{ id: 'e1', receivedAt: '2026-11-07T00:00:00Z' }], 'archive', mode, expect.any(Array), 'owner');
  expect(client.moveEmail).not.toHaveBeenCalled(); stillOpen();
  await act(async () => removal.resolve()); closed(); expect(undoHistory()).toHaveLength(1);
});
