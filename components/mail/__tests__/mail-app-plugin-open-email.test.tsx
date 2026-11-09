import React, { Suspense, lazy } from 'react';
import { act, render, screen } from '@testing-library/react';
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
import { dispatchApiCall } from '@/lib/plugin-sandbox/host-api';
import { onOpenEmail, resetOpenEmail } from '@/lib/plugin-sandbox/open-email';
import { EmbeddedContext } from '@/hooks/use-is-embedded';
import type { InstalledPlugin } from '@/lib/plugin-types';

// api.ui.openEmail on the mail page: the message opens in the reader as a
// click on a search result entry naming it does, a group account's through
// the login that reads it; one its account does not have is refused.

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

// The active login's folders: its own account `cf` and the group `ce`.
const folders = [mailbox('a', 'inbox', 'cf'), mailbox('a', 'inbox', 'ce', true)];

// The group's Inbox message, as Email/get gives it.
const groupMessage = {
  id: 'eaaaaab', threadId: 'c', subject: 'GRP one', receivedAt: '2026-10-26T10:00:00Z',
  keywords: { $seen: true }, mailboxIds: { a: true }, bodyValues: {},
} as unknown as Email;

let client: Record<string, unknown>;
const plugin = {
  id: 'p1', name: 'Plugin One', version: '1.0.0', author: '', description: '', type: 'hook',
  permissions: ['email:read'], entrypoint: 'index.js', enabled: true, status: 'running', settings: {}, managed: true,
} as InstalledPlugin;

/** The group account has `eaaaaab`, the own account nothing. */
const getEmail = vi.fn(async (id: string, accountId?: string) =>
  id === 'eaaaaab' && accountId === 'ce' ? { ...groupMessage } : null);

beforeEach(() => {
  vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('Unexpected network request')));
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} });
  usePluginStore.setState({ initializePlugins: vi.fn().mockResolvedValue(undefined) });
  useThemeStore.setState({ syncServerThemes: vi.fn().mockResolvedValue(undefined) });
  useToastStore.setState({ toasts: [] });
  clearAllHooks();
  resetOpenEmail();
  getEmail.mockClear();
  client = {
    getAccountId: () => 'cf', getUsername: () => 'a@example.org',
    getSieveAccountId: () => null, hasDelayedSend: () => false, getSession: () => null,
    getMailboxes: vi.fn().mockResolvedValue(folders),
    getEmail,
    getSharedAccounts: () => ['cf', 'ce'].map((id) => ({ id, name: id, isPrimary: id === 'cf', capabilities: { mail: true } })),
  };
  useAuthStore.setState({
    isAuthenticated: true, isLoading: false, client: client as never, activeAccountId: 'login-a', identities: [],
    getClientForAccount: (id: string) => (id === 'login-a' ? client : undefined) as never,
    getAllConnectedClients: () => new Map([['login-a', client]]) as never,
  });
  useSettingsStore.setState({ enableUnifiedMailbox: false, mailLayout: 'split', archiveMode: 'single', deleteAction: 'trash' } as never);
  useEmailStore.setState({
    emails: [], selectedEmail: null, selectedMailbox: 'a', selectedKeyword: null, mailboxes: folders,
    viewingAccountId: null, accountMailboxes: {}, isUnifiedView: false, unifiedRole: null,
    isScheduledView: false, isLoadingEmail: false, isLoading: false, searchQuery: '',
    searchFilters: { ...DEFAULT_SEARCH_FILTERS }, searchMailboxId: '',
    selectedEmailKeys: new Set(),
    fetchMailboxes: vi.fn().mockResolvedValue(undefined), fetchEmails: vi.fn().mockResolvedValue(undefined),
    fetchQuota: vi.fn().mockResolvedValue(undefined), fetchTagCounts: vi.fn().mockResolvedValue(undefined),
    refreshScheduledMetadata: vi.fn().mockResolvedValue(undefined),
  } as never);
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('a plugin opening a message', () => {
  it('opens a group account\'s message in the reader, stamped with its login and account', async () => {
    render(<MailApp />);
    await screen.findByText('message list', {}, { timeout: 5000 });

    await act(async () => {
      await expect(dispatchApiCall(plugin, 'ui.openEmail', [{ id: 'eaaaaab', accountId: 'ce' }])).resolves.toBeUndefined();
    });

    expect(getEmail).toHaveBeenCalledWith('eaaaaab', 'ce');
    expect(useEmailStore.getState().selectedEmail).toMatchObject({ id: 'eaaaaab', sourceClientAccountId: 'login-a', sourceAccountId: 'ce' });
  });

  it('refuses a message the account does not have and leaves the reader as it was', async () => {
    render(<MailApp />);
    await screen.findByText('message list', {}, { timeout: 5000 });

    await act(async () => {
      await expect(dispatchApiCall(plugin, 'ui.openEmail', [{ id: 'nope' }])).rejects.toThrow(/no message "nope"/);
    });

    expect(getEmail).toHaveBeenCalledWith('nope', 'cf');
    expect(useEmailStore.getState().selectedEmail).toBeNull();
  });

  it('leaves it to the Pro shell when it is a hidden tab of it', async () => {
    const shell = vi.fn(async () => 'opened' as const);
    onOpenEmail(shell);
    render(<EmbeddedContext.Provider value><MailApp /></EmbeddedContext.Provider>);
    await screen.findByText('message list', {}, { timeout: 5000 });

    await act(async () => {
      await dispatchApiCall(plugin, 'ui.openEmail', [{ id: 'eaaaaab', accountId: 'ce' }]);
    });

    expect(shell).toHaveBeenCalledWith({ id: 'eaaaaab', sourceClientAccountId: 'login-a', sourceAccountId: 'ce' });
    expect(getEmail).not.toHaveBeenCalled();
    expect(useEmailStore.getState().selectedEmail).toBeNull();
  });
});
