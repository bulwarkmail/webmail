/** Real folder, reader, stores/actions, plugin hooks and scheduler; only client
 * services and browser/presentation APIs are mocked. No real mailbox access. */
import React from 'react';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
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
const folders: Mailbox[] = ['inbox', 'archive', 'dest'].map(id => ({
  id, name: id, role: id === 'dest' ? undefined : id, accountId: 'owner', sortOrder: 0, isSubscribed: true,
  totalEmails: 2, totalThreads: 2, unreadEmails: 1, unreadThreads: 1,
  myRights: { mayReadItems: true, mayAddItems: true, mayRemoveItems: true, maySetSeen: true, maySetKeywords: true,
    mayCreateChild: true, mayRename: true, mayDelete: true, maySubmit: true },
}));
let server: Map<string, Email>;
let removal: ReturnType<typeof deferred<void>>;
let read: ReturnType<typeof deferred<void>>;
function makeClient(owner = 'owner', state = server) {
  return {
    getAccountId: () => owner, getSieveAccountId: () => null, getUsername: () => 'reader@example.invalid',
    getEmails: vi.fn(async () => ({ emails: clone([...state.values()]), total: state.size, hasMore: false })),
    getEmail: vi.fn(async (id: string) => clone(state.get(id)!)),
    getAllMailboxes: vi.fn(async () => clone(folders)),
    markAsRead: vi.fn(async (id: string, seen: boolean, _account?: string) => {
      await read.promise; state.get(id)!.keywords.$seen = seen;
    }),
    moveEmail: vi.fn(async (id: string, destination: string, _account?: string) => {
      await removal.promise; state.get(id)!.mailboxIds = { [destination]: true };
    }),
    restoreEmails: vi.fn(async (points: Array<{ id: string; mailboxIds: Record<string, boolean>; seen: boolean }>, _account?: string) => {
      for (const p of points) { state.get(p.id)!.mailboxIds = clone(p.mailboxIds); state.get(p.id)!.keywords.$seen = p.seen; }
    }),
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
  const view = render(<ProFolderTabBody tabId="move-folder" data={folder} />); await flush(); return view;
}
async function open(id = 'e1') { fireEvent.click(row(id)!); await flush(); expect(body(id)).toBeInTheDocument(); }
async function move(destination = 'dest') {
  const trigger = screen.getByRole('button', { name: 'move_to' });
  expect(trigger).toBeEnabled(); fireEvent.click(trigger); await flush();
  const target = screen.getAllByTestId(`move-to:${destination}`)[0];
  expect(target).toBeEnabled(); fireEvent.click(target); await flush();
}
const stillOpen = () => { expect(row()).toBeInTheDocument(); expect(body()).toBeInTheDocument(); };
const closed = () => { expect(row()).not.toBeInTheDocument(); expect(body()).not.toBeInTheDocument(); };
function globalAbsent() { expect(useEmailStore.getState().emails).toEqual([]); expect(useEmailStore.getState().selectedEmail).toBeNull(); }

beforeEach(() => {
  vi.useFakeTimers(); clearAllHooks(); clearUndoHistory(); localStorage.clear(); openingSharedReader = false;
  useToastStore.getState().clearToasts();
  usePolicyStore.setState(usePolicyStore.getInitialState(), true);
  useEmailStore.setState(useEmailStore.getInitialState(), true);
  useEmailStore.setState({ mailboxes: clone(folders), selectedMailbox: 'inbox' });
  useSettingsStore.setState({ markAsReadDelay: -1, confirmArchive: false, singleKeyShortcuts: false, archiveMode: 'single' });
  server = new Map([['e1', message('e1')], ['e2', message('e2')]]);
  removal = deferred(); read = deferred(); client = makeClient();
  useAuthStore.setState({ client: client as never, activeAccountId: 'login',
    getClientForAccount: ((id: string) => id === 'login' ? client : undefined) as never });
  vi.stubGlobal('ResizeObserver', NoopResizeObserver);
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    if (url === '/api/config') return new Response('{}', { status: 200, headers: { 'Content-Type': 'application/json' } });
    throw new Error(`Network forbidden in Move regression: ${url}`);
  }));
  errors = spyOnErrors(); moved = vi.fn<() => void>(); archived = vi.fn<() => void>();
  emailHooks.onAfterEmailMove.register('move-observer', moved);
  emailHooks.onEmailArchive.register('archive-observer', archived);
});
afterEach(() => {
  cleanup();
  expect(vi.mocked(fetch).mock.calls.every(([url]) => url === '/api/config')).toBe(true);
  // Opening a shared reader already produces this exact React warning on
  // untouched upstream, before Move. Reject every other unexpected error.
  const unexpected = errors.mock.calls.filter(call => call[0] !== 'Move failed:'
    && !(openingSharedReader && JSON.stringify(call) === JSON.stringify(sharedReaderWarning)));
  expect(unexpected).toEqual([]);
  vi.useRealTimers(); vi.unstubAllGlobals(); vi.restoreAllMocks(); clearAllHooks(); clearUndoHistory();
});

it('moves a folder-only message through the actual reader menu after confirmed success', async () => {
  await show(); await open(); globalAbsent(); await move();
  expect(client.moveEmail).toHaveBeenCalledExactlyOnceWith('e1', 'dest', 'owner');
  stillOpen(); expect(undoHistory()).toHaveLength(0); expect(moved).not.toHaveBeenCalled();
  await act(async () => removal.resolve()); closed(); globalAbsent();
  expect(moved).toHaveBeenCalledExactlyOnceWith({ emailIds: ['e1'], fromMailboxId: 'inbox', toMailboxId: 'dest' });
  expect(undoHistory()).toHaveLength(1); expect(client.markAsRead).not.toHaveBeenCalled();
});
it('offers a valid destination in the folder login that is absent from global mailbox metadata', async () => {
  const other = makeClient(); const unique = { ...clone(folders[2]), id: 'unique', name: 'Only in other login' };
  useEmailStore.setState({ accountMailboxes: { other: [...clone(folders), unique] } });
  useAuthStore.setState({ getClientForAccount: ((id: string) => id === 'other' ? other : id === 'login' ? client : undefined) as never });
  await show({ ...data, accountId: 'other' }); await open(); globalAbsent();
  expect(useEmailStore.getState().mailboxes.some(m => m.id === 'unique')).toBe(false);
  await move('unique'); expect(other.moveEmail).toHaveBeenCalledExactlyOnceWith('e1', 'unique', 'owner');
  expect(client.moveEmail).not.toHaveBeenCalled(); await act(async () => removal.resolve()); closed();
});
it('preserves matching global-list Move completion through the actual folder reader', async () => {
  const listed = clone(server.get('e1')!); useEmailStore.setState({ emails: [listed], selectedEmail: listed });
  await show(); await open(); await move(); expect(client.moveEmail).toHaveBeenCalledTimes(1);
  expect(client.moveEmail.mock.calls[0].slice(0, 2)).toEqual(['e1', 'dest']);
  expect(client.moveEmail.mock.calls[0][2] ?? client.getAccountId()).toBe('owner');
  stillOpen(); expect(useEmailStore.getState().emails).toEqual([listed]); expect(undoHistory()).toHaveLength(0);
  await act(async () => removal.resolve()); closed();
  expect(useEmailStore.getState().emails).toEqual([]); expect(useEmailStore.getState().selectedEmail).toBeNull();
  expect(useEmailStore.getState().mailboxes[0]).toMatchObject({ totalEmails: 1, unreadEmails: 0 });
  expect(useEmailStore.getState().mailboxes[2]).toMatchObject({ totalEmails: 3, unreadEmails: 2 });
  expect(moved).toHaveBeenCalledTimes(1); expect(undoHistory()).toHaveLength(1);
});

it('retains refreshed fields and the original read deadline on rejection, then permits retry', async () => {
  useSettingsStore.setState({ markAsReadDelay: 3000 });
  await show(); await open(); await advance(1000); await move();
  expect(client.moveEmail).toHaveBeenCalledTimes(1); stillOpen();
  server.get('e1')!.subject = 'Refreshed subject'; server.get('e1')!.preview = 'Fresh preview';
  fireEvent.click(screen.getByRole('button', { name: 'common.refresh' })); await flush();
  await act(async () => removal.reject(new Error('move refused')));
  stillOpen(); globalAbsent(); expect(screen.getByText('Refreshed subject')).toBeInTheDocument();
  expect(screen.getByText('Fresh preview')).toBeInTheDocument(); expect(undoHistory()).toHaveLength(0);
  expect(moved).not.toHaveBeenCalled(); await advance(1999); expect(client.markAsRead).not.toHaveBeenCalled();
  await advance(1); expect(client.markAsRead).toHaveBeenCalledExactlyOnceWith('e1', true, undefined);
  await act(async () => read.resolve());
  removal = deferred(); await move(); expect(client.moveEmail).toHaveBeenCalledTimes(2);
  await act(async () => removal.resolve()); closed(); expect(undoHistory()).toHaveLength(1);
});

it('deduplicates attempts during a deferred plugin veto and preserves the delayed read', async () => {
  useSettingsStore.setState({ markAsReadDelay: 3000 });
  const gate = deferred<boolean>(); const veto = vi.fn(() => gate.promise);
  emailHooks.onBeforeEmailMove.register('veto', veto);
  await show(); await open(); await advance(1000); await move(); await move();
  expect(veto).toHaveBeenCalledTimes(1); expect(client.moveEmail).not.toHaveBeenCalled(); stillOpen();
  await act(async () => gate.resolve(false)); stillOpen();
  expect(client.moveEmail).not.toHaveBeenCalled(); expect(moved).not.toHaveBeenCalled(); expect(undoHistory()).toHaveLength(0);
  await advance(2000); expect(client.markAsRead).toHaveBeenCalledTimes(1); await act(async () => read.resolve());
  emailHooks.onBeforeEmailMove.removePlugin('veto'); await move(); expect(client.moveEmail).toHaveBeenCalledTimes(1);
  await act(async () => removal.resolve()); closed();
});

it('deduplicates actual menu picks while the request is pending', async () => {
  await show(); await open(); await move(); await move();
  expect(client.moveEmail).toHaveBeenCalledTimes(1); stillOpen(); expect(undoHistory()).toHaveLength(0);
  await act(async () => removal.resolve()); closed(); expect(moved).toHaveBeenCalledTimes(1); expect(undoHistory()).toHaveLength(1);
});

it.each(['move', 'archive'])('preserves the %s plugin interception for an ordinary Move into Archive', async hook => {
  const veto = vi.fn(() => false);
  (hook === 'move' ? emailHooks.onBeforeEmailMove : emailHooks.onBeforeEmailArchive).register('veto', veto);
  await show(); await open(); await move('archive');
  expect(veto).toHaveBeenCalledTimes(1); expect(client.moveEmail).not.toHaveBeenCalled(); stillOpen();
  expect(undoHistory()).toHaveLength(0); expect(moved).not.toHaveBeenCalled(); expect(archived).not.toHaveBeenCalled();
});

it('keeps existing Archive folders ordinary Move targets when the Archive action policy is off', async () => {
  const policy = usePolicyStore.getState().policy;
  usePolicyStore.setState({ policy: { ...policy, features: { ...policy.features, archiveActionEnabled: false } } });
  await show(); await open(); await move('archive');
  expect(client.moveEmail).toHaveBeenCalledExactlyOnceWith('e1', 'archive', 'owner');
  await act(async () => removal.resolve()); closed(); expect(moved).toHaveBeenCalledTimes(1);
  expect(archived).toHaveBeenCalledExactlyOnceWith({ emailIds: ['e1'] }); expect(undoHistory()).toHaveLength(1);
});

it('honors source removal rights and excludes a destination without add rights', async () => {
  const boxes = clone(folders); boxes[0].myRights.mayRemoveItems = false; boxes[1].myRights.mayAddItems = false;
  useEmailStore.setState({ mailboxes: boxes }); await show(); await open();
  await move(); stillOpen(); expect(client.moveEmail).not.toHaveBeenCalled(); expect(undoHistory()).toHaveLength(0);
  fireEvent.click(screen.getByRole('button', { name: 'move_to' })); await flush();
  expect(screen.queryByTestId('move-to:archive')).not.toBeInTheDocument();
});

it.each(['source', 'destination'])('rechecks %s rights after a waiting before-move hook', async which => {
  const gate = deferred<boolean>(); emailHooks.onBeforeEmailMove.register('gate', () => gate.promise);
  await show(); await open(); await move();
  act(() => useEmailStore.setState({ mailboxes: folders.map(m => ({ ...clone(m), myRights: { ...m.myRights,
    ...(which === 'source' && m.id === 'inbox' ? { mayRemoveItems: false } : {}),
    ...(which === 'destination' && m.id === 'dest' ? { mayAddItems: false } : {}),
  } })) }));
  await act(async () => gate.resolve(true)); expect(client.moveEmail).not.toHaveBeenCalled(); stillOpen(); expect(undoHistory()).toHaveLength(0);
});

function scoped(kind: 'other-login' | 'shared', matching = false) {
  const shared = kind === 'shared'; const owner = shared ? 'team' : 'owner';
  const ownServer = new Map([...server].map(([id, e]) => [id, clone(e)]));
  const other = makeClient('owner', ownServer);
  const boxes = folders.map(m => ({ ...clone(m), ...(shared ? { id: `team:${m.id}`, originalId: m.id, accountId: owner, isShared: true } : {}) }));
  if (shared) for (const e of server.values()) e.mailboxIds = { 'team:inbox': true };
  const collision = { ...message('e1'), subject: 'Global collision', sourceClientAccountId: 'login', sourceAccountId: 'owner' };
  const login = shared ? 'login' : 'other'; const owning = shared ? client : other;
  const listed = { ...clone((shared ? server : ownServer).get('e1')!), sourceClientAccountId: login, sourceAccountId: owner };
  useEmailStore.setState({ mailboxes: shared ? [...clone(folders), ...boxes] : clone(folders),
    accountMailboxes: { other: boxes }, emails: matching ? [collision, listed] : [collision], selectedEmail: collision });
  useAuthStore.setState({ getClientForAccount: ((id: string) => id === 'other' ? other : id === 'login' ? client : undefined) as never });
  openingSharedReader = shared;
  return { owning, other, owner, collision, listed, boxes, shared, destination: shared ? 'team:dest' : 'dest',
    folder: { ...data, accountId: shared ? null : 'other', mailboxId: shared ? 'team:inbox' : 'inbox' } };
}

it.each(['other-login', 'shared'] as const)('moves and Undoes a folder-only %s message without touching a colliding global row', async kind => {
  const s = scoped(kind); const snapshot = useEmailStore.getState();
  const full = { ...message('e1'), mailboxIds: { [s.folder.mailboxId]: true, [s.shared ? 'team:extra' : 'extra']: true, ignored: false } };
  s.owning.getEmail.mockResolvedValueOnce(full);
  await show(s.folder); await open(); await move(s.destination);
  expect(s.owning.getEmail).toHaveBeenCalledExactlyOnceWith('e1', s.owner);
  expect(s.owning.moveEmail).toHaveBeenCalledExactlyOnceWith('e1', 'dest', s.owner);
  expect((s.shared ? s.other : client).moveEmail).not.toHaveBeenCalled();
  expect(useEmailStore.getState()).toBe(snapshot); stillOpen(); await act(async () => removal.resolve()); closed();
  expect(useEmailStore.getState()).toBe(snapshot); expect(moved).toHaveBeenCalledTimes(1); expect(undoHistory()).toHaveLength(1);
  // The real Undo refreshes no global folder when none is selected.
  act(() => useEmailStore.setState({ selectedMailbox: '' }));
  const undo = useToastStore.getState().toasts.find(t => t.action)?.action; expect(undo).toBeDefined();
  act(() => undo!.onClick()); await flush();
  expect(s.owning.restoreEmails).toHaveBeenCalledExactlyOnceWith([{ id: 'e1', mailboxIds: { inbox: true, extra: true }, seen: false }], s.owner);
  expect((s.shared ? s.other : client).restoreEmails).not.toHaveBeenCalled(); expect(undoHistory()).toHaveLength(0);
  expect(useEmailStore.getState().emails).toEqual([s.collision]);
});

it.each(['other-login', 'shared'] as const)('completes matching %s membership and counters while preserving its global namesake', async kind => {
  const s = scoped(kind, true); const own = clone(folders);
  await show(s.folder); await open(); await move(s.destination); stillOpen();
  await act(async () => removal.resolve()); closed();
  const state = useEmailStore.getState(); expect(state.emails).toEqual([s.collision]); expect(state.selectedEmail).toBe(s.collision);
  expect(state.mailboxes.filter(m => !m.isShared)).toEqual(own);
  const updated = s.shared ? state.mailboxes.filter(m => m.isShared) : state.accountMailboxes.other;
  expect(updated[0]).toMatchObject({ totalEmails: 1, unreadEmails: 0 }); expect(updated[2]).toMatchObject({ totalEmails: 3, unreadEmails: 2 });
  expect(moved).toHaveBeenCalledTimes(1); expect(undoHistory()).toHaveLength(1);
});

it.each(['other-login', 'shared'] as const)('offers only the owning account destinations for a %s folder', async kind => {
  const s = scoped(kind); const unique = { ...clone(s.boxes[2]), id: s.shared ? 'team:unique' : 'unique', originalId: 'unique', name: 'Owner only' };
  const foreign = { ...clone(folders[2]), id: 'foreign:dest', originalId: 'dest', accountId: 'foreign', isShared: true, name: 'Foreign' };
  act(() => useEmailStore.setState(s.shared
    ? { mailboxes: [...clone(folders), ...s.boxes, unique, foreign] }
    : { accountMailboxes: { other: [...s.boxes, unique, foreign] } }));
  await show(s.folder); await open(); fireEvent.click(screen.getByRole('button', { name: 'move_to' })); await flush();
  expect(screen.getByTestId(`move-to:${unique.id}`)).toBeEnabled();
  expect(screen.queryByTestId('move-account:foreign')).not.toBeInTheDocument(); expect(screen.queryByTestId('move-to:foreign:dest')).not.toBeInTheDocument();
  if (s.shared) expect(screen.queryByTestId('move-to:dest')).not.toBeInTheDocument();
  fireEvent.click(screen.getByTestId(`move-to:${unique.id}`)); await flush();
  expect(s.owning.moveEmail).toHaveBeenCalledExactlyOnceWith('e1', 'unique', s.owner);
  await act(async () => removal.resolve()); closed();
});

it.each(['selection', 'reselection', 'client', 'login', 'mailbox', 'unmount'])('does not dispatch after a %s change during plugin approval', async change => {
  const gate = deferred<boolean>(); emailHooks.onBeforeEmailMove.register('gate', () => gate.promise);
  const view = await show(); await open(); await move(); expect(client.moveEmail).not.toHaveBeenCalled();
  if (change === 'selection' || change === 'reselection') { await open('e2'); if (change === 'reselection') await open(); }
  else if (change === 'client') act(() => useAuthStore.setState({ client: makeClient() as never }));
  else if (change === 'login') act(() => useAuthStore.setState({ activeAccountId: 'replacement' }));
  else if (change === 'mailbox') view.rerender(<ProFolderTabBody tabId="move-folder" data={{ ...data, mailboxId: 'dest' }} />);
  else view.unmount();
  await flush(); await act(async () => gate.resolve(true));
  expect(client.moveEmail).not.toHaveBeenCalled(); expect(moved).not.toHaveBeenCalled(); expect(undoHistory()).toHaveLength(0);
  if (change === 'selection') expect(body('e2')).toBeInTheDocument();
  if (change === 'reselection') stillOpen();
});

it('does not fall back to another login if the folder login disappears during approval', async () => {
  const s = scoped('other-login'); const gate = deferred<boolean>(); emailHooks.onBeforeEmailMove.register('gate', () => gate.promise);
  await show(s.folder); await open(); await move();
  act(() => useAuthStore.setState({ getClientForAccount: ((id: string) => id === 'login' ? client : undefined) as never }));
  await act(async () => gate.resolve(true));
  expect(client.moveEmail).not.toHaveBeenCalled(); expect(s.other.moveEmail).not.toHaveBeenCalled(); expect(undoHistory()).toHaveLength(0);
});

it.each(['success', 'failure'])('preserves the replacement reader and its delayed read after old Move %s', async outcome => {
  useSettingsStore.setState({ markAsReadDelay: 3000 }); server.get('e2')!.keywords.$seen = false;
  await show(); await open(); await move(); expect(client.moveEmail).toHaveBeenCalledTimes(1); await open('e2');
  if (outcome === 'success') await act(async () => removal.resolve());
  else await act(async () => removal.reject(new Error('late rejection')));
  expect(body('e2')).toBeInTheDocument(); expect(row('e2')).toBeInTheDocument();
  await advance(3000); expect(client.markAsRead).toHaveBeenCalledExactlyOnceWith('e2', true, undefined); await act(async () => read.resolve());
  expect(undoHistory()).toHaveLength(outcome === 'success' ? 1 : 0);
});

it('does not remove a replacement selection with the same message id after stale success', async () => {
  await show(); await open(); await move(); await open('e2'); await open();
  await act(async () => removal.resolve()); stillOpen(); expect(undoHistory()).toHaveLength(1);
});

it.each(['client', 'login', 'mailbox', 'unmount'])('ignores stale UI completion after a %s context change but retains confirmed hooks and Undo', async change => {
  const original = client; const view = await show(); await open(); await move();
  if (change === 'client') act(() => useAuthStore.setState({ client: makeClient() as never }));
  else if (change === 'login') act(() => useAuthStore.setState({ activeAccountId: 'replacement-login' }));
  else if (change === 'mailbox') view.rerender(<ProFolderTabBody tabId="move-folder" data={{ ...data, mailboxId: 'dest' }} />);
  else view.unmount();
  await flush(); if (change !== 'unmount') await open();
  await act(async () => removal.resolve());
  if (change !== 'unmount') stillOpen(); expect(original.moveEmail).toHaveBeenCalledTimes(1);
  expect(moved).toHaveBeenCalledTimes(1); expect(undoHistory()).toHaveLength(1);
});

it('uses current matching global fields and leaves the next selection intact at completion', async () => {
  const listed = message('e1'); useEmailStore.setState({ emails: [listed], selectedEmail: listed });
  await show(); await open(); await move();
  const refreshed = { ...listed, keywords: { $seen: true } }; const next = { ...message('e2'), subject: 'Fresh unrelated' };
  const boxes = clone(folders); boxes[0].unreadEmails = 0; boxes[0].unreadThreads = 0;
  act(() => useEmailStore.setState({ emails: [refreshed, next], selectedEmail: next, mailboxes: boxes }));
  await act(async () => removal.resolve()); closed();
  const state = useEmailStore.getState(); expect(state.emails).toEqual([next]); expect(state.selectedEmail).toBe(next);
  expect(state.mailboxes[0]).toMatchObject({ totalEmails: 1, unreadEmails: 0 }); expect(state.mailboxes[2]).toMatchObject({ totalEmails: 3, unreadEmails: 1 });
});

it('does not complete a replaced global view or mutate its colliding message', async () => {
  const listed = message('e1'); useEmailStore.setState({ emails: [listed], selectedEmail: listed });
  await show(); await open(); await move();
  const replacement = { ...message('e1'), subject: 'Replacement global', sourceClientAccountId: 'other', sourceAccountId: 'owner' };
  act(() => useEmailStore.setState({ emails: [replacement], selectedEmail: replacement, selectedMailbox: 'archive', viewToken: useEmailStore.getState().viewToken + 1 }));
  const snapshot = useEmailStore.getState(); await act(async () => removal.resolve());
  expect(useEmailStore.getState()).toBe(snapshot); closed(); expect(undoHistory()).toHaveLength(1);
});

it('cancels a pending automatic-read timer only after Move success', async () => {
  useSettingsStore.setState({ markAsReadDelay: 3000 });
  await show(); await open(); await advance(1000); await move(); await advance(1000);
  stillOpen(); expect(client.markAsRead).not.toHaveBeenCalled(); await act(async () => removal.resolve()); closed();
  await advance(10000); expect(client.markAsRead).not.toHaveBeenCalled();
});

it('revokes a read waiting inside its before-read hook after Move succeeds', async () => {
  useSettingsStore.setState({ markAsReadDelay: 3000 });
  const gate = deferred<boolean>(); const before = vi.fn(() => gate.promise);
  emailHooks.onBeforeEmailReadStateChange.register('gate', before);
  await show(); await open(); await advance(3000); expect(before).toHaveBeenCalledTimes(1);
  expect(client.markAsRead).not.toHaveBeenCalled(); await move(); await act(async () => removal.resolve()); closed();
  await act(async () => gate.resolve(true)); await advance(10000); expect(client.markAsRead).not.toHaveBeenCalled();
});

it('leaves an already-dispatched read untouched when Move succeeds', async () => {
  useSettingsStore.setState({ markAsReadDelay: 3000 });
  const readEvents = vi.fn(); emailHooks.onEmailReadStateChange.register('read-observer', readEvents);
  await show(); await open(); await move(); await advance(3000);
  expect(client.markAsRead).toHaveBeenCalledExactlyOnceWith('e1', true, undefined);
  await act(async () => removal.resolve()); closed(); await act(async () => read.resolve());
  expect(server.get('e1')!.keywords.$seen).toBe(true); expect(readEvents).toHaveBeenCalledTimes(1);
  await advance(10000); expect(client.markAsRead).toHaveBeenCalledTimes(1); expect(client.restoreEmails).not.toHaveBeenCalled();
});

it('ignores an older in-flight folder Refresh after successful removal', async () => {
  await show(); await open(); await move();
  const response = { emails: clone([...server.values()]), total: 2, hasMore: false }; const refresh = deferred<typeof response>();
  client.getEmails.mockImplementationOnce(() => refresh.promise);
  fireEvent.click(screen.getByRole('button', { name: 'common.refresh' })); await flush();
  await act(async () => removal.resolve()); closed(); await act(async () => refresh.resolve(response)); closed();
});
