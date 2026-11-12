import React, { Suspense, lazy } from 'react';
import { act, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Mailbox } from '@/lib/jmap/types';
import { useAuthStore } from '@/stores/auth-store';
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

// More addresses that reach the Pro mail surface through the handoff (a
// reload, a pasted address) than mail-app-pro-address.test.tsx names, with
// its harness. The rule: an address that names no login opens nothing and
// reads nothing through the active login, whose ids name other messages and
// conversations. A conversation address is such an address too: thread ids
// repeat across accounts and logins exactly as message ids do.
//
// Belongs in components/mail/__tests__/.

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
const THREAD = 'c';
const own = { id: ID, threadId: THREAD, subject: 'OWN private note', receivedAt: '2026-11-11T10:00:00Z', keywords: {}, mailboxIds: { a: true }, from: [{ email: 'sam@example.org' }], to: [{ email: 'a@example.org' }] };
let getEmail: ReturnType<typeof vi.fn>;
let getThreadEmails: ReturnType<typeof vi.fn>;

beforeEach(() => {
  vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('Unexpected network request')));
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} });
  usePluginStore.setState({ initializePlugins: vi.fn().mockResolvedValue(undefined) });
  useThemeStore.setState({ syncServerThemes: vi.fn().mockResolvedValue(undefined) });
  useToastStore.setState({ toasts: [] });
  clearAllHooks();
  clearPendingDeepLinks();
  getEmail = vi.fn().mockResolvedValue(own);
  getThreadEmails = vi.fn().mockResolvedValue([own]);
  const client = {
    getAccountId: () => 'cf', getUsername: () => 'a@example.org',
    getSieveAccountId: () => null, hasDelayedSend: () => false, getSession: () => null,
    getMailboxes: vi.fn().mockResolvedValue(folders), getEmail,
    getThreadEmails,
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

async function openAddress(segments: string[], search?: string, waitMs = 300) {
  render(<EmbeddedContext.Provider value><MailApp /></EmbeddedContext.Provider>);
  await screen.findByText('message list', {}, { timeout: 5000 });
  await act(async () => {
    setPendingDeepLink('mail', segments, search);
    await new Promise((resolve) => setTimeout(resolve, waitMs));
  });
}

describe('addresses of the Pro shell that name no login', () => {
  beforeEach(() => {
    useProTabStore.setState({ tabs: useProTabStore.getState().tabs.filter((tab) => tab.emailData?.emailId !== ID) });
  });

  it('a conversation address opens nothing and reads nothing through the active login', async () => {
    await openAddress(['thread', THREAD]);
    expect(getThreadEmails).not.toHaveBeenCalled();
    expect(getEmail).not.toHaveBeenCalled();
    expect(useEmailStore.getState().selectedEmail).toBeNull();
    expect(tabsOf(ID)).toEqual([]);
  });

  it('a conversation address that names its login is read through that login', async () => {
    await openAddress(['thread', THREAD], '?account=login-a');
    expect(getThreadEmails).toHaveBeenCalledWith(THREAD, undefined);
  });

  it('a message address that names an owner account but no login opens nothing', async () => {
    await openAddress(['message', ID], '?owner=ce');
    expect(tabsOf(ID)).toEqual([]);
    expect(getEmail).not.toHaveBeenCalled();
    expect(useToastStore.getState().toasts.length).toBeGreaterThan(0);
  });

  it('the address form from before paths (?email=) opens nothing', async () => {
    await openAddress([], '?email=' + ID);
    expect(tabsOf(ID)).toEqual([]);
    expect(getEmail).not.toHaveBeenCalled();
  });
});
