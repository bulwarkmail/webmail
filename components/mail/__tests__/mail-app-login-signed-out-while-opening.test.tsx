import React, { Suspense, lazy } from 'react';
import { act, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Email, Mailbox } from '@/lib/jmap/types';
import { forgetAccountRows } from '@/lib/account-state-manager';
import { useAuthStore } from '@/stores/auth-store';
import { useEmailStore } from '@/stores/email-store';
import { useSettingsStore } from '@/stores/settings-store';
import { usePluginStore } from '@/stores/plugin-store';
import { useThemeStore } from '@/stores/theme-store';
import { useToastStore } from '@/stores/toast-store';
import { DEFAULT_SEARCH_FILTERS } from '@/lib/jmap/search-utils';
import { clearAllHooks } from '@/lib/plugin-hooks';

// Login B's folder is open in the Pro sidebar and one of its messages is in
// the reader. The user opens a message of login B; while it loads, login B is
// signed out (its server refused its credentials for a minute, and this
// request was the one that settled it). The list moves to the active login's
// Inbox. The reader must not go back to login B's message: message ids repeat
// across logins, so every action on it would now reach the active login's
// message with that id.

vi.mock('next/dynamic', () => ({ default: (load: () => Promise<React.ComponentType<Record<string, unknown>>>) => {
  const Component = lazy(async () => ({ default: await load() }));
  return function Dynamic(props: Record<string, unknown>) {
    return <Suspense fallback={null}><Component {...props} /></Suspense>;
  };
} }));
const sidebar = vi.hoisted(() => ({ props: null as Record<string, unknown> | null }));
const reader = vi.hoisted(() => ({ props: null as Record<string, unknown> | null }));
vi.mock('@/components/email/email-viewer', () => ({
  EmailViewer: (props: Record<string, unknown>) => {
    reader.props = props;
    return <div>reader</div>;
  },
}));
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
const list = vi.hoisted(() => ({ props: null as Record<string, unknown> | null }));
vi.mock('@/components/email/email-list', () => ({
  EmailList: (props: Record<string, unknown>) => {
    list.props = props;
    return <div>message list</div>;
  },
}));

const { MailApp } = await import('../mail-app');

function mailbox(id: string, role: string | undefined, accountId: string): Mailbox {
  return {
    id, originalId: id, name: role ?? id, role, accountId, isShared: false,
    sortOrder: 0, totalEmails: 0, unreadEmails: 0, totalThreads: 0, unreadThreads: 0, isSubscribed: true,
  } as Mailbox;
}

const own = [mailbox('a', 'inbox', 'ee'), mailbox('b', 'trash', 'ee')];
const theirs = [mailbox('a', 'inbox', 'ef'), mailbox('b', 'trash', 'ef')];
const ID = 'eaaaaab';
const message = (subject: string): Email => ({
  id: ID, threadId: `t-${subject}`, subject, receivedAt: '2026-11-11T10:00:00Z', keywords: { $seen: true }, mailboxIds: { a: true },
  from: [{ email: 'sam@example.org' }], to: [{ email: 'me@example.org' }],
  bodyValues: { '1': { value: subject } }, textBody: [{ partId: '1', type: 'text/plain' }], htmlBody: [{ partId: '1', type: 'text/plain' }],
  attachments: [], size: 10,
} as unknown as Email);

function makeClient(account: string, extra: Record<string, unknown> = {}) {
  const ok = () => vi.fn().mockResolvedValue(undefined);
  return {
    getAccountId: () => account, getUsername: () => `${account}@example.org`, getServerUrl: () => `https://${account}.example.org`,
    getSieveAccountId: () => null, hasDelayedSend: () => false, getSession: () => null, getSharedAccounts: () => [],
    getMailboxes: vi.fn().mockResolvedValue(account === 'ee' ? own : theirs),
    getEmails: vi.fn().mockResolvedValue({ emails: [message('A note')], hasMore: false, total: 1 }),
    getEmail: vi.fn().mockResolvedValue(null),
    getThreadEmails: vi.fn().mockResolvedValue([]), getThread: vi.fn().mockResolvedValue(null),
    moveToTrash: ok(), deleteEmail: ok(), toggleStar: ok(), markAsRead: ok(), moveEmail: ok(), batchUpdateKeywords: ok(),
    ...extra,
  };
}

let active: ReturnType<typeof makeClient>;
let other: ReturnType<typeof makeClient> | undefined;
let release: (value: Email | null) => void;

beforeEach(() => {
  vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('Unexpected network request')));
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} });
  vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  usePluginStore.setState({ initializePlugins: vi.fn().mockResolvedValue(undefined) });
  useThemeStore.setState({ syncServerThemes: vi.fn().mockResolvedValue(undefined) });
  useToastStore.setState({ toasts: [] });
  clearAllHooks();
  list.props = null;
  reader.props = null;
  active = makeClient('ee');
  // Login B's message does not come back until the test lets it.
  other = makeClient('ef', { getEmail: vi.fn(() => new Promise<Email | null>((resolve) => { release = resolve; })) });
  useAuthStore.setState({
    isAuthenticated: true, isLoading: false, client: active as never, activeAccountId: 'login-a', identities: [],
    getClientForAccount: (id: string) => (id === 'login-a' ? active : id === 'login-b' ? other : undefined) as never,
    getAllConnectedClients: () => new Map<string, unknown>([['login-a', active], ...(other ? [['login-b', other] as [string, unknown]] : [])]) as never,
  });
  useSettingsStore.setState({ enableUnifiedMailbox: false, mailLayout: 'split', archiveMode: 'single', deleteAction: 'trash', markAsReadDelay: -1 } as never);
  const open = message('B payroll');
  useEmailStore.setState({
    // Login B's Inbox in the Pro sidebar, its message in the reader.
    emails: [open], selectedEmail: open, selectedMailbox: 'a', selectedKeyword: null, mailboxes: own,
    viewingAccountId: 'login-b', accountMailboxes: { 'login-b': theirs },
    isUnifiedView: false, unifiedRole: null,
    isScheduledView: false, isLoadingEmail: false, isLoading: false, searchQuery: '',
    searchFilters: { ...DEFAULT_SEARCH_FILTERS }, searchMailboxId: '',
    selectedEmailKeys: new Set(), processingReadStatus: new Set(), threadEmailsCache: new Map(), expandedThreadIds: new Set(),
    fetchMailboxes: vi.fn().mockResolvedValue(undefined),
    fetchQuota: vi.fn().mockResolvedValue(undefined), fetchTagCounts: vi.fn().mockResolvedValue(undefined),
    refreshScheduledMetadata: vi.fn().mockResolvedValue(undefined),
  } as never);
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

/** The user clicks login B's row; while it loads, login B is signed out as removeAccount does it. */
async function signedOutWhileOpening() {
  render(<MailApp />);
  await screen.findByText('message list', {}, { timeout: 5000 });
  const select = list.props?.onEmailSelect as (email: Email) => void;
  expect(select).toBeTypeOf('function');
  const row = useEmailStore.getState().emails[0];
  await act(async () => { select(row); await Promise.resolve(); });
  await act(async () => {
    other = undefined;
    forgetAccountRows('login-b', active as never);
    // The active login's Inbox arrives: its first message has the same id.
    await new Promise((resolve) => setTimeout(resolve, 20));
    useEmailStore.setState({ emails: [message('A note')] } as never);
    await new Promise((resolve) => setTimeout(resolve, 20));
  });
  // The request of the login that is gone ends without a message.
  await act(async () => { release(null); await new Promise((resolve) => setTimeout(resolve, 50)); });
}

const writesOf = (client: ReturnType<typeof makeClient>) => (['moveToTrash', 'deleteEmail', 'toggleStar', 'markAsRead', 'moveEmail', 'batchUpdateKeywords'] as const)
  .filter((name) => (client[name] as ReturnType<typeof vi.fn>).mock.calls.length > 0);

describe('a login signed out while one of its messages is opening', () => {
  it('leaves none of its messages in the reader', async () => {
    await signedOutWhileOpening();
    expect(useEmailStore.getState().viewingAccountId).toBeNull();
    expect(useEmailStore.getState().selectedEmail?.subject ?? null).not.toBe('B payroll');
  });

  it('Star and Delete in the reader afterwards do not reach the active login\'s message with the same id', async () => {
    await signedOutWhileOpening();
    const props = reader.props as { onToggleStar?: () => unknown; onDelete?: () => unknown } | null;
    await act(async () => {
      try { await props?.onToggleStar?.(); } catch { /* refusing is fine */ }
      try { await props?.onDelete?.(); } catch { /* refusing is fine */ }
      await new Promise((resolve) => setTimeout(resolve, 50));
    });
    expect(writesOf(active)).toEqual([]);
  });
});
