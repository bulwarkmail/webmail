import React from 'react';
import { act, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Mailbox } from '@/lib/jmap/types';
import { useAuthStore } from '@/stores/auth-store';
import { useEmailStore } from '@/stores/email-store';
import { useSettingsStore } from '@/stores/settings-store';
import { usePluginStore } from '@/stores/plugin-store';
import { useThemeStore } from '@/stores/theme-store';
import { DEFAULT_SEARCH_FILTERS } from '@/lib/jmap/search-utils';
import { resetActions, setPluginActions } from '@/lib/plugin-sandbox/actions';

// The standard layout has no global top bar: its search row sits on top of
// the message list. Plugin top-bar buttons go there, after refresh.

const device = vi.hoisted(() => ({ isMobile: false }));

vi.mock('@/components/layout/sidebar', () => ({ Sidebar: () => null }));
vi.mock('@/components/layout/navigation-rail', () => ({ NavigationRail: () => null }));
vi.mock('@/components/layout/calendar-event-notification-toaster', () => ({ CalendarEventNotificationToaster: () => null }));
vi.mock('@/components/layout/share-notification-toaster', () => ({ ShareNotificationToaster: () => null }));
vi.mock('@/components/layout/mobile-header', () => ({ MobileHeader: () => null }));
vi.mock('@/components/email/message-list-tabs', () => ({ useMessageListPanelProps: (id: string) => ({ id }), MessageListTabs: () => null }));
vi.mock('@/components/search/search-box', () => ({ SearchBox: () => <input data-testid="search" /> }));
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
  useDeviceDetection: () => ({ isMobile: device.isMobile, isTablet: false, isDesktop: !device.isMobile }),
  useMediaQuery: () => false,
  useIsDesktop: () => !device.isMobile,
  useIsMobile: () => device.isMobile,
}));
vi.mock('@/lib/push-bindings', () => ({ reconcilePushBindings: () => {}, releasePushBindings: () => {} }));
vi.mock('@/components/email/email-list', () => ({ EmailList: () => <div>message list</div> }));

const { MailApp } = await import('../mail-app');

const inbox = { id: 'inbox', name: 'Inbox', role: 'inbox' } as Mailbox;

beforeEach(() => {
  resetActions();
  vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('Unexpected network request')));
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} });
  usePluginStore.setState({ initializePlugins: vi.fn().mockResolvedValue(undefined) });
  useThemeStore.setState({ syncServerThemes: vi.fn().mockResolvedValue(undefined) });
  const client = {
    getAccountId: () => 'acc', getUsername: () => 'me@example.com',
    getSieveAccountId: () => null, hasDelayedSend: () => false, getSession: () => null,
  };
  useAuthStore.setState({
    isAuthenticated: true, isLoading: false, client: client as never, activeAccountId: 'login', identities: [],
    getClientForAccount: () => client as never,
    getAllConnectedClients: () => new Map([['login', client]]) as never,
  });
  useSettingsStore.setState({ enableUnifiedMailbox: false, mailLayout: 'split', interfaceLayout: 'default' } as never);
  useEmailStore.setState({
    emails: [], selectedEmail: null, selectedMailbox: inbox.id, mailboxes: [inbox],
    viewingAccountId: null, accountMailboxes: {}, isUnifiedView: false, unifiedRole: null,
    isScheduledView: false, isLoadingEmail: false, isLoading: false, searchQuery: '',
    searchFilters: { ...DEFAULT_SEARCH_FILTERS }, searchMailboxId: '', selectedKeyword: null,
    selectedEmailKeys: new Set(),
    fetchMailboxes: vi.fn().mockResolvedValue(undefined), fetchEmails: vi.fn().mockResolvedValue(undefined),
    fetchQuota: vi.fn().mockResolvedValue(undefined), fetchTagCounts: vi.fn().mockResolvedValue(undefined),
    refreshScheduledMetadata: vi.fn().mockResolvedValue(undefined),
  } as never);
});
afterEach(() => {
  device.isMobile = false;
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('top-bar-actions in the standard layout', () => {
  it('draws nothing in the search row without plugins', () => {
    const { container } = render(<MailApp />);
    expect(screen.getByTestId('search')).toBeInTheDocument();
    expect(container.querySelector('[data-plugin-actions="top-bar-actions"]')).toBeNull();
  });

  it('puts plugin buttons in the search row after the folder menu', () => {
    act(() => setPluginActions('tr', 'Translator', 'top-bar-actions', [{ id: 'go', label: 'Translate' }]));
    const { container } = render(<MailApp />);

    const group = container.querySelector('[data-plugin-actions="top-bar-actions"]')!;
    expect(group).not.toBeNull();
    const folderMenu = screen.getByTestId('mail-folder-menu');
    expect(group.parentElement).toBe(folderMenu.parentElement);
    expect(folderMenu.compareDocumentPosition(group) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Translate' })).toBeInTheDocument();
  });

  it('leaves them to the header menu on phones', () => {
    device.isMobile = true;
    act(() => setPluginActions('tr', 'Translator', 'top-bar-actions', [{ id: 'go', label: 'Translate' }]));
    const { container } = render(<MailApp />);
    expect(container.querySelector('[data-plugin-actions="top-bar-actions"]')).toBeNull();
  });
});

describe('command palette commands on the mail page', () => {
  it('takes compose from the palette and opens the composer', async () => {
    const { requestAppCommand } = await import('@/lib/app-commands');
    render(<MailApp />);
    let taken = false;
    act(() => { taken = requestAppCommand('compose'); });
    expect(taken).toBe(true);
  });

  it('runs a search parked before the page was ready', async () => {
    const { parkAppCommand, peekParkedAppCommand } = await import('@/lib/app-commands');
    parkAppCommand('search');
    render(<MailApp />);
    expect(peekParkedAppCommand()).toBeNull();
  });
});

describe('code warm-up once signed in', () => {
  it('fetches the viewer and editor code when the browser is idle after the first rows', async () => {
    const idle = vi.fn(() => 1);
    vi.stubGlobal('requestIdleCallback', idle);
    vi.stubGlobal('cancelIdleCallback', vi.fn());
    vi.stubGlobal('requestAnimationFrame', (run: FrameRequestCallback) => { run(0); return 1; });
    vi.stubGlobal('cancelAnimationFrame', vi.fn());
    const { unmount } = render(<MailApp />);
    await act(async () => {});
    // The wait for the list is idle time too: the viewer's code doesn't take it.
    expect(idle).not.toHaveBeenCalled();
    act(() => { useEmailStore.setState({ emails: [{ id: 'm1', threadId: 't1', keywords: {}, mailboxIds: { inbox: true } }] } as never); });
    await act(async () => {});
    expect(idle).toHaveBeenCalled();
    unmount();
  });
});

describe('advanced search folder select', () => {
  it('names system folders in the user language, as the sidebar does (#1429)', () => {
    const projects = { id: 'projects', name: 'Projects', role: null } as unknown as Mailbox;
    useEmailStore.setState({ mailboxes: [inbox, projects], isAdvancedSearchOpen: true } as never);
    render(<MailApp />);

    const options = Array.from(document.querySelectorAll('option')).map((o) => o.textContent);
    expect(options).toContain('sidebar.mailboxes.inbox');
    expect(options).toContain('Projects');
    expect(options).not.toContain('Inbox');
  });
});
