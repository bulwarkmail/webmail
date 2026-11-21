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

// Back and Forward, and the address bar, in the standard layout. A history
// entry names the login it was taken in: its folder and message ids are
// other things in any other login, so an entry of another login than the one
// on screen brings back no folder and no message. The address of an open
// message names its login while several logins are signed in, as a reload
// opens nothing from one that names none then.
//
// Harness of mail-app-address-several-logins.test.tsx, with the real history hook.

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


async function mount() {
  render(<MailApp />);
  await screen.findByText('message list', {}, { timeout: 5000 });
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 50)); });
}

/** Back or Forward to an entry the history hook wrote earlier. */
async function goTo(entry: Record<string, unknown>) {
  await act(async () => {
    window.dispatchEvent(new PopStateEvent('popstate', {
      state: { __mailNav: { mailboxId: 'a', emailId: null, threadId: null, composerOpen: false, sidebarOpen: false, navId: 99, ...entry } },
    }));
    await new Promise((resolve) => setTimeout(resolve, 100));
  });
}

describe('Back to a history entry in the standard layout', () => {
  it('of another login than the one on screen opens no message of the active login', async () => {
    await mount();
    await goTo({ emailId: ID, emailKey: ID, login: 'login-b' });
    expect(getEmail).not.toHaveBeenCalled();
    expect(useEmailStore.getState().selectedEmail).toBeNull();
  });

  it('of another login does not move the list to the active login\'s folder with that id either', async () => {
    const fetchEmails = useEmailStore.getState().fetchEmails as ReturnType<typeof vi.fn>;
    useEmailStore.setState({ selectedMailbox: 'other-folder' } as never);
    await mount();
    fetchEmails.mockClear();
    await goTo({ mailboxId: 'a', login: 'login-b' });
    expect(useEmailStore.getState().selectedMailbox).toBe('other-folder');
    expect(fetchEmails).not.toHaveBeenCalled();
  });

  it('of the login on screen opens its message again', async () => {
    await mount();
    await goTo({ emailId: ID, emailKey: ID, login: 'login-a' });
    expect(getEmail).toHaveBeenCalled();
    expect(getEmail.mock.calls[0][0]).toBe(ID);
  });

  it('that names no login opens nothing while two logins are signed in', async () => {
    await mount();
    await goTo({ emailId: ID });
    expect(getEmail).not.toHaveBeenCalled();
    expect(useEmailStore.getState().selectedEmail).toBeNull();
  });

  it('that names no login opens the only login\'s message, as before', async () => {
    useAccountStore.setState({ accounts: [entry('login-a')] });
    await mount();
    await goTo({ emailId: ID });
    expect(getEmail).toHaveBeenCalled();
    expect(getEmail.mock.calls[0][0]).toBe(ID);
  });
});

describe('the address of an open message in the standard layout', () => {
  const open = async () => {
    useEmailStore.setState({ emails: [own], selectedEmail: own } as never);
    await mount();
  };

  it('names its login while two logins are signed in', async () => {
    await open();
    expect(window.location.pathname).toBe(`/mail/message/${ID}`);
    expect(new URLSearchParams(window.location.search).get('account')).toBe('login-a');
  });

  it('stays without a login for a single login', async () => {
    useAccountStore.setState({ accounts: [entry('login-a')] });
    await open();
    expect(window.location.pathname).toBe(`/mail/message/${ID}`);
    expect(window.location.search).toBe('');
  });

  it('writes history entries that name the login they were taken in', async () => {
    await open();
    expect((window.history.state as { __mailNav?: { login?: string; emailKey?: string } }).__mailNav).toMatchObject({ emailId: ID, emailKey: ID, login: 'login-a' });
  });
});
