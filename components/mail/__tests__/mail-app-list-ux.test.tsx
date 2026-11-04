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

// The empty reading pane beside the list holds the first-run tips (mail-15)
// and, with messages selected, the selection's count and buttons (mail-10).
// The New folder dialogs are titled without the menu item's "…" (mail-29).

const device = vi.hoisted(() => ({ current: { isMobile: false, isCompact: false, isDesktop: true } }));
const listProps = vi.hoisted(() => ({ host: undefined as HTMLElement | null | undefined }));

vi.mock('@/hooks/use-media-query', () => ({
  useDeviceDetection: () => device.current,
  useMediaQuery: () => false,
  useIsDesktop: () => !device.current.isMobile,
}));
vi.mock('@/components/layout/navigation-rail', () => ({ NavigationRail: () => null }));
vi.mock('@/components/layout/sidebar', () => ({
  Sidebar: ({ onCreateFolder, onCreateSubfolder }: { onCreateFolder: () => void; onCreateSubfolder: (id: string) => void }) => (
    <>
      <button onClick={() => onCreateFolder()}>stub new folder</button>
      <button onClick={() => onCreateSubfolder('inbox')}>stub new subfolder</button>
    </>
  ),
}));
vi.mock('@/components/email/email-composer', () => ({ EmailComposer: () => null }));
vi.mock('@/components/ui/welcome-banner', () => ({
  WelcomeBanner: ({ variant = 'list' }: { variant?: string }) => <div data-testid={`welcome-${variant}`} />,
  useWelcomeBannerDue: () => false,
}));
vi.mock('@/components/email/email-viewer', () => ({
  EmailViewer: ({ email, emptyPaneContent, emptyPaneFooter }: { email?: { id: string } | null; emptyPaneContent?: React.ReactNode; emptyPaneFooter?: React.ReactNode }) => (
    <div data-testid="viewer">{email ? <p>reading {email.id}</p> : <>{emptyPaneContent ?? <p>no conversation selected</p>}{emptyPaneFooter}</>}</div>
  ),
}));
vi.mock('@/components/email/email-list', () => ({
  EmailList: ({ selectionPaneHost }: { selectionPaneHost?: HTMLElement | null }) => {
    listProps.host = selectionPaneHost;
    return <div>message list</div>;
  },
}));
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

const { MailApp } = await import('../mail-app');

const inbox = { id: 'inbox', name: 'Inbox', role: 'inbox', totalEmails: 1, unreadEmails: 0 } as Mailbox;
const message = { id: 'm1', threadId: 't-m1', subject: 'm1', receivedAt: '2026-10-31T10:00:00Z', keywords: { $seen: true }, mailboxIds: { inbox: true } } as unknown as Email;

beforeEach(() => {
  device.current = { isMobile: false, isCompact: false, isDesktop: true };
  listProps.host = undefined;
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
  useUIStore.setState({ activeView: 'list', sidebarOpen: false });
  useEmailStore.setState({
    emails: [message], selectedEmail: null, selectedMailbox: 'inbox', selectedKeyword: null, mailboxes: [inbox],
    viewingAccountId: null, accountMailboxes: {}, isUnifiedView: false, unifiedRole: null,
    isScheduledView: false, isLoadingEmail: false, isLoading: false, searchQuery: '',
    searchFilters: { ...DEFAULT_SEARCH_FILTERS }, searchMailboxId: '', isAdvancedSearchOpen: false,
    selectedEmailKeys: new Set(), unreadSection: null, listRows: null,
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

describe('the first-run tips', () => {
  it('sit in the empty reading pane beside the list, not above the list', async () => {
    render(<MailApp />);
    expect((await screen.findByTestId('viewer', {}, { timeout: 5000 })).querySelector('[data-testid="welcome-pane"]')).not.toBeNull();
    expect(screen.queryByTestId('welcome-list')).toBeNull();
  });

  it('stay above the list where no reading pane shows beside it', () => {
    useSettingsStore.setState({ mailLayout: 'focus' } as never);
    render(<MailApp />);
    expect(screen.getByTestId('welcome-list')).toBeTruthy();
    expect(screen.queryByTestId('welcome-pane')).toBeNull();
  });

  it('stay above the list on a phone', () => {
    device.current = { isMobile: true, isCompact: false, isDesktop: false };
    render(<MailApp />);
    expect(screen.getByTestId('welcome-list')).toBeTruthy();
    expect(screen.queryByTestId('welcome-pane')).toBeNull();
  });
});

describe('the reading pane for a selection', () => {
  it('hands the list a slot in the empty reading pane', () => {
    useEmailStore.setState({ selectedEmailKeys: new Set(['m1']) } as never);
    render(<MailApp />);
    expect(screen.queryByText('no conversation selected')).toBeNull();
    expect(listProps.host).toBeInstanceOf(HTMLElement);
    expect(screen.getByTestId('viewer').contains(listProps.host!)).toBe(true);
  });

  it('replaces the open message once other rows are ticked too (mail-p2-3)', () => {
    useEmailStore.setState({ selectedEmail: message, selectedEmailKeys: new Set(['m1', 'm2']) } as never);
    render(<MailApp />);
    expect(screen.queryByText('reading m1')).toBeNull();
    expect(listProps.host).toBeInstanceOf(HTMLElement);
    expect(screen.getByTestId('viewer').contains(listProps.host!)).toBe(true);
  });

  it('replaces the open message when another single row is ticked', () => {
    useEmailStore.setState({ selectedEmail: message, selectedEmailKeys: new Set(['m2']) } as never);
    render(<MailApp />);
    expect(screen.queryByText('reading m1')).toBeNull();
  });

  it('keeps the open message when only its own row is ticked', () => {
    useEmailStore.setState({ selectedEmail: message, selectedEmailKeys: new Set(['m1']) } as never);
    render(<MailApp />);
    expect(screen.getByText('reading m1')).toBeTruthy();
  });

  it('keeps the open message when its conversation row is ticked', () => {
    useEmailStore.setState({
      selectedEmail: message, selectedEmailKeys: new Set(['m1', 'm1-reply']),
      listRows: [{ key: 'm1', members: ['m1', 'm1-reply'] }, { key: 'm2', members: ['m2'] }],
    } as never);
    render(<MailApp />);
    expect(screen.getByText('reading m1')).toBeTruthy();
  });

  it('says nothing is selected without a selection', () => {
    render(<MailApp />);
    expect(screen.getByText('no conversation selected')).toBeTruthy();
    expect(listProps.host ?? null).toBeNull();
  });
});

describe('the new folder dialogs', () => {
  it.each([
    ['stub new folder', 'mail_list_extra.new_folder_title'],
    ['stub new subfolder', 'mail_list_extra.new_subfolder_title'],
  ])('%s is titled without the menu item’s ellipsis', async (button, title) => {
    render(<MailApp />);
    fireEvent.click(await screen.findByText(button, {}, { timeout: 5000 }));
    expect(await screen.findByText(title)).toBeTruthy();
  });
});
