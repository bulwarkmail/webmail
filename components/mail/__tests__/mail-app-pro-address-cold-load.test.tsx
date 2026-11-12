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
import { clearPendingDeepLinks } from '@/lib/deep-link-handoff';

// A message address that names no login, opened in a browser tab while the
// Pro interface is on (a reload, a pasted old link). The route renders the
// standard mail page first, under the Pro shell's takeover, before the
// redirect to the shell. That page must leave the address to the shell, which
// decides about it (nothing while several logins are signed in, the only
// login's message tab with one): it must not read the id through the active
// login, open the message in the reader or mark it read on its own.
//
// Harness of mail-app-pro-address.test.tsx.

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

const entry = (id: string) => ({ id, label: id, email: id, username: id, serverUrl: 'https://mail.example', isConnected: true }) as never;
const originalAccounts = useAccountStore.getState().accounts;

describe('the standard mail page while the Pro shell takes over (cold load of an address)', () => {
  beforeEach(() => {
    useSettingsStore.setState({ proInterface: true } as never);
    useAccountStore.setState({ accounts: [entry('login-a'), entry('login-b')] });
  });
  afterEach(() => useAccountStore.setState({ accounts: originalAccounts }));

  it('does not open a message address that names no login by itself', async () => {
    render(<MailApp linkSegments={['message', ID]} />);
    await screen.findByText('message list', {}, { timeout: 5000 });
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 300)); });
    expect(getEmail).not.toHaveBeenCalled();
    expect(useEmailStore.getState().selectedEmail).toBeNull();
  });

  it('with one login, leaves the address to the shell all the same, which opens that login\'s tab of it', async () => {
    useAccountStore.setState({ accounts: [entry('login-a')] });
    render(<MailApp linkSegments={['message', ID]} />);
    await screen.findByText('message list', {}, { timeout: 5000 });
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 300)); });
    expect(getEmail).not.toHaveBeenCalled();
    expect(useEmailStore.getState().selectedEmail).toBeNull();
  });

  it('control: with the Pro interface off, the same address opens the login’s own message', async () => {
    useSettingsStore.setState({ proInterface: false } as never);
    // The standard layout opens an address without a login for a single login only.
    useAccountStore.setState({ accounts: [entry('login-a')] });
    render(<MailApp linkSegments={['message', ID]} />);
    await screen.findByText('message list', {}, { timeout: 5000 });
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 300)); });
    expect(getEmail).toHaveBeenCalled();
    expect(getEmail.mock.calls[0][0]).toBe(ID);
  });
});
