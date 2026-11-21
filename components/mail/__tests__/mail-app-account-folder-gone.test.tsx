import React, { Suspense, lazy } from 'react';
import { act, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Mailbox } from '@/lib/jmap/types';
import { useAuthStore } from '@/stores/auth-store';
import { useEmailStore } from '@/stores/email-store';
import { useSettingsStore } from '@/stores/settings-store';
import { usePluginStore } from '@/stores/plugin-store';
import { useThemeStore } from '@/stores/theme-store';
import { useToastStore } from '@/stores/toast-store';
import { DEFAULT_SEARCH_FILTERS } from '@/lib/jmap/search-utils';
import { clearAllHooks } from '@/lib/plugin-hooks';

// A folder under another login's heading in the Pro sidebar opens through that
// login only. While it has no client the folder does not open: through the
// active login the same folder id is the active login's own folder.

vi.mock('next/dynamic', () => ({ default: (load: () => Promise<React.ComponentType<Record<string, unknown>>>) => {
  const Component = lazy(async () => ({ default: await load() }));
  return function Dynamic(props: Record<string, unknown>) {
    return <Suspense fallback={null}><Component {...props} /></Suspense>;
  };
} }));
const sidebar = vi.hoisted(() => ({ props: null as Record<string, unknown> | null }));
vi.mock('@/components/email/email-viewer', () => ({ EmailViewer: () => <div>reader</div> }));
vi.mock('@/components/email/email-composer', () => ({ EmailComposer: () => null }));
vi.mock('@/components/layout/sidebar', () => ({
  Sidebar: (props: Record<string, unknown>) => {
    sidebar.props = props;
    return null;
  },
}));
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

const own = [mailbox('a', 'inbox', 'ee'), mailbox('b', 'trash', 'ee')];
let fetchEmails: ReturnType<typeof vi.fn>;
let client: Record<string, unknown>;
let other: Record<string, unknown> | undefined;

beforeEach(() => {
  vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('Unexpected network request')));
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} });
  usePluginStore.setState({ initializePlugins: vi.fn().mockResolvedValue(undefined) });
  useThemeStore.setState({ syncServerThemes: vi.fn().mockResolvedValue(undefined) });
  useToastStore.setState({ toasts: [] });
  clearAllHooks();
  sidebar.props = null;
  other = undefined;
  client = {
    getAccountId: () => 'ee', getUsername: () => 'a@example.org',
    getSieveAccountId: () => null, hasDelayedSend: () => false, getSession: () => null,
    getMailboxes: vi.fn().mockResolvedValue(own),
    getEmail: vi.fn().mockResolvedValue(null),
    getSharedAccounts: () => [],
  };
  useAuthStore.setState({
    isAuthenticated: true, isLoading: false, client: client as never, activeAccountId: 'login-a', identities: [],
    getClientForAccount: (id: string) => (id === 'login-a' ? client : id === 'login-b' ? other : undefined) as never,
    getAllConnectedClients: () => new Map([['login-a', client], ...(other ? [['login-b', other] as const] : [])]) as never,
  });
  useSettingsStore.setState({ enableUnifiedMailbox: false, mailLayout: 'split', archiveMode: 'single', deleteAction: 'trash' } as never);
  fetchEmails = vi.fn().mockResolvedValue(undefined);
  useEmailStore.setState({
    emails: [], selectedEmail: null, selectedMailbox: 'a', selectedKeyword: null, mailboxes: own,
    viewingAccountId: null, accountMailboxes: { 'login-b': [mailbox('a', 'inbox', 'ef'), mailbox('b', 'trash', 'ef')] },
    isUnifiedView: false, unifiedRole: null,
    isScheduledView: false, isLoadingEmail: false, isLoading: false, searchQuery: '',
    searchFilters: { ...DEFAULT_SEARCH_FILTERS }, searchMailboxId: '',
    selectedEmailKeys: new Set(),
    fetchMailboxes: vi.fn().mockResolvedValue(undefined), fetchEmails,
    fetchQuota: vi.fn().mockResolvedValue(undefined), fetchTagCounts: vi.fn().mockResolvedValue(undefined),
    refreshScheduledMetadata: vi.fn().mockResolvedValue(undefined),
  } as never);
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

async function selectAccountFolder(login: string, mailboxId: string) {
  render(<MailApp />);
  await screen.findByText('message list', {}, { timeout: 5000 });
  fetchEmails.mockClear();
  const select = sidebar.props?.onAccountMailboxSelect as (login: string | null, mailboxId: string) => Promise<void>;
  expect(select).toBeTypeOf('function');
  await act(async () => { await select(login, mailboxId); });
}

describe('a folder under the heading of a login without a client', () => {
  it('does not open, and the active login is not asked for its folder with the same id', async () => {
    await selectAccountFolder('login-b', 'a');
    expect(useEmailStore.getState().viewingAccountId).toBeNull();
    expect(fetchEmails).not.toHaveBeenCalled();
    expect(useToastStore.getState().toasts.some((toast) => toast.type === 'error')).toBe(true);
  });

  it('opens through that login once it has a client', async () => {
    other = { ...client, getAccountId: () => 'ef', getUsername: () => 'b@example.org' };
    await selectAccountFolder('login-b', 'a');
    expect(useEmailStore.getState().viewingAccountId).toBe('login-b');
    expect(fetchEmails).toHaveBeenCalledWith(other, 'a');
  });
});
