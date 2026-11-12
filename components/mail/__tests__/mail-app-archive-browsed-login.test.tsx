import React, { Suspense, lazy } from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Email, Mailbox } from '@/lib/jmap/types';
import { useAuthStore } from '@/stores/auth-store';
import { useEmailStore } from '@/stores/email-store';
import { useSettingsStore } from '@/stores/settings-store';
import { usePluginStore } from '@/stores/plugin-store';
import { useThemeStore } from '@/stores/theme-store';
import { useToastStore } from '@/stores/toast-store';
import { DEFAULT_SEARCH_FILTERS } from '@/lib/jmap/search-utils';
import { clearAllHooks } from '@/lib/plugin-hooks';

// Archive on the open message of another login's folder, browsed in the Pro
// sidebar. The move goes through that login, so its Archive has to be that
// login's too. Stalwart numbers every account's folders alike, and a custom
// folder of one login has the id of another login's Archive: the active
// login's folder list names another folder there.
// Harness of mail-app-source-routing.test.tsx.

vi.mock('next/dynamic', () => ({ default: (load: () => Promise<React.ComponentType<Record<string, unknown>>>) => {
  const Component = lazy(async () => ({ default: await load() }));
  return function Dynamic(props: Record<string, unknown>) {
    return <Suspense fallback={null}><Component {...props} /></Suspense>;
  };
} }));
vi.mock('@/components/email/email-viewer', () => ({
  EmailViewer: ({ onArchive }: { onArchive?: () => void }) => (
    <div><button onClick={() => onArchive?.()}>stub archive</button></div>
  ),
}));
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

function mailbox(id: string, role: string | undefined, accountId: string, name?: string): Mailbox {
  return {
    id, originalId: id, name: name ?? role ?? id, role, accountId, isShared: false,
    sortOrder: 0, totalEmails: 0, unreadEmails: 0, totalThreads: 0, unreadThreads: 0, isSubscribed: true,
  } as Mailbox;
}

// The active login a: own account `cf`, its Archive is `i`.
const aFolders = [mailbox('a', 'inbox', 'cf'), mailbox('b', 'trash', 'cf'), mailbox('i', 'archive', 'cf')];
// Login b: own account `bf`, its Archive is `j`, and its folder `i` is "Payroll".
const bFolders = [mailbox('a', 'inbox', 'bf'), mailbox('b', 'trash', 'bf'), mailbox('i', undefined, 'bf', 'Payroll'), mailbox('j', 'archive', 'bf')];
const bMessage = {
  id: 'eaaaaab', threadId: 'c', subject: 'B payroll', receivedAt: '2026-10-26T10:00:00Z',
  keywords: { $seen: true }, mailboxIds: { a: true },
} as unknown as Email;

let a: Record<string, unknown>;
let b: Record<string, unknown>;
const moveThreadToMailbox = vi.fn();
const moveToMailboxCrossAware = vi.fn();
const fetchAccountMailboxes = vi.fn();

function browse(folders: Mailbox[], selectedMailbox: string) {
  useEmailStore.setState({
    viewingAccountId: 'login-b', accountMailboxes: { 'login-b': folders },
    selectedMailbox, emails: [bMessage], selectedEmail: bMessage,
  } as never);
}

beforeEach(() => {
  vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('Unexpected network request')));
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} });
  usePluginStore.setState({ initializePlugins: vi.fn().mockResolvedValue(undefined) });
  useThemeStore.setState({ syncServerThemes: vi.fn().mockResolvedValue(undefined) });
  useToastStore.setState({ toasts: [] });
  clearAllHooks();
  a = {
    getAccountId: () => 'cf', getUsername: () => 'a@example.org',
    getSieveAccountId: () => null, hasDelayedSend: () => false, getSession: () => null,
    getMailboxes: vi.fn().mockResolvedValue(aFolders), createMailbox: vi.fn(),
  };
  b = {
    getAccountId: () => 'bf', getUsername: () => 'b@example.org',
    getSieveAccountId: () => null, hasDelayedSend: () => false, getSession: () => null,
    getMailboxes: vi.fn().mockResolvedValue(bFolders),
    createMailbox: vi.fn().mockResolvedValue(mailbox('k', 'archive', 'bf')),
  };
  useAuthStore.setState({
    isAuthenticated: true, isLoading: false, client: a as never, activeAccountId: 'login-a', identities: [],
    getClientForAccount: (id: string) => (id === 'login-a' ? a : id === 'login-b' ? b : undefined) as never,
    getAllConnectedClients: () => new Map([['login-a', a], ['login-b', b]]) as never,
  });
  useSettingsStore.setState({ enableUnifiedMailbox: false, mailLayout: 'split', archiveMode: 'single' } as never);
  moveThreadToMailbox.mockReset().mockResolvedValue(true);
  moveToMailboxCrossAware.mockReset().mockResolvedValue(true);
  fetchAccountMailboxes.mockReset().mockImplementation(async (_client: unknown, accountId: string) => {
    if (accountId !== 'login-b') return;
    const state = useEmailStore.getState();
    useEmailStore.setState({ accountMailboxes: { ...state.accountMailboxes, 'login-b': [...(state.accountMailboxes['login-b'] ?? []), mailbox('k', 'archive', 'bf')] } } as never);
  });
  useEmailStore.setState({
    emails: [], selectedEmail: null, selectedMailbox: 'a', selectedKeyword: null, mailboxes: aFolders,
    viewingAccountId: null, accountMailboxes: {}, isUnifiedView: false, unifiedRole: null,
    isScheduledView: false, isLoadingEmail: false, isLoading: false, searchQuery: '',
    searchFilters: { ...DEFAULT_SEARCH_FILTERS }, searchMailboxId: '',
    selectedEmailKeys: new Set(),
    fetchMailboxes: vi.fn().mockResolvedValue(undefined), fetchEmails: vi.fn().mockResolvedValue(undefined),
    fetchQuota: vi.fn().mockResolvedValue(undefined), fetchTagCounts: vi.fn().mockResolvedValue(undefined),
    refreshScheduledMetadata: vi.fn().mockResolvedValue(undefined),
    moveThreadToMailbox, moveToMailboxCrossAware, fetchAccountMailboxes,
  } as never);
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

const destinations = () => moveThreadToMailbox.mock.calls.map((call) => call[2]);

describe('Archive on a message of another login\'s folder browsed in the sidebar', () => {
  it('archives into that login\'s Archive, not its folder with the active login\'s Archive id', async () => {
    browse(bFolders, 'a');
    render(<MailApp />);
    fireEvent.click(await screen.findByText('stub archive', {}, { timeout: 5000 }));
    await waitFor(() => expect(moveThreadToMailbox).toHaveBeenCalled());
    expect(destinations()).toEqual(['j']);
  });

  it('makes a missing Archive through that login, not through the active one', async () => {
    browse(bFolders.filter((folder) => folder.role !== 'archive'), 'a');
    render(<MailApp />);
    fireEvent.click(await screen.findByText('stub archive', {}, { timeout: 5000 }));
    await waitFor(() => expect(moveThreadToMailbox).toHaveBeenCalled());
    expect(b.createMailbox).toHaveBeenCalledWith('Archive', undefined, undefined, expect.objectContaining({ role: 'archive' }));
    expect(a.createMailbox).not.toHaveBeenCalled();
    expect(destinations()).toEqual(['k']);
  });

  it('in that login\'s folder with the id of the active login\'s Archive, archives instead of moving to the Inbox', async () => {
    browse(bFolders, 'i');
    render(<MailApp />);
    fireEvent.click(await screen.findByText('stub archive', {}, { timeout: 5000 }));
    await waitFor(() => expect(moveThreadToMailbox).toHaveBeenCalled());
    expect(destinations()).toEqual(['j']);
    expect(moveToMailboxCrossAware).not.toHaveBeenCalled();
  });

  it('is refused while that login has no client, and says so', async () => {
    browse(bFolders, 'a');
    useAuthStore.setState({ getClientForAccount: (id: string) => (id === 'login-a' ? a : undefined) as never });
    render(<MailApp />);
    fireEvent.click(await screen.findByText('stub archive', {}, { timeout: 5000 }));
    await waitFor(() => expect(useToastStore.getState().toasts.map((toast) => toast.title)).toContain('notifications.error_archiving'));
    expect(moveThreadToMailbox).not.toHaveBeenCalled();
    expect(a.createMailbox).not.toHaveBeenCalled();
  });
});

describe('Archive on a message of the active login\'s own folder', () => {
  it('archives into its own Archive, as before', async () => {
    useEmailStore.setState({ emails: [bMessage], selectedEmail: bMessage } as never);
    render(<MailApp />);
    fireEvent.click(await screen.findByText('stub archive', {}, { timeout: 5000 }));
    await waitFor(() => expect(moveThreadToMailbox).toHaveBeenCalled());
    expect(destinations()).toEqual(['i']);
    expect(moveThreadToMailbox.mock.calls[0][0]).toBe(a);
  });
});
