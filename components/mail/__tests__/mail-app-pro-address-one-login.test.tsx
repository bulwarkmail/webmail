import React, { Suspense, lazy } from 'react';
import { act, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Mailbox } from '@/lib/jmap/types';
import { useAuthStore } from '@/stores/auth-store';
import { useAccountStore } from '@/stores/account-store';
import { useEmailStore } from '@/stores/email-store';
import { useSettingsStore } from '@/stores/settings-store';
import { usePluginStore } from '@/stores/plugin-store';
import { useThemeStore } from '@/stores/theme-store';
import { useToastStore } from '@/stores/toast-store';
import { DEFAULT_SEARCH_FILTERS } from '@/lib/jmap/search-utils';
import { clearAllHooks } from '@/lib/plugin-hooks';
import { clearPendingDeepLinks, setPendingDeepLink } from '@/lib/deep-link-handoff';
import { EmbeddedContext } from '@/hooks/use-is-embedded';
import { useProTabStore } from '@/stores/pro-tab-store';

// The Pro shell's address of a message (a reload of it, or the same address
// pasted) reaches the Pro mail surface through the handoff. With one login in
// the account list, as most users have, an address that names no login (a
// bookmark from before addresses named one, a URL copied from the standard
// layout, which keeps the short form for one login, or from another device)
// can only mean that login's message, and opens as it always did.
// The harness is the one of mail-app-pro-address.test.tsx.

vi.mock('next/dynamic', () => ({ default: (load: () => Promise<React.ComponentType<Record<string, unknown>>>) => {
  const Component = lazy(async () => ({ default: await load() }));
  return function Dynamic(props: Record<string, unknown>) {
    return <Suspense fallback={null}><Component {...props} /></Suspense>;
  };
} }));
vi.mock('@/components/email/email-viewer', () => ({ EmailViewer: () => <div>reader</div> }));
vi.mock('@/components/email/email-composer', () => ({ EmailComposer: () => null }));
vi.mock('@/components/layout/sidebar', () => ({ Sidebar: () => null }));
vi.mock('@/components/layout/navigation-rail', () => ({ NavigationRail: () => null }));
vi.mock('@/components/layout/calendar-event-notification-toaster', () => ({ CalendarEventNotificationToaster: () => null }));
vi.mock('@/components/layout/share-notification-toaster', () => ({ ShareNotificationToaster: () => null }));
vi.mock('@/components/layout/mobile-header', () => ({ MobileHeader: () => null }));
vi.mock('@/components/email/message-list-tabs', () => ({ useMessageListPanelProps: (id: string) => ({ id }), MessageListTabs: () => null }));
vi.mock('@/components/search/search-box', () => ({ SearchBox: () => null }));
vi.mock('@/components/tour/tour-provider', () => ({ useTour: () => ({ activeTour: null, registerStep: vi.fn() }) }));
vi.mock('@/components/plugins/plugin-slot', () => ({ PluginSlot: () => null }));
vi.mock('@/hooks/use-plugin-slot-offers', () => ({ usePluginSlotOffers: () => [] }));
vi.mock('@/hooks/use-config', () => ({ useConfig: () => ({ appName: 'Mail' }) }));
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

const { MailApp } = await import('../mail-app');

function mailbox(id: string, role: string | undefined, accountId: string, shared = false): Mailbox {
  return {
    id: shared ? `${accountId}:${id}` : id, originalId: id, name: role ?? id, role, accountId, isShared: shared,
    sortOrder: 0, totalEmails: 0, unreadEmails: 0, totalThreads: 0, unreadThreads: 0, isSubscribed: true,
  } as Mailbox;
}
const folders = [mailbox('a', 'inbox', 'cf'), mailbox('a', 'inbox', 'ce', true)];
const ID = 'eaaaaab';

beforeEach(() => {
  vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('Unexpected network request')));
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} });
  usePluginStore.setState({ initializePlugins: vi.fn().mockResolvedValue(undefined) });
  useThemeStore.setState({ syncServerThemes: vi.fn().mockResolvedValue(undefined) });
  useToastStore.setState({ toasts: [] });
  clearAllHooks();
  clearPendingDeepLinks();
  const client = {
    getAccountId: () => 'cf', getUsername: () => 'a@example.org',
    getSieveAccountId: () => null, hasDelayedSend: () => false, getSession: () => null,
    getMailboxes: vi.fn().mockResolvedValue(folders), getEmail: vi.fn().mockResolvedValue(null),
    getSharedAccounts: () => ['cf', 'ce'].map((id) => ({ id, name: id, isPrimary: id === 'cf', capabilities: { mail: true } })),
  };
  useAuthStore.setState({
    isAuthenticated: true, isLoading: false, client: client as never, activeAccountId: 'login-a', identities: [],
    getClientForAccount: (id: string) => (id === 'login-a' ? client : undefined) as never,
    getAllConnectedClients: () => new Map([['login-a', client]]) as never,
  });
  useSettingsStore.setState({ enableUnifiedMailbox: false, mailLayout: 'split' } as never);
  useEmailStore.setState({
    emails: [], selectedEmail: null, selectedMailbox: 'a', selectedKeyword: null, mailboxes: folders,
    viewingAccountId: null, accountMailboxes: {}, isUnifiedView: false, unifiedRole: null,
    isScheduledView: false, isLoadingEmail: false, isLoading: false, searchQuery: '',
    searchFilters: { ...DEFAULT_SEARCH_FILTERS }, searchMailboxId: '', selectedEmailKeys: new Set(),
    fetchMailboxes: vi.fn().mockResolvedValue(undefined), fetchEmails: vi.fn().mockResolvedValue(undefined),
    fetchQuota: vi.fn().mockResolvedValue(undefined), fetchTagCounts: vi.fn().mockResolvedValue(undefined),
    refreshScheduledMetadata: vi.fn().mockResolvedValue(undefined),
  } as never);
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

const tabsOf = (id: string) => useProTabStore.getState().tabs.filter((tab) => tab.emailData?.emailId === id);

async function openAddress(search?: string) {
  render(<EmbeddedContext.Provider value><MailApp /></EmbeddedContext.Provider>);
  await screen.findByText('message list', {}, { timeout: 5000 });
  await act(async () => {
    setPendingDeepLink('mail', ['message', ID], search);
    await new Promise((resolve) => setTimeout(resolve, 50));
  });
}

describe('an address without a login in the Pro shell, with one login', () => {
  const originalAccounts = useAccountStore.getState().accounts;
  beforeEach(() => {
    useAccountStore.setState({ accounts: [{ id: 'login-a', label: 'a', email: 'a@example.org', username: 'a@example.org', serverUrl: 'https://mail.example', isConnected: true } as never] });
    useProTabStore.setState({ tabs: useProTabStore.getState().tabs.filter((tab) => tab.emailData?.emailId !== ID) });
  });
  afterEach(() => useAccountStore.setState({ accounts: originalAccounts }));

  it('opens the message tab of that login, and refuses nothing', async () => {
    await openAddress();
    expect(tabsOf(ID).map((tab) => tab.emailData)).toEqual([expect.objectContaining({ clientAccountId: 'login-a' })]);
    expect(useToastStore.getState().toasts.filter((toast) => toast.title === 'account_routing.link_names_no_account')).toEqual([]);
  });
});
