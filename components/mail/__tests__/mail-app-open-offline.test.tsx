import React, { Suspense, lazy } from 'react';
import { act, fireEvent, render, screen } from '@testing-library/react';
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
import { resetOpenEmail } from '@/lib/plugin-sandbox/open-email';
import type { InstalledPlugin } from '@/lib/plugin-types';

// pass-2 mail-p2-7: in a browser tab that keeps no mail on the device, a click
// on a message while offline left "No conversation selected" and the keys did
// nothing. The reader now says the message needs a connection, with Retry, and
// a key that changes mail says you're offline. The message is opened the way a
// plugin opens one, which goes through the same open as a click.

vi.mock('next/dynamic', () => ({ default: (load: () => Promise<React.ComponentType<Record<string, unknown>>>) => {
  const Component = lazy(async () => ({ default: await load() }));
  return function Dynamic(props: Record<string, unknown>) {
    return <Suspense fallback={null}><Component {...props} /></Suspense>;
  };
} }));
vi.mock('@/components/email/email-viewer', () => ({
  EmailViewer: (props: { email: unknown; emptyPaneContent?: React.ReactNode }) => (props.email ? <div>reader</div> : <div>{props.emptyPaneContent ?? 'empty pane'}</div>),
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
let failing = true;
const getEmail = vi.fn(async (id: string, accountId?: string) => {
  // Offline the real client logs the failure and answers with no message.
  if (failing && navigator.onLine === false) return null;
  if (failing) throw new TypeError('Failed to fetch');
  return id === 'eaaaaab' && accountId === 'ce' ? { ...groupMessage } : null;
});

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

const setOnline = (online: boolean) => {
  Object.defineProperty(navigator, 'onLine', { configurable: true, get: () => online });
  window.dispatchEvent(new Event(online ? 'online' : 'offline'));
};

describe('a message that cannot be fetched', () => {
  afterEach(() => setOnline(true));

  it('says offline that it needs a connection, and Retry opens it once back online', async () => {
    failing = true;
    render(<MailApp />);
    await screen.findByText('message list', {}, { timeout: 5000 });
    act(() => setOnline(false));
    await act(async () => {
      await dispatchApiCall(plugin, 'ui.openEmail', [{ id: 'eaaaaab', accountId: 'ce' }]).catch(() => {});
    });
    expect(await screen.findByText('reader_offline')).toBeTruthy();

    failing = false;
    act(() => setOnline(true));
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'retry' }));
      await new Promise((r) => setTimeout(r, 20));
    });
    expect(await screen.findByText('reader')).toBeTruthy();
    expect(screen.queryByText('reader_offline')).toBeNull();
  });

  it('says it could not be loaded when online', async () => {
    failing = true;
    render(<MailApp />);
    await screen.findByText('message list', {}, { timeout: 5000 });
    await act(async () => {
      await dispatchApiCall(plugin, 'ui.openEmail', [{ id: 'eaaaaab', accountId: 'ce' }]).catch(() => {});
    });
    expect(await screen.findByText('reader_failed')).toBeTruthy();
  });

  it('answers a key that changes mail with a note that it is offline', async () => {
    render(<MailApp />);
    await screen.findByText('message list', {}, { timeout: 5000 });
    act(() => setOnline(false));
    failing = true;
    await act(async () => {
      await dispatchApiCall(plugin, 'ui.openEmail', [{ id: 'eaaaaab', accountId: 'ce' }]).catch(() => {});
    });
    await screen.findByText('reader_offline');
    // No Archive folder here: Delete stands in for every key that changes mail.
    fireEvent.keyDown(document.body, { key: '#', code: 'Digit3', shiftKey: true });
    expect(useToastStore.getState().toasts.map((toast) => toast.title)).toContain('action_offline');
  });
});
