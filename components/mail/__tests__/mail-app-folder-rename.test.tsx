import React, { Suspense, lazy } from 'react';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { Mailbox } from '@/lib/jmap/types';
import { useAuthStore } from '@/stores/auth-store';
import { useEmailStore } from '@/stores/email-store';
import { useSettingsStore } from '@/stores/settings-store';
import { usePluginStore } from '@/stores/plugin-store';
import { useThemeStore } from '@/stores/theme-store';
import { useToastStore } from '@/stores/toast-store';
import { DEFAULT_SEARCH_FILTERS } from '@/lib/jmap/search-utils';
import type { IJMAPClient } from '@/lib/jmap/client-interface';
import { clearAllHooks } from '@/lib/plugin-hooks';

// Exercise the standard sidebar and prompt through MailApp and the real store.
// Only unrelated surfaces and services are mocked. Account transitions below
// use the real switcher, auth action and snapshots, with local demo clients.

vi.mock('next/dynamic', () => ({ default: (load: () => Promise<React.ComponentType<Record<string, unknown>>>) => {
  const Component = lazy(async () => ({ default: await load() }));
  return function Dynamic(props: Record<string, unknown>) {
    return <Suspense fallback={null}><Component {...props} /></Suspense>;
  };
} }));
vi.mock('@/components/email/email-viewer', () => ({
  EmailViewer: ({ onDelete }: { onDelete?: () => void }) => (
    <button onClick={() => onDelete?.()}>stub delete</button>
  ),
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
vi.mock('@/hooks/use-config', () => ({ useConfig: () => ({ appName: 'Mail' }), fetchConfig: async () => ({ settingsSyncEnabled: false }) }));
vi.mock('@/hooks/use-identity-sync', () => ({ useIdentitySync: () => {} }));
vi.mock('@/hooks/use-pro-multi-account-identities', () => ({ useProMultiAccountIdentities: () => [] }));
vi.mock('@/hooks/use-pro-multi-account-mailboxes', () => ({ useProMultiAccountMailboxes: () => {} }));
vi.mock('@/hooks/use-wopi-status', () => ({ useWopiStatus: () => null, canWopiOpen: () => false }));
vi.mock('@/hooks/use-browser-navigation', () => ({ useBrowserNavigation: () => {} }));
vi.mock('@/hooks/use-media-query', () => ({
  useDeviceDetection: () => ({ isMobile: false, isTablet: false, isDesktop: true }),
  useMediaQuery: () => false,
  useIsDesktop: () => true,
}));
vi.mock('@/lib/push-bindings', () => ({ reconcilePushBindings: () => {}, releasePushBindings: () => {} }));
vi.mock('@/components/email/email-list', () => ({ EmailList: () => <div>message list</div> }));

vi.mock('@/hooks/use-mailbox-drop', () => ({ useMailboxDrop: () => ({ dropHandlers: {}, isValidDropTarget: false, isInvalidDropTarget: false }) }));
vi.mock('@/hooks/use-tag-drop', () => ({ useTagDrop: () => ({ dropHandlers: {}, isValidDropTarget: false }) }));
vi.mock('@/components/email/rules-menu', () => ({ FolderRulesSubMenu: () => null }));
import { usePolicyStore } from '@/stores/policy-store';
import { useUIStore } from '@/stores/ui-store';
import { useAccountStore } from '@/stores/account-store';
import { snapshotAccount, evictAll } from '@/lib/account-state-manager';
import { JMAPClient } from '@/lib/jmap/client';

const { MailApp } = await import('@/components/mail/mail-app');
const actualGetClientForAccount = useAuthStore.getState().getClientForAccount;
const actualGetAllConnectedClients = useAuthStore.getState().getAllConnectedClients;
const originalFetchMailboxes = useEmailStore.getState().fetchMailboxes;
function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}
function box(id: string, name: string, extra: Partial<Mailbox> = {}): Mailbox {
  return { id, name, sortOrder: 1, totalEmails: 0, unreadEmails: 0, totalThreads: 0, unreadThreads: 0,
    myRights: { mayReadItems: true, mayRename: true, mayDelete: true, mayCreateChild: true,
      mayAddItems: true, mayRemoveItems: true, maySetSeen: true, maySetKeywords: true, maySubmit: true },
    isSubscribed: true, isShared: false, ...extra };
}
const initialBoxes = () => [box('inbox', 'Inbox', { role: 'inbox' }), box('same-id', 'A projects', { accountId: 'jmap-a' }), box('other', 'Other')];
let service: ReturnType<typeof deferred<void>>;
let client: ReturnType<typeof fixtureClient>;
let network: ReturnType<typeof vi.fn>;
const row = (id = 'same-id') => screen.getAllByTestId('folder-row').find(el => el.getAttribute('data-mailbox-id') === id)!;
const folderButton = (id = 'same-id') => row(id).querySelector('button')!;
const toastTitles = () => useToastStore.getState().toasts.map(t => [t.type, t.title]);
async function openRename(id = 'same-id') {
  await waitFor(() => expect(row(id)).toBeTruthy());
  fireEvent.contextMenu(row(id), { clientX: 20, clientY: 20 });
  const rename = await screen.findByTestId('mailbox-rename');
  expect(rename).not.toBeDisabled();
  fireEvent.click(rename);
  return await screen.findByRole('textbox', { name: 'mailbox_context_menu.rename' });
}
async function submitRename(name: string, id = 'same-id') {
  const input = await openRename(id);
  fireEvent.change(input, { target: { value: name } });
  fireEvent.click(screen.getByRole('button', { name: 'mailbox_context_menu.rename_confirm' }));
  await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
}
async function renderMail() {
  render(<MailApp />);
  await waitFor(() => expect(row()).toBeTruthy());
}
function fixtureClient() {
  return {
    getAccountId: () => 'jmap-a', getServerUrl: () => 'https://a.example.test', getUsername: () => 'a@example.test',
    getCapabilities: () => ({}), getSieveAccountId: () => null, hasDelayedSend: () => false, getSession: () => null,
    updateMailbox: vi.fn<IJMAPClient['updateMailbox']>(() => service.promise), getAllMailboxes: vi.fn().mockResolvedValue(initialBoxes()),
  };
}
beforeEach(() => {
  clearAllHooks(); evictAll();
  vi.spyOn(usePolicyStore.getState(), 'fetchPolicy').mockResolvedValue(undefined);
  localStorage.setItem('bulwark-demo-simulate', 'off');
  network = vi.fn().mockRejectedValue(new Error('Unexpected network request'));
  vi.stubGlobal('fetch', network);
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} });
  usePluginStore.setState({ initializePlugins: vi.fn().mockResolvedValue(undefined) });
  useThemeStore.setState({ syncServerThemes: vi.fn().mockResolvedValue(undefined) });
  useToastStore.setState({ toasts: [] });
  service = deferred();
  client = fixtureClient();
  useAccountStore.setState({ accounts: [], activeAccountId: 'login-a' });
  useAuthStore.setState({ isAuthenticated: true, isLoading: false, client, activeAccountId: 'login-a', identities: [],
    getClientForAccount: (id: string) => id === 'login-a' ? client : undefined,
    getAllConnectedClients: () => new Map([['login-a', client]]),
  } as never);
  useSettingsStore.setState({ enableUnifiedMailbox: false, interfaceLayout: 'default', mailLayout: 'split', simpleMode: false, hideAccountSwitcher: true } as never);
  useUIStore.setState({ activeView: 'list', sidebarOpen: false, sidebarCollapsed: false, sidebarWidth: 256, compactSidebarExpanded: false, isMobile: false, isCompact: false, isDesktop: true });
  useEmailStore.setState({ mailboxes: initialBoxes(), selectedMailbox: 'same-id', selectedEmail: null, emails: [],
    selectedKeyword: null, viewingAccountId: null, accountMailboxes: {}, isUnifiedView: false, unifiedRole: null,
    isScheduledView: false, isLoadingEmail: false, isLoading: false, searchQuery: '', error: null,
    searchFilters: { ...DEFAULT_SEARCH_FILTERS }, searchMailboxId: '', selectedEmailKeys: new Set(),
    fetchMailboxes: vi.fn().mockResolvedValue(undefined), fetchEmails: vi.fn().mockResolvedValue(undefined),
    fetchQuota: vi.fn().mockResolvedValue(undefined), fetchTagCounts: vi.fn().mockResolvedValue(undefined),
    refreshScheduledMetadata: vi.fn().mockResolvedValue(undefined),
  } as never);
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

it('success: pending keeps name, confirmation changes it, selected ID stays current', async () => {
  await renderMail();
  await submitRename('A renamed');
  expect(client.updateMailbox).toHaveBeenCalledWith('same-id', { name: 'A renamed' }, undefined);
  expect(row().textContent).toContain('A projects');
  expect(useEmailStore.getState().selectedMailbox).toBe('same-id');
  expect(folderButton()).toHaveAttribute('aria-current', 'page');
  expect(toastTitles()).toEqual([]);
  await act(async () => { service.resolve(); });
  expect(row().textContent).toContain('A renamed');
  expect(folderButton()).toHaveAttribute('aria-current', 'page');
  expect(toastTitles()).toContainEqual(['success', 'mailbox_context_menu.toast_folder_renamed']);
  expect(network).not.toHaveBeenCalled();
});
it('rejection: old name remains, store error and error toast; deliberate same-name retry dispatches', async () => {
  await renderMail(); await submitRename('A renamed');
  await act(async () => { service.reject(new Error('Rename refused')); });
  expect(row().textContent).toContain('A projects');
  expect(useEmailStore.getState().error).toBe('Rename refused');
  expect(toastTitles()).toContainEqual(['error', 'mailbox_context_menu.toast_error_rename']);
  expect(toastTitles().some(t => t[0] === 'success')).toBe(false);
  service = deferred();
  const input = await openRename(); expect(input).toHaveValue('A projects');
  fireEvent.change(input, { target: { value: 'A renamed' } });
  fireEvent.click(screen.getByRole('button', { name: 'mailbox_context_menu.rename_confirm' }));
  await waitFor(() => expect(client.updateMailbox).toHaveBeenCalledTimes(2));
  await act(async () => { service.resolve(); });
  expect(row().textContent).toContain('A renamed');
  expect(network).not.toHaveBeenCalled();
});
it('same-account navigation while pending preserves selected folder after completion', async () => {
  await renderMail(); await submitRename('A renamed');
  fireEvent.click(folderButton('other'));
  expect(useEmailStore.getState().selectedMailbox).toBe('other');
  await act(async () => { service.resolve(); });
  expect(useEmailStore.getState().selectedMailbox).toBe('other');
  expect(folderButton('other')).toHaveAttribute('aria-current', 'page');
  expect(row().textContent).toContain('A renamed');
});
it('refresh while pending preserves counts/permissions and does not resurrect a missing folder', async () => {
  await renderMail(); await submitRename('A renamed');
  client.getAllMailboxes.mockResolvedValue([box('inbox', 'Inbox', { role: 'inbox' }), box('other', 'Other')]);
  act(() => useEmailStore.setState({ fetchMailboxes: originalFetchMailboxes }));
  fireEvent.contextMenu(row(), { clientX: 20, clientY: 20 });
  fireEvent.click(await screen.findByRole('menuitem', { name: 'refresh' }));
  await waitFor(() => expect(client.getAllMailboxes).toHaveBeenCalled());
  await waitFor(() => expect(useEmailStore.getState().mailboxes.some(m => m.id === 'same-id')).toBe(false));
  const selectedAfterRefresh = useEmailStore.getState().selectedMailbox;
  await act(async () => { service.resolve(); });
  expect(useEmailStore.getState().mailboxes.some(m => m.id === 'same-id')).toBe(false);
  expect(useEmailStore.getState().selectedMailbox).toBe(selectedAfterRefresh);
});
it('refresh retains server name and rights while pending; next refresh remains authoritative', async () => {
  await renderMail(); await submitRename('A renamed');
  const serverBoxes = initialBoxes().map(m => m.id === 'same-id' ? { ...m, name: 'Server confirmed', unreadEmails: 3, myRights: { ...m.myRights, mayRename: false } } : m);
  client.getAllMailboxes.mockResolvedValue(serverBoxes);
  act(() => useEmailStore.setState({ fetchMailboxes: originalFetchMailboxes }));
  await act(async () => { await useEmailStore.getState().fetchMailboxes(client as unknown as IJMAPClient); });
  expect(row().textContent).toContain('Server confirmed');
  await act(async () => { service.resolve(); });
  const mb = useEmailStore.getState().mailboxes.find(m => m.id === 'same-id')!;
  expect(mb.myRights?.mayRename).toBe(false); expect(mb.unreadEmails).toBe(3);
  // Name supplied by this operation wins until the next server refresh. The mock
  // does not establish which concurrent server operation happened last.
  expect(mb.name).toBe('A renamed');
  await act(async () => { await useEmailStore.getState().fetchMailboxes(client as unknown as IJMAPClient); });
  expect(row().textContent).toContain('Server confirmed');
});

it.each(['method', 'record', 'transport'] as const)('%s refusal retains the confirmed name, reports failure and allows a deliberate retry', async (failure) => {
  const real = new JMAPClient('https://a.example.test', 'a@example.test', 'fake');
  Object.assign(real, { apiUrl: 'https://a.example.test/jmap', accountId: 'jmap-a' });
  const reply = deferred<Response>();
  network.mockImplementation(() => reply.promise);
  client.updateMailbox = vi.fn(real.updateMailbox.bind(real));
  await renderMail(); await submitRename('Requested name');
  expect(row().textContent).toContain('A projects');
  await waitFor(() => expect(network).toHaveBeenCalledTimes(1));
  expect(JSON.parse(network.mock.calls[0][1].body).methodCalls).toEqual([
    ['Mailbox/set', { accountId: 'jmap-a', update: { 'same-id': { name: 'Requested name' } } }, '0'],
  ]);
  await act(async () => {
    if (failure === 'transport') reply.reject(new TypeError('Failed to fetch'));
    else reply.resolve(new Response(JSON.stringify({ sessionState: 'session-1', methodResponses: failure === 'method'
      ? [['error', { type: 'forbidden', description: 'Rename forbidden' }, '0']]
      : [['Mailbox/set', { accountId: 'jmap-a', oldState: 's0', newState: 's0', notUpdated: { 'same-id': { type: 'forbidden' } } }, '0']],
    }), { status: 200 }));
  });
  expect(row().textContent).toContain('A projects');
  expect(useEmailStore.getState().error).toBeTruthy();
  expect(toastTitles()).toContainEqual(['error', 'mailbox_context_menu.toast_error_rename']);
  expect(toastTitles().some(t => t[0] === 'success')).toBe(false);
  const retry = deferred<Response>(); network.mockImplementation(() => retry.promise);
  const input = await openRename(); expect(input).toHaveValue('A projects');
  fireEvent.change(input, { target: { value: 'Requested name' } });
  fireEvent.click(screen.getByRole('button', { name: 'mailbox_context_menu.rename_confirm' }));
  await waitFor(() => expect(network).toHaveBeenCalledTimes(2));
  await act(async () => { retry.resolve(new Response(JSON.stringify({ sessionState: 'session-1', methodResponses: [
    ['Mailbox/set', { accountId: 'jmap-a', oldState: 's0', newState: 's1', updated: { 'same-id': null } }, '0'],
  ] }), { status: 200 })); });
  expect(row().textContent).toContain('Requested name');
});
it('permissions/system controls: mayRename=false disables, system roles omit rename', async () => {
  act(() => useEmailStore.getState().setMailboxes(initialBoxes().map(m => m.id === 'same-id' ? { ...m, myRights: { ...m.myRights, mayRename: false } } : m)));
  await renderMail();
  fireEvent.contextMenu(row(), { clientX: 20, clientY: 20 });
  expect(await screen.findByTestId('mailbox-rename')).toBeDisabled();
  fireEvent.keyDown(document, { key: 'Escape' });
  fireEvent.contextMenu(row('inbox'), { clientX: 20, clientY: 20 });
  expect(screen.queryByTestId('mailbox-rename')).toBeNull();
  expect(client.updateMailbox).not.toHaveBeenCalled();
});
it('unchanged and blank prompts dispatch nothing', async () => {
  await renderMail();
  await openRename();
  fireEvent.click(screen.getByRole('button', { name: 'mailbox_context_menu.rename_confirm' }));
  await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  const input = await openRename(); fireEvent.change(input, { target: { value: '   ' } });
  expect(screen.getByRole('button', { name: 'mailbox_context_menu.rename_confirm' })).toBeDisabled();
  expect(client.updateMailbox).not.toHaveBeenCalled();
});
it.each([
  { returnBefore: false, reject: false },
  { returnBefore: true, reject: false },
  { returnBefore: false, reject: true },
  { returnBefore: true, reject: true },
])('account switch (return to A=$returnBefore, reject=$reject) protects names and errors without hiding server success', async ({ returnBefore, reject }) => {
  useAuthStore.setState({ getClientForAccount: actualGetClientForAccount, getAllConnectedClients: actualGetAllConnectedClients });
  expect(await useAuthStore.getState().loginDemo()).toBe(true);
  const aId = useAuthStore.getState().activeAccountId!;
  const accounts = useAccountStore.getState().accounts;
  const bId = accounts.find(a => a.id !== aId)!.id;
  const a = actualGetClientForAccount(aId)!;
  const b = actualGetClientForAccount(bId)!;
  const aBoxes = [box('inbox', 'Inbox', { role: 'inbox' }), box('same-id', 'A projects', { accountId: a.getAccountId() })];
  const bBoxes = [box('inbox', 'Inbox', { role: 'inbox' }), box('same-id', 'B projects', { accountId: b.getAccountId() })];
  useEmailStore.getState().setMailboxes(bBoxes); useEmailStore.getState().selectMailbox('same-id'); snapshotAccount(bId);
  useEmailStore.getState().setMailboxes(aBoxes); useEmailStore.getState().selectMailbox('same-id');
  const aUpdate = vi.spyOn(a, 'updateMailbox').mockImplementation(() => service.promise);
  const bUpdate = vi.spyOn(b, 'updateMailbox');
  useSettingsStore.setState({ hideAccountSwitcher: false, interfaceLayout: 'default', enableUnifiedMailbox: false } as never);
  await renderMail(); await submitRename('A renamed');
  expect(aUpdate).toHaveBeenCalledWith('same-id', { name: 'A renamed' }, undefined);
  fireEvent.click(screen.getByTestId('account-switcher'));
  const bOption = screen.getAllByTestId('account-option').find(el => el.textContent?.includes(accounts.find(account => account.id === bId)!.email))!;
  fireEvent.click(bOption);
  await waitFor(() => expect(useAuthStore.getState().activeAccountId).toBe(bId));
  await waitFor(() => expect(row().textContent).toContain('B projects'));
  if (returnBefore) {
    await act(async () => { await useAuthStore.getState().switchAccount(aId); });
    // A has returned and refreshed while the original request is still pending.
    act(() => useEmailStore.getState().setMailboxes(aBoxes.map(m => m.id === 'same-id' ? { ...m, name: 'A refreshed' } : m)));
  }
  act(() => useEmailStore.getState().setError('Current account error'));
  const expectedName = returnBefore ? 'A refreshed' : 'B projects';
  await act(async () => { if (reject) service.reject(new Error('Old rename refused')); else service.resolve(); });
  expect(row().textContent).toContain(expectedName);
  expect(useEmailStore.getState().error).toBe('Current account error');
  expect(useEmailStore.getState().selectedMailbox).toBe('same-id');
  expect(bUpdate).not.toHaveBeenCalled();
  // A confirmed server operation still succeeds even when its view is stale.
  expect(toastTitles()).toContainEqual([reject ? 'error' : 'success', reject ? 'mailbox_context_menu.toast_error_rename' : 'mailbox_context_menu.toast_folder_renamed']);
  a.disconnect(); b.disconnect();
}, 15000);
