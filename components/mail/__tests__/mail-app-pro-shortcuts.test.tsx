import React from 'react';
import { render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Mailbox } from '@/lib/jmap/types';
import { useAuthStore } from '@/stores/auth-store';
import { useEmailStore } from '@/stores/email-store';
import { useSettingsStore } from '@/stores/settings-store';
import { usePluginStore } from '@/stores/plugin-store';
import { useThemeStore } from '@/stores/theme-store';
import { DEFAULT_SEARCH_FILTERS } from '@/lib/jmap/search-utils';
import { EmbeddedContext } from '@/hooks/use-is-embedded';
import { ProTabFocusContext } from '@/hooks/use-pane-context';
import { useProTabStore, type ProTabKind } from '@/stores/pro-tab-store';

// Under Pro the mail page stays mounted behind other tabs. Its shortcuts acted
// from there: e on the Calendar tab archived the mail selected in the hidden
// list.

type ShortcutOptions = { enabled?: boolean; handlers: Record<string, unknown> };
const shortcuts = vi.hoisted(() => ({ calls: [] as ShortcutOptions[] }));
vi.mock('@/hooks/use-keyboard-shortcuts', () => ({
  useKeyboardShortcuts: (options: ShortcutOptions) => { shortcuts.calls.push(options); },
}));

vi.mock('@/components/layout/mv-top-bar', () => ({ MvTopBar: () => null }));
vi.mock('@/components/layout/sidebar', () => ({ Sidebar: () => null }));
vi.mock('@/components/email/email-composer', () => ({ EmailComposer: () => null }));
vi.mock('@/components/search/mv-search-form', () => ({ MvSearchForm: () => null }));
vi.mock('@/components/email/email-viewer', () => ({ EmailViewer: () => null }));
vi.mock('@/components/layout/navigation-rail', () => ({ NavigationRail: () => null }));
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
vi.mock('@/hooks/use-media-query', () => ({
  useDeviceDetection: () => ({ isMobile: false, isTablet: false, isDesktop: true }),
  useMediaQuery: () => false,
  useIsDesktop: () => true,
  atLeast: (px: number) => `(width >= ${px}px)`,
}));
vi.mock('@/lib/push-bindings', () => ({ reconcilePushBindings: () => {}, releasePushBindings: () => {} }));
vi.mock('@/components/email/email-list', () => ({ EmailList: () => null }));

const { MailApp } = await import('../mail-app');

const inbox = { id: 'inbox', name: 'Inbox', role: 'inbox', totalEmails: 0, unreadEmails: 0 } as Mailbox;

beforeEach(() => {
  shortcuts.calls = [];
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
  useSettingsStore.setState({ enableUnifiedMailbox: false } as never);
  useEmailStore.setState({
    emails: [], selectedEmail: null, selectedMailbox: 'inbox', selectedKeyword: null, mailboxes: [inbox],
    viewingAccountId: null, accountMailboxes: {}, isUnifiedView: false, unifiedRole: null,
    isScheduledView: false, isLoadingEmail: false, isLoading: false, searchQuery: '',
    searchFilters: { ...DEFAULT_SEARCH_FILTERS }, searchMailboxId: '', isAdvancedSearchOpen: false,
    selectedEmailKeys: new Set(), unreadSection: null,
    fetchMailboxes: vi.fn().mockResolvedValue(undefined), fetchEmails: vi.fn().mockResolvedValue(undefined),
    fetchQuota: vi.fn().mockResolvedValue(undefined), fetchTagCounts: vi.fn().mockResolvedValue(undefined),
    refreshScheduledMetadata: vi.fn().mockResolvedValue(undefined),
  } as never);
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

/** The enabled hook calls of the last render: MailApp makes two per render. */
function activeShortcuts() {
  return shortcuts.calls.slice(-2).filter((c) => c.enabled);
}

function renderPro(focused: boolean) {
  render(
    <EmbeddedContext.Provider value={true}>
      <ProTabFocusContext.Provider value={focused}>
        <MailApp />
      </ProTabFocusContext.Provider>
    </EmbeddedContext.Provider>,
  );
}

function withTabInFront(kind: ProTabKind) {
  useProTabStore.setState({
    tabs: [
      { id: 'home-mail', kind: 'mail', labelKey: 'mail', closeable: false, paneId: 'main' },
      { id: 'front', kind, labelKey: kind, closeable: true, paneId: 'main' },
    ],
    activeTabId: 'front', activeSplitTabId: null, focusedPaneId: 'main',
  } as never);
}

describe('mail shortcuts under the Pro shell', () => {
  it.each(['files', 'settings', 'contacts', 'folder', 'search', 'email', 'compose'] as ProTabKind[])(
    'leaves the help and a new message on while a %s tab is in front, and nothing that acts on mail',
    (kind) => {
      withTabInFront(kind);
      renderPro(false);
      const active = activeShortcuts();
      expect(active).toHaveLength(1);
      expect(Object.keys(active[0].handlers).sort()).toEqual(['onCompose', 'onShowHelp']);
    },
  );

  it('leaves c to the Calendar tab, whose c is New event', () => {
    withTabInFront('calendar');
    renderPro(false);
    const active = activeShortcuts();
    expect(active).toHaveLength(1);
    expect(Object.keys(active[0].handlers)).toEqual(['onShowHelp']);
  });

  it('goes by the pane in focus when the Calendar tab is in the other one', () => {
    withTabInFront('calendar');
    useProTabStore.setState({
      tabs: [
        { id: 'home-mail', kind: 'mail', labelKey: 'mail', closeable: false, paneId: 'main' },
        { id: 'front', kind: 'calendar', labelKey: 'calendar', closeable: true, paneId: 'main' },
        { id: 'files', kind: 'files', labelKey: 'files', closeable: true, paneId: 'split' },
      ],
      activeSplitTabId: 'files', focusedPaneId: 'split',
    } as never);
    renderPro(false);
    expect(activeShortcuts()[0].handlers.onCompose).toBeTypeOf('function');
  });

  it('has the mail shortcuts on while the mail tab is in front', () => {
    renderPro(true);
    const active = activeShortcuts();
    expect(active).toHaveLength(1);
    expect(active[0].handlers.onArchive).toBeTypeOf('function');
    expect(active[0].handlers.onDelete).toBeTypeOf('function');
  });

  it('has them on in the standard shell, where there are no tabs', () => {
    render(<MailApp />);
    const active = activeShortcuts();
    expect(active).toHaveLength(1);
    expect(active[0].handlers.onArchive).toBeTypeOf('function');
  });
});
