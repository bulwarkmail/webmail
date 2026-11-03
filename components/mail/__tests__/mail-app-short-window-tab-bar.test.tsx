import React from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Email, Mailbox } from '@/lib/jmap/types';
import { useAuthStore } from '@/stores/auth-store';
import { useEmailStore } from '@/stores/email-store';
import { useSettingsStore } from '@/stores/settings-store';
import { usePluginStore } from '@/stores/plugin-store';
import { useThemeStore } from '@/stores/theme-store';
import { useUIStore } from '@/stores/ui-store';
import { DEFAULT_SEARCH_FILTERS } from '@/lib/jmap/search-utils';

// A phone on its side: the bottom bar takes a sixth of the window, so it goes
// over what fills the window. It stays wherever the list shows, or there is no
// way left to the other apps.

const device = vi.hoisted(() => ({ current: { isMobile: false, isTablet: true, isDesktop: false }, short: true }));

vi.mock('@/hooks/use-media-query', () => ({
  useDeviceDetection: () => device.current,
  useMediaQuery: (query: string) => query.includes('max-height') && device.short,
  useIsDesktop: () => false,
}));
vi.mock('@/components/layout/navigation-rail', () => ({ NavigationRail: () => <nav>tab bar</nav> }));
vi.mock('@/components/layout/sidebar', () => ({
  Sidebar: ({ onCompose }: { onCompose: () => void }) => <button onClick={onCompose}>stub compose</button>,
}));
vi.mock('@/components/email/email-composer', () => ({ EmailComposer: () => <p>stub composer</p> }));
vi.mock('@/components/email/email-viewer', () => ({ EmailViewer: () => <div>message viewer</div> }));
vi.mock('@/components/layout/mv-top-bar', () => ({ MvTopBar: () => null }));
vi.mock('@/components/search/mv-search-form', () => ({ MvSearchForm: () => null }));
vi.mock('@/components/layout/calendar-event-notification-toaster', () => ({ CalendarEventNotificationToaster: () => null }));
vi.mock('@/components/layout/share-notification-toaster', () => ({ ShareNotificationToaster: () => null }));
vi.mock('@/components/layout/mobile-header', () => ({ MobileHeader: () => null }));
vi.mock('@/components/layout/mv-side-panel', () => ({ MvSidePanel: () => null }));
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
vi.mock('@/lib/push-bindings', () => ({ reconcilePushBindings: () => {}, releasePushBindings: () => {} }));
vi.mock('@/components/email/email-list', () => ({ EmailList: () => <div>message list</div> }));

const { MailApp } = await import('../mail-app');

const inbox = { id: 'inbox', name: 'Inbox', role: 'inbox', totalEmails: 1, unreadEmails: 0 } as Mailbox;
const message = { id: 'm1', threadId: 't-m1', subject: 'm1', receivedAt: '2026-10-31T10:00:00Z', keywords: { $seen: true }, mailboxIds: { inbox: true } } as unknown as Email;

beforeEach(() => {
  device.current = { isMobile: false, isTablet: true, isDesktop: false };
  device.short = true;
  vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('Unexpected network request')));
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} });
  usePluginStore.setState({ initializePlugins: vi.fn().mockResolvedValue(undefined) });
  useThemeStore.setState({ syncServerThemes: vi.fn().mockResolvedValue(undefined) });
  const client = {
    getAccountId: () => 'acc', getUsername: () => 'a@example.org',
    getSieveAccountId: () => null, hasDelayedSend: () => false, getSession: () => null,
  };
  useAuthStore.setState({
    isAuthenticated: true, isLoading: false, client: client as never, activeAccountId: 'login-a', identities: [],
    getClientForAccount: () => client as never,
    getAllConnectedClients: () => new Map([['login-a', client]]) as never,
  });
  useSettingsStore.setState({ enableUnifiedMailbox: false, interfaceLayout: 'default', mailLayout: 'split' } as never);
  useUIStore.setState({ activeView: 'list', tabletListVisible: true, sidebarOpen: false });
  useEmailStore.setState({
    emails: [message], selectedEmail: null, selectedMailbox: 'inbox', selectedKeyword: null, mailboxes: [inbox],
    viewingAccountId: null, accountMailboxes: {}, isUnifiedView: false, unifiedRole: null,
    isScheduledView: false, isLoadingEmail: false, isLoading: false, searchQuery: '',
    searchFilters: { ...DEFAULT_SEARCH_FILTERS }, searchMailboxId: '', isAdvancedSearchOpen: false,
    selectedEmailKeys: new Set(), unreadSection: null,
    fetchMailboxes: vi.fn().mockResolvedValue(undefined), fetchEmails: vi.fn().mockResolvedValue(undefined),
    fetchQuota: vi.fn().mockResolvedValue(undefined), fetchTagCounts: vi.fn().mockResolvedValue(undefined),
    refreshScheduledMetadata: vi.fn().mockResolvedValue(undefined),
    fetchEmailContent: vi.fn().mockResolvedValue(undefined),
    markAsRead: vi.fn().mockResolvedValue(undefined),
  } as never);
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

const tabBar = () => screen.queryByText('tab bar');

describe('the bottom bar in a short window', () => {
  it('stays with the list beside an open message', () => {
    useEmailStore.setState({ selectedEmail: message } as never);
    render(<MailApp />);
    expect(tabBar()).not.toBeNull();
  });

  it('goes when the message fills the window', () => {
    useUIStore.setState({ tabletListVisible: false });
    useEmailStore.setState({ selectedEmail: message } as never);
    render(<MailApp />);
    expect(tabBar()).toBeNull();
  });

  it('goes over a composer, and comes back without one', async () => {
    render(<MailApp />);
    expect(tabBar()).not.toBeNull();
    fireEvent.click(screen.getByText('stub compose'));
    await screen.findByText('stub composer', {}, { timeout: 5000 });
    expect(tabBar()).toBeNull();
  });

  it('stays in a tall window whatever is open', () => {
    device.short = false;
    useUIStore.setState({ tabletListVisible: false });
    useEmailStore.setState({ selectedEmail: message } as never);
    render(<MailApp />);
    expect(tabBar()).not.toBeNull();
  });

  it('stays on a phone\'s list with a message kept selected behind it', () => {
    device.current = { isMobile: true, isTablet: false, isDesktop: false };
    useEmailStore.setState({ selectedEmail: message } as never);
    render(<MailApp />);
    expect(tabBar()).not.toBeNull();
  });
});
