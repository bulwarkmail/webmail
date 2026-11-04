import React from 'react';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Email, Mailbox } from '@/lib/jmap/types';
import { useAuthStore } from '@/stores/auth-store';
import { useEmailStore } from '@/stores/email-store';
import { useSettingsStore } from '@/stores/settings-store';
import { usePluginStore } from '@/stores/plugin-store';
import { useThemeStore } from '@/stores/theme-store';
import { useUIStore } from '@/stores/ui-store';
import { DEFAULT_SEARCH_FILTERS } from '@/lib/jmap/search-utils';

// The folder list over the page (the folded column's drawer on a compact
// desktop, the phone's drawer) dims the page behind it, and the phone's keeps
// the focus until it closes and then hands it back to the menu button. The
// folded column's drawer opened beside the app rail with nothing dimming the
// list (usability report 2026-11-04, screenshots at 525 and 587 px).

const device = vi.hoisted(() => ({
  current: { isMobile: false, isCompact: true, isDesktop: true },
  drawerChange: null as null | ((close: (() => void) | null) => void),
}));

vi.mock('@/hooks/use-media-query', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/hooks/use-media-query')>()),
  useDeviceDetection: () => device.current,
  useMediaQuery: () => false,
  useIsDesktop: () => device.current.isDesktop,
  useIsMobile: () => device.current.isMobile,
}));
vi.mock('@/hooks/use-split-panes-fit', () => ({ useSplitPanesFit: () => true }));
vi.mock('@/components/layout/navigation-rail', () => ({
  NavigationRail: ({ orientation = 'vertical' }: { orientation?: string }) => <nav data-rail={orientation}>rail</nav>,
}));
vi.mock('@/components/layout/sidebar', () => ({
  Sidebar: ({ onDrawerChange }: { onDrawerChange?: (close: (() => void) | null) => void }) => {
    device.drawerChange = onDrawerChange ?? null;
    return <div><button type="button">first folder</button><button type="button">last folder</button></div>;
  },
}));
vi.mock('@/components/layout/mobile-header', async () => {
  const { useUIStore: store } = await import('@/stores/ui-store');
  return {
    MobileHeader: () => (
      <button type="button" data-sidebar-toggle="" onClick={() => store.getState().setSidebarOpen(true)}>menu</button>
    ),
  };
});
vi.mock('@/components/email/email-composer', () => ({ EmailComposer: () => <p>stub composer</p> }));
vi.mock('@/components/email/email-viewer', () => ({ EmailViewer: () => <div>message viewer</div> }));
vi.mock('@/components/layout/mv-top-bar', () => ({ MvTopBar: () => null }));
vi.mock('@/components/search/mv-search-form', () => ({ MvSearchForm: () => null }));
vi.mock('@/components/layout/calendar-event-notification-toaster', () => ({ CalendarEventNotificationToaster: () => null }));
vi.mock('@/components/layout/share-notification-toaster', () => ({ ShareNotificationToaster: () => null }));
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
const phone = { isMobile: true, isCompact: false, isDesktop: false };

beforeEach(() => {
  device.current = compact;
  device.drawerChange = null;
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

const scrim = () => screen.queryByTestId('folder-drawer-scrim');
/** The element holding the folder sidebar (the one with its id). */
const folders = () => screen.getByText('first folder').closest<HTMLElement>('[id]')!;

describe('the compact desktop\'s folder drawer', () => {
  it('dims the whole page while the folded column\'s drawer is open', () => {
    render(<MailApp />);
    expect(scrim()).toBeNull();
    const close = vi.fn();
    act(() => device.drawerChange!(close));
    const classes = scrim()!.className.split(/\s+/);
    expect(classes).toEqual(expect.arrayContaining(['fixed', 'inset-0']));
    // Not the phone's scrim, which the desktop breakpoint hides.
    expect(classes).not.toContain('desk:hidden');
    fireEvent.click(scrim()!);
    expect(close).toHaveBeenCalledTimes(1);
    act(() => device.drawerChange!(null));
    expect(scrim()).toBeNull();
  });

  it('leaves the drawer the window to be placed in, not the folder column', () => {
    render(<MailApp />);
    const classes = folders().className.split(/\s+/);
    // A translate, even translate-x-0, makes the column the drawer's
    // containing block, and the drawer opened beside the app rail.
    expect(classes).toContain('desk:translate-none');
    expect(classes.some((c) => /^desk:-?translate-x-/.test(c))).toBe(false);
  });
});

describe('the phone\'s folder drawer', () => {
  beforeEach(() => {
    device.current = phone;
    useUIStore.setState({ isMobile: true, isCompact: false, isDesktop: false });
  });

  it('keeps Tab inside and gives the focus back to the menu button on Escape', () => {
    render(<MailApp />);
    const toggle = screen.getByText('menu');
    toggle.focus();
    fireEvent.click(toggle);
    const first = screen.getByText('first folder');
    const last = screen.getByText('last folder');
    expect(document.activeElement).toBe(first);
    last.focus();
    fireEvent.keyDown(last, { key: 'Tab' });
    expect(document.activeElement).toBe(first);
    fireEvent.keyDown(first, { key: 'Escape' });
    expect(useUIStore.getState().sidebarOpen).toBe(false);
    expect(document.activeElement).toBe(toggle);
  });

  it('starts under the top bar and the window\'s controls', () => {
    render(<MailApp />);
    const classes = folders().className.split(/\s+/);
    expect(classes).toEqual(expect.arrayContaining(['max-desk:fixed', 'max-desk:start-0', 'max-desk:top-[var(--drawer-top)]', 'max-desk:bottom-0']));
  });
});
