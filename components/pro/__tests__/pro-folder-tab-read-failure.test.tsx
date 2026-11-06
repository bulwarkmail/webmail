/** Regression coverage for folder-local automatic reads. The real folder,
 * reader, stores, scheduler and plugin hooks run against a deferred fake client.
 */
import React from 'react';
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { useAuthStore } from '@/stores/auth-store';
import { useEmailStore } from '@/stores/email-store';
import { useSettingsStore } from '@/stores/settings-store';
import { clearAllHooks, emailHooks } from '@/lib/plugin-hooks';
import type { Email, Mailbox } from '@/lib/jmap/types';

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
  let reject!: (e: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
function message(id: string, seen: boolean): Email {
  return {
    id, threadId: id, blobId: `blob-${id}`, mailboxIds: { inbox: true },
    keywords: { $seen: seen, $flagged: true },
    from: [{ name: `Sender ${id}`, email: 'sender@example.invalid' }],
    to: [{ email: 'reader@example.invalid' }], subject: `Subject ${id}`,
    receivedAt: '2026-11-06T00:00:00Z', preview: '', hasAttachment: false, size: 1,
    textBody: [{ partId: '1', type: 'text/plain', blobId: `body-${id}`, size: 1 }], htmlBody: [], attachments: [],
    bodyValues: { '1': { value: `Body ${id}`, isTruncated: false } },
  } as Email;
}
const clone = <T,>(x: T): T => JSON.parse(JSON.stringify(x));
let server: Map<string, Email>;
let request: ReturnType<typeof deferred<void>>;
let client: {
  getAccountId: () => string;
  getSieveAccountId: () => null;
  getUsername: () => string;
  getEmails: ReturnType<typeof vi.fn>;
  getEmail: ReturnType<typeof vi.fn>;
  markAsRead: ReturnType<typeof vi.fn>;
};
const spyOnErrors = () => vi.spyOn(console, 'error').mockImplementation(() => {});
let errors: ReturnType<typeof spyOnErrors>;
let emitted = vi.fn<(event: { emailIds: string[]; read: boolean }) => void>();
const mailbox = { id: 'inbox', name: 'Inbox', role: 'inbox', parentId: null,
  totalEmails: 2, totalThreads: 2, unreadEmails: 1, unreadThreads: 1,
  myRights: { mayAddItems: true, maySetSeen: true } } as unknown as Mailbox;

beforeEach(() => {
  clearAllHooks();
  useEmailStore.setState(useEmailStore.getInitialState(), true);
  useEmailStore.setState({ mailboxes: [clone(mailbox)] });
  useSettingsStore.setState({ markAsReadDelay: 0 });
  server = new Map([['e1', message('e1', false)], ['e2', message('e2', true)]]);
  request = deferred();
  client = {
    getSieveAccountId: () => null,
    getAccountId: () => 'owner', getUsername: () => 'reader@example.invalid',
    getEmails: vi.fn(async () => ({ emails: clone([...server.values()]), total: 2, hasMore: false })),
    getEmail: vi.fn(async (id: string) => clone(server.get(id)!)),
    markAsRead: vi.fn(async (id: string, read: boolean, _account?: string) => {
      if (id === 'e1' && client.markAsRead.mock.calls.length === 1) await request.promise;
      const current = server.get(id)!;
      server.set(id, { ...current, keywords: { ...current.keywords, $seen: read } });
    }),
  };
  useAuthStore.setState({ client: client as never, activeAccountId: 'login',
    getClientForAccount: (() => undefined) as never });
  vi.stubGlobal('ResizeObserver', NoopResizeObserver);
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    if (url === '/api/config') return new Response('{}', { status: 200, headers: { 'Content-Type': 'application/json' } });
    throw new Error(`Network forbidden in Pro read audit: ${url}`);
  }));
  errors = spyOnErrors();
  emitted = vi.fn();
  emailHooks.onEmailReadStateChange.register('audit-observer', emitted);
});
afterEach(() => {
  cleanup();
  expect(vi.mocked(fetch).mock.calls.every(([url]) => url === '/api/config')).toBe(true);
  expect(errors.mock.calls.filter(call => call[0] !== 'Mark as read failed:' && call[0] !== 'Failed to load folder tab:')).toEqual([]);
  vi.useRealTimers(); vi.unstubAllGlobals(); vi.restoreAllMocks(); clearAllHooks();
});
const flush = async () => { await act(async () => {}); };
async function show() {
  const view = render(<div data-testid="host"><ProFolderTabBody tabId="audit-folder"
    data={{ accountId: null, mailboxId: 'inbox', title: 'Inbox' }} /></div>);
  await flush();
  return view;
}
function row(id = 'e1') {
  const result = screen.getAllByRole('button', { name: new RegExp(`Sender ${id}`) }).find(el => el.tagName === 'DIV' && el.hasAttribute('tabindex'));
  expect(result).toBeDefined();
  return result!;
}
function rowRead(id = 'e1') {
  const target = row(id);
  expect(target.querySelector('[aria-hidden="true"].bg-primary')).toBeNull();
  expect(within(target).getByText(`Sender ${id}`)).not.toHaveClass('font-semibold');
}
function rowUnread(id = 'e1') {
  expect(row(id).querySelector('[aria-hidden="true"].bg-primary')).not.toBeNull();
  expect(within(row(id)).getByText(`Sender ${id}`)).toHaveClass('font-semibold');
}
async function open(id = 'e1') { fireEvent.click(row(id)); await flush(); }
async function fail() { await act(async () => { request.reject(new Error('audit refused')); }); }
function expectUnchangedGlobal() {
  expect(useEmailStore.getState().emails).toEqual([]);
  expect(useEmailStore.getState().selectedEmail).toBeNull();
  expect(useEmailStore.getState().mailboxes[0].unreadEmails).toBe(1);
  expect(useEmailStore.getState().processingReadStatus.size).toBe(0);
}

it('waits for success, deduplicates pending clicks, and updates only the folder row', async () => {
  await show(); await open(); await open();
  rowUnread(); rowRead('e2'); expectUnchangedGlobal();
  expect(client.markAsRead).toHaveBeenCalledExactlyOnceWith('e1', true, undefined);
  expect(server.get('e1')!.keywords.$seen).toBe(false);
  expect(emitted).not.toHaveBeenCalled();
  await act(async () => { request.resolve(); });
  rowRead(); rowRead('e2'); expectUnchangedGlobal();
  expect(server.get('e1')!.keywords.$seen).toBe(true);
  expect(emitted).toHaveBeenCalledExactlyOnceWith({ emailIds: ['e1'], read: true });
  await open(); expect(client.markAsRead).toHaveBeenCalledTimes(1);
});

it('keeps a refused row unread, never retries automatically, and permits a deliberate retry', async () => {
  vi.useFakeTimers();
  await show(); await open(); await fail();
  rowUnread(); rowRead('e2'); expectUnchangedGlobal();
  expect(server.get('e1')!.keywords.$seen).toBe(false);
  expect(emitted).not.toHaveBeenCalled();
  expect(errors).toHaveBeenCalledExactlyOnceWith('Mark as read failed:', expect.any(Error));
  await act(async () => { await vi.advanceTimersByTimeAsync(60_000); });
  expect(client.markAsRead).toHaveBeenCalledTimes(1);
  await open(); rowRead();
  expect(client.markAsRead).toHaveBeenCalledTimes(2);
  expect(server.get('e1')!.keywords.$seen).toBe(true);
  expect(emitted).toHaveBeenCalledTimes(1);
});

it.each(['failure', 'success'])('settles %s on the original row after selecting another message', async outcome => {
  await show(); await open(); await open('e2');
  if (outcome === 'failure') await fail();
  else await act(async () => { request.resolve(); });
  if (outcome === 'failure') rowUnread(); else rowRead();
  rowRead('e2'); expectUnchangedGlobal();
  expect(screen.getByText('Body e2')).toBeInTheDocument();
  expect(screen.queryByText('Body e1')).not.toBeInTheDocument();
  if (outcome === 'failure') {
    await open(); expect(client.markAsRead).toHaveBeenCalledTimes(2); rowRead();
  }
});

it('can retry a failure after returning to a retained hidden folder tab', async () => {
  await show(); await open();
  const host = screen.getByTestId('host');
  host.style.display = 'none'; host.setAttribute('aria-hidden', 'true');
  await fail(); expect(host).not.toBeVisible();
  host.style.display = ''; host.removeAttribute('aria-hidden');
  rowUnread(); expect(client.markAsRead).toHaveBeenCalledTimes(1);
  await open(); rowRead(); expect(client.markAsRead).toHaveBeenCalledTimes(2);
});

it.each(['failure', 'success'])('settles %s on the owned replacement row after same-context refresh', async outcome => {
  await show(); await open();
  server.set('e1', { ...server.get('e1')!, subject: 'Refreshed subject', keywords: { $seen: false, $flagged: false } });
  fireEvent.click(screen.getByRole('button', { name: 'common.refresh' })); await flush();
  expect(within(row()).getByText('Refreshed subject')).toBeInTheDocument();
  // Refresh does not permit concurrent duplicate writes to this same message.
  await open(); expect(client.markAsRead).toHaveBeenCalledTimes(1);
  if (outcome === 'failure') await fail();
  else await act(async () => { request.resolve(); });
  if (outcome === 'failure') rowUnread(); else rowRead();
  expect(within(row()).getByText('Refreshed subject')).toBeInTheDocument();
  expect(row().querySelector('.fill-yellow-400')).toBeNull();
  await open(); rowRead(); expect(client.markAsRead).toHaveBeenCalledTimes(outcome === 'failure' ? 2 : 1);
});

it.each(['failure', 'success'])('settling an unmounted instance with %s cannot alter the new instance', async outcome => {
  const view = await show(); await open(); view.unmount();
  const newer = deferred();
  client.markAsRead.mockImplementationOnce(async (id: string, read: boolean) => {
    await newer.promise; server.get(id)!.keywords.$seen = read;
  });
  await show(); await open();
  if (outcome === 'failure') await fail();
  else await act(async () => { request.resolve(); });
  rowUnread(); expectUnchangedGlobal();
  expect(client.markAsRead).toHaveBeenCalledTimes(2);
  await act(async () => { newer.resolve(); }); rowRead();
  expect(emitted).toHaveBeenCalledTimes(outcome === 'failure' ? 1 : 2);
});

it.each([true, false])('preserves a newer explicit read=%s when the old folder read fails', async read => {
  useEmailStore.setState({ emails: [clone(server.get('e1')!)], selectedEmail: clone(server.get('e1')!) });
  // The reader also auto-marks when its message belongs to the global list.
  // Refuse that attempt before explicit Read, or let it succeed before Unread.
  if (read) client.markAsRead.mockImplementationOnce(async () => {
    await request.promise; server.get('e1')!.keywords.$seen = true;
  }).mockRejectedValueOnce(new Error('reader auto refused'));
  await show(); await open();
  expect(client.markAsRead).toHaveBeenCalledTimes(2);
  fireEvent.click(screen.getAllByTitle(read ? 'mark_read' : 'mark_unread')[0]); await flush();
  expect(client.markAsRead).toHaveBeenCalledTimes(3);
  expect(client.markAsRead.mock.calls[2]).toEqual(['e1', read, undefined]);
  await fail();
  // The folder failure writes neither the independent reader/store nor its row.
  rowUnread(); rowRead('e2');
  expect(server.get('e1')!.keywords.$seen).toBe(read);
  expect(useEmailStore.getState().emails[0].keywords.$seen).toBe(read);
  expect(useEmailStore.getState().selectedEmail!.keywords.$seen).toBe(read);
  expect(useEmailStore.getState().processingReadStatus.size).toBe(0);
  expect(screen.getAllByTitle(read ? 'mark_unread' : 'mark_read').length).toBeGreaterThan(0);
});

it('releases the pending guard after a plugin veto so another selection can retry', async () => {
  const veto = emailHooks.onBeforeEmailReadStateChange.register('veto', () => false);
  await show(); await open(); await open(); rowUnread();
  expect(client.markAsRead).not.toHaveBeenCalled(); expect(emitted).not.toHaveBeenCalled();
  veto.dispose(); await open();
  expect(client.markAsRead).toHaveBeenCalledTimes(1); rowUnread();
  await act(async () => { request.resolve(); }); rowRead();
});

it('deduplicates while a before-hook is pending', async () => {
  const gate = deferred();
  emailHooks.onBeforeEmailReadStateChange.register('gate', async () => { await gate.promise; return true; });
  await show(); await open(); await open();
  expect(client.markAsRead).not.toHaveBeenCalled();
  await act(async () => { gate.resolve(); });
  expect(client.markAsRead).toHaveBeenCalledTimes(1); rowUnread();
  await act(async () => { request.resolve(); }); rowRead();
});

it.each(['selection', 'unmount'])('cancels before dispatch when a before-hook finishes after %s', async change => {
  const gate = deferred();
  emailHooks.onBeforeEmailReadStateChange.register('gate', async () => { await gate.promise; return true; });
  const view = await show(); await open();
  if (change === 'selection') await open('e2');
  else view.unmount();
  await act(async () => { gate.resolve(); });
  expect(client.markAsRead).not.toHaveBeenCalled();
  expect(emitted).not.toHaveBeenCalled();
});

it('keeps the Never setting and cancels a scheduled read on unmount', async () => {
  vi.useFakeTimers(); useSettingsStore.setState({ markAsReadDelay: -1 });
  const view = await show(); await open();
  await act(async () => { await vi.advanceTimersByTimeAsync(10_000); });
  expect(client.markAsRead).not.toHaveBeenCalled(); rowUnread();
  useSettingsStore.setState({ markAsReadDelay: 3000 });
  await open(); view.unmount();
  await act(async () => { await vi.advanceTimersByTimeAsync(10_000); });
  expect(client.markAsRead).not.toHaveBeenCalled();
});

const advance = async (ms: number) => { await act(async () => { await vi.advanceTimersByTimeAsync(ms); }); };
const refresh = async () => { fireEvent.click(screen.getByRole('button', { name: 'common.refresh' })); await flush(); };
const page = () => ({ emails: clone([...server.values()]), total: 2, hasMore: false });

it.each(['before', 'after'])('preserves the original delayed-read deadline when Refresh completes %s it', async completion => {
  vi.useFakeTimers(); useSettingsStore.setState({ markAsReadDelay: 3000 });
  await show(); await open(); await advance(1000);
  const refreshed = deferred<ReturnType<typeof page>>();
  client.getEmails.mockImplementationOnce(() => refreshed.promise);
  await refresh();
  expect(screen.getByText('Body e1')).toBeInTheDocument();
  expectUnchangedGlobal();
  server.set('e1', { ...server.get('e1')!, subject: 'Refreshed subject', preview: 'Fresh preview',
    keywords: { $seen: false, $flagged: false, custom: true } });
  const response = page();
  if (completion === 'before') await act(async () => { refreshed.resolve(response); });
  await advance(1999); expect(client.markAsRead).not.toHaveBeenCalled(); rowUnread();
  await advance(1);
  expect(client.markAsRead).toHaveBeenCalledExactlyOnceWith('e1', true, undefined);
  rowUnread(); expect(emitted).not.toHaveBeenCalled();
  await act(async () => { request.resolve(); });
  if (completion === 'after') await act(async () => { refreshed.resolve(response); });
  rowRead();
  expect(within(row()).getByText('Refreshed subject')).toBeInTheDocument();
  expect(within(row()).getByText('Fresh preview')).toBeInTheDocument();
  expect(row().querySelector('.fill-yellow-400')).toBeNull();
  await advance(60_000); expect(client.markAsRead).toHaveBeenCalledTimes(1);
  expectUnchangedGlobal();
});

it('keeps one original deadline through repeated, failed and superseded Refresh requests', async () => {
  vi.useFakeTimers(); useSettingsStore.setState({ markAsReadDelay: 3000 });
  await show(); await open(); await advance(1000);
  const obsolete = deferred<ReturnType<typeof page>>();
  const latest = deferred<ReturnType<typeof page>>();
  client.getEmails.mockImplementationOnce(() => obsolete.promise).mockImplementationOnce(() => latest.promise);
  await refresh(); await advance(500); await refresh(); await advance(500);
  await act(async () => { latest.reject(new Error('refresh refused')); });
  expect(errors).toHaveBeenCalledExactlyOnceWith('Failed to load folder tab:', expect.any(Error));
  const old = page(); old.emails[0].subject = 'Superseded response';
  await act(async () => { obsolete.resolve(old); });
  expect(within(row()).queryByText('Superseded response')).not.toBeInTheDocument();
  await advance(999); expect(client.markAsRead).not.toHaveBeenCalled();
  await advance(1); expect(client.markAsRead).toHaveBeenCalledTimes(1); rowUnread();
  await refresh(); await refresh();
  expect(client.markAsRead).toHaveBeenCalledTimes(1);
  await fail(); rowUnread();
  await advance(60_000); expect(client.markAsRead).toHaveBeenCalledTimes(1);
  await open(); await advance(2999); expect(client.markAsRead).toHaveBeenCalledTimes(1);
  await advance(1); expect(client.markAsRead).toHaveBeenCalledTimes(2); rowRead();
});

it('keeps the deadline through several completed Refresh requests', async () => {
  vi.useFakeTimers(); useSettingsStore.setState({ markAsReadDelay: 3000 });
  await show(); await open(); await advance(1000); await refresh();
  await advance(1000); await refresh(); await refresh();
  await advance(999); expect(client.markAsRead).not.toHaveBeenCalled();
  await advance(1); expect(client.markAsRead).toHaveBeenCalledExactlyOnceWith('e1', true, undefined);
  rowUnread(); await act(async () => { request.resolve(); }); rowRead();
  await refresh(); await advance(60_000); expect(client.markAsRead).toHaveBeenCalledTimes(1);
});

it('keeps ownership through Refresh while a before-hook is pending', async () => {
  const gate = deferred();
  emailHooks.onBeforeEmailReadStateChange.register('gate', async () => { await gate.promise; return true; });
  await show(); await open(); await refresh(); await open();
  expect(client.markAsRead).not.toHaveBeenCalled();
  await act(async () => { gate.resolve(); });
  expect(client.markAsRead).toHaveBeenCalledExactlyOnceWith('e1', true, undefined); rowUnread();
  await act(async () => { request.resolve(); }); rowRead();
});

it.each(['failure', 'success'])('does not apply an old %s after selection transfers refreshed-row ownership', async outcome => {
  await show(); await open(); await open('e2'); await refresh();
  // This new selection owns the replacement. The old pending-id guard still
  // blocks a concurrent mutation, but cannot transfer its completion here.
  await open(); expect(client.markAsRead).toHaveBeenCalledTimes(1);
  if (outcome === 'failure') await fail();
  else await act(async () => { request.resolve(); });
  rowUnread(); rowRead('e2'); expectUnchangedGlobal();
  await open(); rowRead(); expect(client.markAsRead).toHaveBeenCalledTimes(2);
});

it('does not transfer confirmed read styling to a newer selection while Refresh is in flight', async () => {
  await show(); await open(); await act(async () => { request.resolve(); }); rowRead();
  const refreshed = deferred<ReturnType<typeof page>>();
  client.getEmails.mockImplementationOnce(() => refreshed.promise);
  const response = page(); response.emails[0].keywords.$seen = false;
  await refresh(); await open('e2');
  await act(async () => { refreshed.resolve(response); });
  rowUnread(); rowRead('e2');
  expect(screen.getByText('Body e2')).toBeInTheDocument();
});

it.each(['selection', 'client', 'login', 'account', 'mailbox', 'shared-account', 'unmount'])(
  'cancels a delayed intent after Refresh and a %s change', async change => {
    vi.useFakeTimers(); useSettingsStore.setState({ markAsReadDelay: 3000 });
    const view = await show(); await open(); await advance(1000);
    const refreshed = deferred<ReturnType<typeof page>>();
    client.getEmails.mockImplementationOnce(() => refreshed.promise);
    await refresh();
    if (change === 'selection') await open('e2');
    else if (change === 'client') act(() => { useAuthStore.setState({ client: { ...client } as never }); });
    else if (change === 'login') act(() => { useAuthStore.setState({ activeAccountId: 'other-login' }); });
    else if (change === 'shared-account') act(() => { useEmailStore.setState({ mailboxes: [
      { ...mailbox, isShared: true, accountId: 'other-owner' },
    ] }); });
    else if (change === 'unmount') view.unmount();
    else view.rerender(<ProFolderTabBody tabId="audit-folder" data={{ accountId: change === 'account' ? 'other-login' : null,
      mailboxId: change === 'mailbox' ? 'other-folder' : 'inbox', title: 'Inbox' }} />);
    await flush();
    await act(async () => { refreshed.resolve(page()); });
    await advance(10_000); expect(client.markAsRead).not.toHaveBeenCalled(); expect(emitted).not.toHaveBeenCalled();
  },
);

it.each(['success', 'failure'])('ignores local %s from a dispatched read after a client context change', async outcome => {
  await show(); await open();
  const otherClient = { ...client, getEmails: vi.fn(async () => page()), markAsRead: vi.fn(async () => {}) };
  act(() => { useAuthStore.setState({ client: otherClient as never }); }); await flush();
  if (outcome === 'failure') await fail();
  else await act(async () => { request.resolve(); });
  rowUnread(); expectUnchangedGlobal(); expect(otherClient.markAsRead).not.toHaveBeenCalled();
});

it('allows a later authoritative Refresh to show a newer unread state after confirmed success', async () => {
  await show(); await open(); await act(async () => { request.resolve(); }); rowRead();
  server.get('e1')!.keywords.$seen = false;
  await refresh(); rowUnread();
  expect(client.markAsRead).toHaveBeenCalledTimes(1);
  await open(); rowRead(); expect(client.markAsRead).toHaveBeenCalledTimes(2);
});

it('does not dispatch a queued delayed click after the pending refreshed-row read succeeds', async () => {
  vi.useFakeTimers(); useSettingsStore.setState({ markAsReadDelay: 3000 });
  await show(); await open(); await advance(3000);
  expect(client.markAsRead).toHaveBeenCalledTimes(1); rowUnread();
  await refresh(); await open();
  await act(async () => { request.resolve(); }); rowRead();
  await advance(3000); await refresh(); await advance(60_000);
  expect(client.markAsRead).toHaveBeenCalledTimes(1);
});
