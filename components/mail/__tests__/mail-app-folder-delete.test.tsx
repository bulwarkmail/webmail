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
import { ToastContainer } from '@/components/ui/toast';
import { DEFAULT_SEARCH_FILTERS } from '@/lib/jmap/search-utils';
import { clearAllHooks, emailHooks } from '@/lib/plugin-hooks';

// Exercise the real standard sidebar, confirmation, MailApp, store and JMAP
// deletion over deferred HTTP responses. Only external services and unrelated
// surfaces are mocked; both personal and delegated folders use the same UI.

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
vi.mock('@/hooks/use-media-query', async (importOriginal) => ({
  ...await importOriginal<typeof import('@/hooks/use-media-query')>(),
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
import { evictAll } from '@/lib/account-state-manager';
import { JMAPClient } from '@/lib/jmap/client';

const { MailApp } = await import('@/components/mail/mail-app');
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


const initialBoxes = () => [
  box('inbox', 'Inbox', { role: 'inbox', accountId: 'own' }),
  box('projects', 'Projects', { accountId: 'own' }),
  box('other', 'Other', { accountId: 'own' }),
  box('owner:projects', 'Shared projects', { originalId: 'projects', accountId: 'owner', accountName: 'Team', isShared: true }),
];
let reply: ReturnType<typeof deferred<Response>>;
let client: ReturnType<typeof fixtureClient>;
let network: ReturnType<typeof vi.fn<typeof fetch>>;
let deleted: ReturnType<typeof vi.fn<() => void>>;
const row = (id: string) => screen.queryAllByTestId('folder-row').find(el => el.getAttribute('data-mailbox-id') === id);
const toastTitles = () => useToastStore.getState().toasts.map(t => [t.type, t.title]);
const targetId = (shared: boolean) => shared ? 'owner:projects' : 'projects';
function fixtureClient() {
  const real = new JMAPClient('https://mail.example.test', 'a@example.test', 'synthetic');
  Object.assign(real, { apiUrl: 'https://mail.example.test/jmap', accountId: 'own' });
  return {
    getAccountId: () => 'own', getServerUrl: () => 'https://mail.example.test', getUsername: () => 'a@example.test',
    getCapabilities: () => ({}), getSieveAccountId: () => null, hasDelayedSend: () => false, getSession: () => null,
    deleteMailbox: vi.fn(real.deleteMailbox.bind(real)),
    getAllMailboxes: vi.fn().mockResolvedValue(initialBoxes()),
  };
}
function ToastSurface() {
  const toasts = useToastStore(s => s.toasts);
  const remove = useToastStore(s => s.removeToast);
  return <ToastContainer toasts={toasts} onClose={remove} />;
}
async function renderMail(id: string) {
  useEmailStore.setState({ selectedMailbox: id });
  render(<><MailApp /><ToastSurface /></>);
  await waitFor(() => expect(row(id)).toBeTruthy());
}
async function openDelete(id: string) {
  fireEvent.contextMenu(row(id)!, { clientX: 20, clientY: 20 });
  const item = await screen.findByTestId('mailbox-delete');
  expect(item).not.toBeDisabled();
  fireEvent.click(item);
  await screen.findByRole('alertdialog', { name: 'mailbox_context_menu.delete_confirm_title' });
}
async function confirmDelete(id: string, previousRequests = 0) {
  await openDelete(id);
  expect(network).toHaveBeenCalledTimes(previousRequests);
  fireEvent.click(screen.getByRole('button', { name: 'mailbox_context_menu.delete_folder' }));
  await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull());
  await waitFor(() => expect(network).toHaveBeenCalledTimes(previousRequests + 1));
}
function response(method: string, result: Record<string, unknown>) {
  return new Response(JSON.stringify({ sessionState: 'session-1', methodResponses: [[method, result, '0']] }), {
    status: 200, headers: { 'content-type': 'application/json' },
  });
}
function expectRequest(shared: boolean, index = 0) {
  expect(network.mock.calls[index][0]).toBe('https://mail.example.test/jmap');
  expect(JSON.parse(network.mock.calls[index][1]!.body as string).methodCalls).toEqual([
    ['Mailbox/set', { accountId: shared ? 'owner' : 'own', destroy: ['projects'] }, '0'],
  ]);
  expect(client.deleteMailbox).toHaveBeenLastCalledWith('projects', shared ? 'owner' : undefined);
}
function expectPending(id: string) {
  expect(useEmailStore.getState().mailboxes).toEqual(initialBoxes());
  expect(useEmailStore.getState().selectedMailbox).toBe(id);
  expect(row(id)!.querySelector('button')).toHaveAttribute('aria-current', 'page');
  expect(toastTitles()).toEqual([]);
  expect(deleted).not.toHaveBeenCalled();
}
async function resolveSuccess(shared: boolean) {
  await act(async () => { reply.resolve(response('Mailbox/set', {
    accountId: shared ? 'owner' : 'own', oldState: 's0', newState: 's1', destroyed: ['projects'],
  })); });
  const id = targetId(shared);
  expect(useEmailStore.getState().mailboxes).toEqual(initialBoxes().filter(b => b.id !== id));
  expect(row(id)).toBeUndefined();
  expect(useEmailStore.getState().selectedMailbox).toBe('inbox');
  expect(deleted).toHaveBeenCalledExactlyOnceWith({ mailboxId: id, name: shared ? 'Shared projects' : 'Projects' });
  expect(toastTitles()).toContainEqual(['success', 'mailbox_context_menu.toast_folder_deleted']);
}
beforeEach(() => {
  clearAllHooks(); evictAll();
  vi.spyOn(usePolicyStore.getState(), 'fetchPolicy').mockResolvedValue(undefined);
  localStorage.setItem('bulwark-demo-simulate', 'off');
  localStorage.setItem('sidebarSharedExpanded', 'true');
  localStorage.setItem('sidebarExpandedSharedAccounts', JSON.stringify(['shared-account-owner']));
  reply = deferred<Response>(); client = fixtureClient();
  network = vi.fn<typeof fetch>().mockImplementation((_url, init) => {
    expect(init?.method).toBe('POST');
    expect(_url).toBe('https://mail.example.test/jmap');
    return reply.promise;
  });
  vi.stubGlobal('fetch', network);
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} });
  usePluginStore.setState({ initializePlugins: vi.fn().mockResolvedValue(undefined) });
  useThemeStore.setState({ syncServerThemes: vi.fn().mockResolvedValue(undefined) });
  useToastStore.setState({ toasts: [] });
  deleted = vi.fn(); emailHooks.onMailboxDelete.register('delete-test', deleted);
  useAccountStore.setState({ accounts: [], activeAccountId: 'login' });
  useAuthStore.setState({ isAuthenticated: true, isLoading: false, client, activeAccountId: 'login', identities: [],
    getClientForAccount: (id: string) => id === 'login' ? client : undefined,
    getAllConnectedClients: () => new Map([['login', client]]),
  } as never);
  useSettingsStore.setState({ enableUnifiedMailbox: false, interfaceLayout: 'default', mailLayout: 'split', simpleMode: false, hideAccountSwitcher: true } as never);
  useUIStore.setState({ activeView: 'list', sidebarOpen: false, sidebarCollapsed: false, sidebarWidth: 256, compactSidebarExpanded: false, isMobile: false, isCompact: false, isDesktop: true });
  useEmailStore.setState({ mailboxes: initialBoxes(), selectedMailbox: 'projects', selectedEmail: null, emails: [],
    selectedKeyword: null, viewingAccountId: null, accountMailboxes: {}, isUnifiedView: false, unifiedRole: null,
    isScheduledView: false, isLoadingEmail: false, isLoading: false, searchQuery: '', error: null,
    searchFilters: { ...DEFAULT_SEARCH_FILTERS }, searchMailboxId: '', selectedEmailKeys: new Set(),
    fetchMailboxes: vi.fn().mockResolvedValue(undefined), fetchEmails: vi.fn().mockResolvedValue(undefined),
    fetchQuota: vi.fn().mockResolvedValue(undefined), fetchTagCounts: vi.fn().mockResolvedValue(undefined),
    refreshScheduledMetadata: vi.fn().mockResolvedValue(undefined),
  } as never);
});
afterEach(() => { clearAllHooks(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

it.each([false, true])('method refusal preserves folder and selection and allows deliberate retry (shared=%s)', async shared => {
  const id = targetId(shared);
  await renderMail(id); await confirmDelete(id); expectPending(id); expectRequest(shared);
  await act(async () => { reply.resolve(response('error', { type: 'forbidden', description: 'Deletion refused by policy' })); });
  expect(useEmailStore.getState().mailboxes).toEqual(initialBoxes());
  expect(useEmailStore.getState().selectedMailbox).toBe(id);
  expect(row(id)!.querySelector('button')).toHaveAttribute('aria-current', 'page');
  expect(useEmailStore.getState().error).toBe('Delete mailbox failed: Deletion refused by policy');
  expect(toastTitles()).toEqual([['error', 'mailbox_context_menu.toast_error_delete']]);
  expect(screen.getByText('mailbox_context_menu.toast_error_delete')).toBeVisible();
  expect(deleted).not.toHaveBeenCalled();
  expect(network).toHaveBeenCalledTimes(1);

  reply = deferred<Response>();
  await confirmDelete(id, 1); expectRequest(shared, 1);
  expect(useEmailStore.getState().mailboxes).toEqual(initialBoxes());
  expect(deleted).not.toHaveBeenCalled();
  await resolveSuccess(shared);
  expect(network).toHaveBeenCalledTimes(2);
  expect(toastTitles().filter(t => t[0] === 'success')).toEqual([['success', 'mailbox_context_menu.toast_folder_deleted']]);
});
it.each([false, true])('successful deletion removes only the confirmed target (shared=%s)', async shared => {
  const id = targetId(shared);
  await renderMail(id); await confirmDelete(id); expectPending(id); expectRequest(shared);
  await resolveSuccess(shared);
  expect(toastTitles()).toEqual([['success', 'mailbox_context_menu.toast_folder_deleted']]);
  expect(network).toHaveBeenCalledTimes(1);
});
it('keeps the specialized mailboxHasChild refusal handling', async () => {
  await renderMail('projects'); await confirmDelete('projects');
  await act(async () => { reply.resolve(response('Mailbox/set', {
    notDestroyed: { projects: { type: 'mailboxHasChild', description: 'Server child restriction' } },
  })); });
  expect(useEmailStore.getState().mailboxes).toEqual(initialBoxes());
  expect(useEmailStore.getState().selectedMailbox).toBe('projects');
  expect(useEmailStore.getState().error).toBe('Server child restriction');
  expect(toastTitles()).toEqual([['error', 'mailbox_context_menu.toast_error_delete_has_children']]);
  expect(deleted).not.toHaveBeenCalled();
});
