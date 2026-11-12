import React, { Suspense, lazy } from 'react';
import { act, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Mailbox } from '@/lib/jmap/types';
import { useAccountStore } from '@/stores/account-store';
import { useAuthStore } from '@/stores/auth-store';
import { useEmailStore } from '@/stores/email-store';
import { useSettingsStore } from '@/stores/settings-store';
import { usePluginStore } from '@/stores/plugin-store';
import { useThemeStore } from '@/stores/theme-store';
import { useToastStore } from '@/stores/toast-store';
import { DEFAULT_SEARCH_FILTERS } from '@/lib/jmap/search-utils';
import { clearAllHooks } from '@/lib/plugin-hooks';
import { clearPendingDeepLinks } from '@/lib/deep-link-handoff';

// The standard layout and an address that names no login (a reload on an
// address written before addresses named one, a pasted old link). With one
// login signed in it is that login's, as before. With several it opens
// nothing and reads nothing: through the active login the id can be another
// message or conversation. An address that names its login opens as usual.
//
// Harness of mail-app-pro-address-cold-load.test.tsx.

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

function mailbox(id: string, role: string | undefined, accountId: string): Mailbox {
  return {
    id, originalId: id, name: role ?? id, role, accountId, isShared: false,
    sortOrder: 0, totalEmails: 0, unreadEmails: 0, totalThreads: 0, unreadThreads: 0, isSubscribed: true,
  } as Mailbox;
}
const folders = [mailbox('a', 'inbox', 'cf')];
const ID = 'eaaaaab';
const THREAD = 'c';
const own = { id: ID, threadId: THREAD, subject: 'OWN private note', receivedAt: '2026-11-11T10:00:00Z', keywords: {}, mailboxIds: { a: true }, from: [{ email: 'sam@example.org' }], to: [{ email: 'a@example.org' }] };
const entry = (id: string) => ({ id, label: id, email: id, username: id, serverUrl: 'https://mail.example', isConnected: true }) as never;
let getEmail: ReturnType<typeof vi.fn>;
let getThreadEmails: ReturnType<typeof vi.fn>;
const originalAccounts = useAccountStore.getState().accounts;

beforeEach(() => {
  vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('Unexpected network request')));
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} });
  usePluginStore.setState({ initializePlugins: vi.fn().mockResolvedValue(undefined) });
  useThemeStore.setState({ syncServerThemes: vi.fn().mockResolvedValue(undefined) });
  useToastStore.setState({ toasts: [] });
  clearAllHooks();
  clearPendingDeepLinks();
  window.history.replaceState(null, '', '/');
  getEmail = vi.fn().mockResolvedValue(own);
  getThreadEmails = vi.fn().mockResolvedValue([own]);
  const client = {
    getAccountId: () => 'cf', getUsername: () => 'a@example.org',
    getSieveAccountId: () => null, hasDelayedSend: () => false, getSession: () => null,
    getMailboxes: vi.fn().mockResolvedValue(folders), getEmail, getThreadEmails,
    getSharedAccounts: () => [{ id: 'cf', name: 'cf', isPrimary: true, capabilities: { mail: true } }],
  };
  const other = { ...client, getAccountId: () => 'bf', getEmail: vi.fn(), getThreadEmails: vi.fn() };
  useAuthStore.setState({
    isAuthenticated: true, isLoading: false, client: client as never, activeAccountId: 'login-a', identities: [],
    getClientForAccount: (id: string) => (id === 'login-a' ? client : id === 'login-b' ? other : undefined) as never,
    getAllConnectedClients: () => new Map([['login-a', client], ['login-b', other]]) as never,
  });
  useAccountStore.setState({ accounts: [entry('login-a'), entry('login-b')] });
  useSettingsStore.setState({ enableUnifiedMailbox: false, mailLayout: 'split', proInterface: false } as never);
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
  useAccountStore.setState({ accounts: originalAccounts });
  window.history.replaceState(null, '', '/');
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

async function load(segments: string[], search = '') {
  window.history.replaceState(null, '', `/mail/${segments.join('/')}${search}`);
  render(<MailApp linkSegments={segments} />);
  await screen.findByText('message list', {}, { timeout: 5000 });
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 300)); });
}
const refusals = () => useToastStore.getState().toasts.filter((toast) => toast.title === 'account_routing.link_names_no_account');

describe('an address in the standard layout while two logins are signed in', () => {
  it('opens no message when it names no login, and says why', async () => {
    await load(['message', ID]);
    expect(getEmail).not.toHaveBeenCalled();
    expect(useEmailStore.getState().selectedEmail).toBeNull();
    expect(refusals()).toHaveLength(1);
  });

  it('opens no conversation when it names no login', async () => {
    await load(['thread', THREAD]);
    expect(getThreadEmails).not.toHaveBeenCalled();
    expect(getEmail).not.toHaveBeenCalled();
    expect(useEmailStore.getState().selectedEmail).toBeNull();
    expect(refusals()).toHaveLength(1);
  });

  it('opens the message of the login it names', async () => {
    await load(['message', ID], '?account=login-a');
    expect(getEmail).toHaveBeenCalled();
    expect(getEmail.mock.calls[0][0]).toBe(ID);
    expect(refusals()).toHaveLength(0);
  });

  it('still opens a folder address, which names no message', async () => {
    await load(['folder', 'inbox']);
    expect(refusals()).toHaveLength(0);
  });
});

describe('an address in the standard layout with one login signed in', () => {
  beforeEach(() => {
    useAccountStore.setState({ accounts: [entry('login-a')] });
  });

  it('opens that login\'s message from an address that names no login, as before', async () => {
    await load(['message', ID]);
    expect(getEmail).toHaveBeenCalled();
    expect(getEmail.mock.calls[0][0]).toBe(ID);
    expect(refusals()).toHaveLength(0);
  });

  it('opens that login\'s conversation from an address that names no login, as before', async () => {
    await load(['thread', THREAD]);
    expect(getThreadEmails).toHaveBeenCalledWith(THREAD, undefined);
    expect(refusals()).toHaveLength(0);
  });
});
