import React from 'react';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { useEmailStore } from '@/stores/email-store';
import { setClientForTests, useAuthStore } from '@/stores/auth-store';
import { useSettingsStore } from '@/stores/settings-store';
import { useMessageListTabsStore } from '@/stores/message-list-tabs-store';
import { useToastStore } from '@/stores/toast-store';
import { JMAPClient } from '@/lib/jmap/client';
import { clearUndoHistory, undoHistory } from '@/lib/undo-history';
import type { Email, Mailbox } from '@/lib/jmap/types';

// Real MailApp, Sidebar, AccountSwitcher, viewer, rows, auth/account/email stores,
// toast helper and JMAP batch/parser; only ancillary integrations and layout APIs are stubbed.
vi.mock('@/components/ui/avatar', () => ({ Avatar: () => null }));
vi.mock('@/hooks/use-email-drag', () => ({ useEmailDrag: () => ({ dragHandlers: {}, isDragging: false }) }));
vi.mock('@tanstack/react-virtual', () => ({
  useVirtualizer: ({ count }: { count: number }) => ({
    getVirtualItems: () => Array.from({ length: count }, (_, index) => ({ index, key: index, start: index * 80, size: 80 })),
    getTotalSize: () => count * 80, measureElement() {}, measure() {}, scrollToOffset() {}, scrollToIndex() {},
    measurementsCache: [], scrollOffset: 0, scrollRect: null,
  }),
}));

vi.mock('@/components/email/email-composer', () => ({ EmailComposer: () => null }));

vi.mock('@/components/layout/navigation-rail', () => ({ NavigationRail: () => null }));
vi.mock('@/components/layout/calendar-event-notification-toaster', () => ({ CalendarEventNotificationToaster: () => null }));
vi.mock('@/components/layout/share-notification-toaster', () => ({ ShareNotificationToaster: () => null }));
vi.mock('@/components/layout/mobile-header', () => ({ MobileHeader: () => null }));
vi.mock('@/components/email/message-list-tabs', () => ({ useMessageListPanelProps: (id: string) => ({ id }), MessageListTabs: () => null }));
vi.mock('@/components/search/search-box', () => ({ SearchBox: () => null }));
vi.mock('@/components/tour/tour-provider', () => ({ useTour: () => ({ activeTour: null, registerStep: vi.fn() }) }));
vi.mock('@/components/plugins/plugin-slot', () => ({ PluginSlot: () => null }));
vi.mock('@/hooks/use-plugin-slot-offers', () => ({ usePluginSlotOffers: () => [] }));
vi.mock('@/hooks/use-config', async () => {
  const { createConfig } = await import('@/lib/__tests__/fixtures/config');
  const config = createConfig({ settingsSyncEnabled: false });
  return { useConfig: () => config, getCachedConfig: () => config, fetchConfig: async () => config };
});
vi.mock('@/hooks/use-identity-sync', () => ({ useIdentitySync: () => {} }));
vi.mock('@/hooks/use-pro-multi-account-identities', () => ({ useProMultiAccountIdentities: () => [] }));
vi.mock('@/hooks/use-pro-multi-account-mailboxes', () => ({ useProMultiAccountMailboxes: () => {} }));
vi.mock('@/hooks/use-wopi-status', () => ({ useWopiStatus: () => null, canWopiOpen: () => false }));
vi.mock('@/hooks/use-browser-navigation', () => ({ useBrowserNavigation: () => {} }));
vi.mock('@/hooks/use-media-query', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/hooks/use-media-query')>()),
  useDeviceDetection: () => ({ isMobile: false, isCompact: false, isDesktop: true }),
  useMediaQuery: () => false,
  useIsDesktop: () => true,
  useIsMobile: () => false,
}));
vi.mock('@/lib/push-bindings', () => ({ reconcilePushBindings: () => {}, releasePushBindings: () => {} }));

vi.mock('next/dynamic', () => ({ default: (load: () => Promise<React.ComponentType<Record<string, unknown>>>) => {
  const Lazy = React.lazy(async () => ({ default: await load() }));
  return (props: Record<string, unknown>) => <React.Suspense fallback={null}><Lazy {...props}/></React.Suspense>;
} }));


import { useAccountStore } from '@/stores/account-store';
import { useIdentityStore } from '@/stores/identity-store';
import { clearAllStores, snapshotAccount, evictAll } from '@/lib/account-state-manager';
import { clearAllHooks } from '@/lib/plugin-hooks';
import { forgetFolderLists } from '@/lib/folder-list-cache';
await import('@/components/email/email-viewer');
const { MailApp } = await import('../mail-app');
const { usePluginStore } = await import('@/stores/plugin-store');
const { usePolicyStore } = await import('@/stores/policy-store');
const account = (name: string, slot: number) => ({
  id: `${name}@audit.invalid@mail.audit.invalid`, serverUrl: 'https://mail.audit.invalid',
  username: `${name}@audit.invalid`, email: `${name}@audit.invalid`, displayName: name,
  label: name, authMode: 'basic' as const, rememberMe: false, cookieSlot: slot,
  isConnected: true, hasError: false, lastLoginAt: 1, avatarColor: '#000', isDefault: slot === 0,
});
const A = account('A', 0), B = account('B', 1);
const mail = (owner: string, id: string): Email => ({
  id, threadId: `t-${id}`, blobId: `${owner}-${id}`, subject: `${owner} subject ${id}`,
  mailboxIds: { inbox: true }, keywords: { '$label:work': true }, size: 10,
  from: [{ email: 'sender@audit.invalid' }], to: [{ email: 'recipient@audit.invalid' }],
  receivedAt: '2026-11-13T09:00:00Z', preview: 'Synthetic fixture', hasAttachment: false,
  textBody: [], htmlBody: [], bodyValues: {}, attachments: [],
}) as Email;
const inbox = { id: 'inbox', name: 'Inbox', role: 'inbox', totalEmails: 2, totalThreads: 2,
  unreadEmails: 2, unreadThreads: 2, myRights: { mayReadItems: true, maySetSeen: true } } as Mailbox;
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(yes => { resolve = yes; }); return { promise, resolve };
}
const reply = (owner: string, ids: string[]) => ({ methodResponses: [['Email/set', {
  accountId: owner, oldState: 'before', newState: 'after',
  updated: Object.fromEntries(ids.map(id => [id, null])),
}, '0']], sessionState: 'synthetic' });
const tick = async (ms = 0) => { await act(async () => { await vi.advanceTimersByTimeAsync(ms); }); };
const row = (id: string) => document.querySelector(`[data-email-id="${id}"]`)!;
let network: ReturnType<typeof vi.fn>;
beforeEach(() => {
  vi.useFakeTimers(); clearAllHooks(); evictAll(); forgetFolderLists(); clearAllStores();
  useEmailStore.setState(useEmailStore.getInitialState(), true);
  useMessageListTabsStore.setState(useMessageListTabsStore.getInitialState(), true);
  useAuthStore.setState(useAuthStore.getInitialState(), true);
  useAccountStore.setState({ accounts: [A, B], activeAccountId: A.id, defaultAccountId: A.id });
  useSettingsStore.setState({ disableThreading: true, markAsReadDelay: -1, senderFavicons: false,
    enableUnifiedMailbox: false, interfaceLayout: 'default', mailLayout: 'split', sidebarAccountSwitcher: true,
    emailKeywords: [{ id: 'work', label: 'Work', color: 'blue' }], flushSync: vi.fn().mockResolvedValue(undefined) } as never);
  network = vi.fn(() => { throw new Error('Network denied in account-switch regression'); });
  vi.stubGlobal('fetch', network);
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} });
  useToastStore.setState({ toasts: [] }); clearUndoHistory();
  usePluginStore.setState({ initializePlugins: vi.fn().mockResolvedValue(undefined) });
  usePolicyStore.setState({ loaded: true, partial: false, fetching: false,
    fetchPolicy: vi.fn().mockResolvedValue(undefined), refreshIfPartial: vi.fn().mockResolvedValue(undefined) });
  useEmailStore.setState({ fetchQuota: vi.fn().mockResolvedValue(undefined), refreshScheduledMetadata: vi.fn().mockResolvedValue(undefined) });
});
afterEach(() => { cleanup(); expect(network).not.toHaveBeenCalled(); vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals(); clearAllHooks(); });

it("switches with A's bulk request pending, keeps B feedback and selection, then acts on B's own row", async () => {
  const rowsA = [mail('A', 'shared'), mail('A', 'a-only')];
  const rowsB = [mail('B', 'shared'), mail('B', 'b-only')];
  function makeClient(entry: typeof A, rows: Email[], owner: string) {
    const c = new JMAPClient(entry.serverUrl, entry.username, 'synthetic-unused');
    Object.assign(c, { accountId: owner, apiUrl: 'https://mail.audit.invalid/api' });
    vi.spyOn(c, 'getSessionUsername').mockReturnValue(entry.username);
    vi.spyOn(c, 'getIdentities').mockResolvedValue([{ id: owner, email: entry.email, name: entry.displayName, mayDelete: false }]);
    vi.spyOn(c, 'getMaxObjectsInSet').mockReturnValue(1000);
    vi.spyOn(c, 'getAllMailboxesWithState').mockResolvedValue({ mailboxes: [inbox], states: {} });
    vi.spyOn(c, 'getEmails').mockResolvedValue({ emails: rows, hasMore: false, total: 2, threadCounts: {} });
    vi.spyOn(c, 'getTagCounts').mockResolvedValue({ work: { total: 2, unread: 2 } });
    vi.spyOn(c, 'getEmail').mockImplementation(async id => rows.find(e => e.id === id)!);
    setClientForTests(entry.id, c); return c;
  }
  const ca = makeClient(A, rowsA, 'owner-A'), cb = makeClient(B, rowsB, 'owner-B');
  const pendingA = deferred<ReturnType<typeof reply>>(), pendingB = deferred<ReturnType<typeof reply>>();
  const requestA = vi.spyOn(ca as unknown as { request: (methods: unknown[]) => Promise<unknown> }, 'request').mockReturnValue(pendingA.promise);
  const requestB = vi.spyOn(cb as unknown as { request: (methods: unknown[]) => Promise<unknown> }, 'request').mockReturnValue(pendingB.promise);
  useEmailStore.setState({ emails: rowsB, mailboxes: [inbox], selectedMailbox: 'inbox', isLoading: false });
  useIdentityStore.setState({ identities: [{ id: 'B', email: B.email, name: 'B', mayDelete: false }] });
  snapshotAccount(B.id); clearAllStores();
  useEmailStore.setState({ emails: rowsA, mailboxes: [inbox], selectedMailbox: 'inbox', isLoading: false });
  useAuthStore.setState({ isAuthenticated: true, isLoading: false, client: ca, activeAccountId: A.id });
  render(<MailApp />); await tick();
  for (const id of ['shared', 'a-only']) fireEvent.click(row(id), { ctrlKey: true });
  fireEvent.click(screen.getByTestId('batch-mark-read')); await tick();
  expect(requestA).toHaveBeenCalledTimes(1);
  expect(screen.getByTestId('account-switcher')).toBeEnabled();
  fireEvent.click(screen.getByTestId('account-switcher')); await tick();
  const option = document.querySelector(`[data-account-id="${B.id}"]`)!;
  expect(option).toBeEnabled(); fireEvent.click(option); await tick();
  expect(useAuthStore.getState().activeAccountId).toBe(B.id);
  fireEvent.click(row('shared')); await tick(); fireEvent.click(row('b-only'), { ctrlKey: true }); await tick();
  vi.mocked(cb.getEmails).mockRejectedValueOnce(new Error('B own folder error'));
  await act(async () => { await useEmailStore.getState().fetchEmails(cb, 'inbox', { background: true }); });
  await act(async () => pendingA.resolve(reply('owner-A', ['shared', 'a-only']))); await tick(501);
  expect(useEmailStore.getState().emails.map(e => e.subject)).toEqual(['B subject shared', 'B subject b-only']);
  expect(row('b-only')).toHaveTextContent('B subject b-only'); expect(row('a-only')).toBeNull();
  expect(useEmailStore.getState().selectedEmail?.subject).toBe('B subject shared');
  expect([...useEmailStore.getState().selectedEmailKeys]).toEqual(['b-only']);
  expect(useEmailStore.getState().error).toBe('B own folder error');
  expect(useToastStore.getState().toasts).toEqual([]); expect(undoHistory()).toEqual([]);
  const bulk = screen.getByTestId('batch-mark-read'); expect(bulk).toBeEnabled(); fireEvent.click(bulk); await tick();
  expect(requestB.mock.calls).toEqual([[[['Email/set', { accountId: 'owner-B', update: { 'b-only': { 'keywords/$seen': true } } }, '0']]]]);
  await act(async () => pendingB.resolve(reply('owner-B', ['b-only']))); await tick();
});
