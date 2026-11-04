import React from 'react';
import { render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Email, Mailbox } from '@/lib/jmap/types';
import { useAuthStore } from '@/stores/auth-store';
import { useEmailStore } from '@/stores/email-store';
import { useSettingsStore } from '@/stores/settings-store';
import { usePluginStore } from '@/stores/plugin-store';
import { useThemeStore } from '@/stores/theme-store';
import { useUIStore } from '@/stores/ui-store';
import { DEFAULT_SEARCH_FILTERS } from '@/lib/jmap/search-utils';

// A window between the phone and the full desktop (a half-screen window, a
// laptop at 150 %) is a compact desktop: the app rail at the side, the folder
// sidebar folded to its icons, and no phone tab bar (usability test
// 2026-11-04, mail-28 and settings-16).

const device = vi.hoisted(() => ({
  current: { isMobile: false, isCompact: true, isDesktop: true },
  splitFits: true,
}));

vi.mock('@/hooks/use-media-query', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/hooks/use-media-query')>()),
  useDeviceDetection: () => device.current,
  useMediaQuery: () => false,
  useIsDesktop: () => device.current.isDesktop,
  useIsMobile: () => device.current.isMobile,
}));
vi.mock('@/hooks/use-split-panes-fit', () => ({ useSplitPanesFit: () => device.splitFits }));
vi.mock('@/components/layout/navigation-rail', () => ({
  NavigationRail: ({ orientation = 'vertical' }: { orientation?: string }) => <nav data-rail={orientation}>rail</nav>,
}));
vi.mock('@/components/layout/sidebar', () => ({
  Sidebar: () => <button>stub folders</button>,
}));
vi.mock('@/components/email/email-composer', () => ({ EmailComposer: () => <p>stub composer</p> }));
vi.mock('@/components/email/email-viewer', () => ({ EmailViewer: () => <div>message viewer</div> }));
vi.mock('@/components/layout/mv-top-bar', () => ({ MvTopBar: () => null }));
vi.mock('@/components/search/mv-search-form', () => ({ MvSearchForm: () => null }));
vi.mock('@/components/layout/calendar-event-notification-toaster', () => ({ CalendarEventNotificationToaster: () => null }));
vi.mock('@/components/layout/share-notification-toaster', () => ({ ShareNotificationToaster: () => null }));
vi.mock('@/components/layout/mobile-header', () => ({ MobileHeader: () => null }));
vi.mock('@/components/layout/mv-side-panel', () => ({ MvSidePanel: () => null }));
vi.mock('@/components/plugins/plugin-side-panels', () => ({ PluginSidePanel: () => null }));
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

const compact = { isMobile: false, isCompact: true, isDesktop: true };
const full = { isMobile: false, isCompact: false, isDesktop: true };
const phone = { isMobile: true, isCompact: false, isDesktop: false };

beforeEach(() => {
  device.current = compact;
  device.splitFits = true;
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
  useSettingsStore.setState({ enableUnifiedMailbox: false, interfaceLayout: 'default', mailLayout: 'split', simpleMode: false } as never);
  useUIStore.setState({
    activeView: 'list', sidebarOpen: false, sidebarWidth: 256,
    sidebarCollapsed: false, compactSidebarExpanded: false,
    isMobile: false, isCompact: true, isDesktop: true,
  });
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

/** The element holding the folder sidebar (the one with its width). */
const folders = () => screen.getByText('stub folders').closest<HTMLElement>('[id]')!;
const rails = () => Array.from(document.querySelectorAll<HTMLElement>('[data-rail]')).map((el) => el.dataset.rail);
const listPane = (c: HTMLElement) => c.querySelector<HTMLElement>('section[aria-labelledby]')!;

describe('the compact desktop', () => {
  it('has the app rail at the side and no phone tab bar', () => {
    render(<MailApp />);
    expect(rails()).toEqual(['vertical']);
  });

  it('folds the folder sidebar to its icons, in the flow', () => {
    render(<MailApp />);
    expect(folders().style.width).toBe('48px');
    expect(folders().hasAttribute('inert')).toBe(false);
  });

  it('opens the folders at their width when asked, without touching the full desktop choice', () => {
    useUIStore.getState().toggleSidebarCollapsed();
    render(<MailApp />);
    expect(folders().style.width).toBe('256px');
    expect(useUIStore.getState().sidebarCollapsed).toBe(false);
  });

  it('opens a message in the list\'s place when the window is too narrow for both', () => {
    device.splitFits = false;
    useEmailStore.setState({ selectedEmail: message } as never);
    const { container } = render(<MailApp />);
    expect(listPane(container).hasAttribute('inert')).toBe(true);
  });

  it('keeps the list beside the message where both fit', () => {
    useEmailStore.setState({ selectedEmail: message } as never);
    const { container } = render(<MailApp />);
    expect(listPane(container).hasAttribute('inert')).toBe(false);
  });
});

describe('the full desktop', () => {
  it('keeps the folders at their width', () => {
    device.current = full;
    useUIStore.setState({ isCompact: false });
    render(<MailApp />);
    expect(folders().style.width).toBe('256px');
    expect(rails()).toEqual(['vertical']);
  });
});

describe('the phone', () => {
  it('keeps the tab bar and the folders in a closed drawer', () => {
    device.current = phone;
    useUIStore.setState({ isMobile: true, isCompact: false, isDesktop: false });
    render(<MailApp />);
    expect(rails()).toEqual(['horizontal']);
    expect(folders().hasAttribute('inert')).toBe(true);
  });
});
