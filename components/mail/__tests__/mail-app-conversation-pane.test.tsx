import React, { Suspense, lazy } from 'react';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
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
import { forgetEmailPrefetches } from '@/lib/email-prefetch';

// The default layout's reading pane shows the open message's conversation, on
// every layout but a phone's, and j / k go on from the last message opened.

vi.mock('next/dynamic', () => ({ default: (load: () => Promise<React.ComponentType<Record<string, unknown>>>) => {
  const Component = lazy(async () => ({ default: await load() }));
  return function Dynamic(props: Record<string, unknown>) {
    return <Suspense fallback={null}><Component {...props} /></Suspense>;
  };
} }));
type ViewerProps = { mvConversation?: { id: string }[]; conversationPane?: boolean };
vi.mock('@/components/email/email-viewer', () => ({
  EmailViewer: ({ mvConversation, conversationPane }: ViewerProps) => (
    <div data-testid="reader" data-pane={conversationPane ? 'conversation' : 'message'}>
      {mvConversation ? mvConversation.map((e) => e.id).join(',') : 'no conversation'}
    </div>
  ),
}));
vi.mock('@/components/email/email-composer', () => ({ EmailComposer: () => null }));
vi.mock('@/components/layout/sidebar', () => ({ Sidebar: () => null }));
vi.mock('@/components/layout/navigation-rail', () => ({ NavigationRail: () => null }));
vi.mock('@/components/layout/calendar-event-notification-toaster', () => ({ CalendarEventNotificationToaster: () => null }));
vi.mock('@/components/layout/share-notification-toaster', () => ({ ShareNotificationToaster: () => null }));
vi.mock('@/components/layout/mobile-header', () => ({ MobileHeader: () => null }));
vi.mock('@/components/layout/mv-top-bar', () => ({ MvTopBar: () => null }));
vi.mock('@/components/layout/mv-side-panel', () => ({ MvSidePanel: () => null }));
vi.mock('@/components/email/message-list-tabs', () => ({ useMessageListPanelProps: (id: string) => ({ id }), MessageListTabs: () => null }));
vi.mock('@/components/search/search-box', () => ({ SearchBox: () => <input aria-label="stub search field" data-search-input /> }));
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

function mailbox(id: string, role: string): Mailbox {
  return {
    id, name: role, role, sortOrder: 0, totalEmails: 3, unreadEmails: 0, totalThreads: 3, unreadThreads: 0, isSubscribed: true,
  } as Mailbox;
}
const folders = [
  mailbox('inbox', 'inbox'), mailbox('archive', 'archive'), mailbox('trash', 'trash'),
  mailbox('junk', 'junk'), mailbox('work', ''),
];
const row = (id: string, minute: number, mailboxIds: Record<string, boolean> = { inbox: true }) => ({
  id, threadId: `t-${id}`, subject: id, receivedAt: new Date(Date.UTC(2026, 9, 31, 10, minute)).toISOString(),
  keywords: { $seen: true }, mailboxIds,
}) as unknown as Email;
const inbox = () => [row('m1', 30), row('m2', 20), row('m3', 10)];

let client: Record<string, ReturnType<typeof vi.fn> | (() => unknown)>;
let fetchEmailContent: ReturnType<typeof vi.fn>;
// Every message the store had open, in order.
let opened: (string | null)[];
let unsubscribe: () => void;

beforeEach(() => {
  vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('Unexpected network request')));
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} });
  usePluginStore.setState({ initializePlugins: vi.fn().mockResolvedValue(undefined) });
  useThemeStore.setState({ syncServerThemes: vi.fn().mockResolvedValue(undefined) });
  useToastStore.setState({ toasts: [] });
  clearAllHooks();
  forgetEmailPrefetches();
  client = {
    getAccountId: () => 'acc', getUsername: () => 'a@example.org',
    getSieveAccountId: () => null, hasDelayedSend: () => false, getSession: () => null,
    getMailboxes: vi.fn().mockResolvedValue(folders),
    getThread: vi.fn(async (threadId: string) => ({ id: threadId, emailIds: [threadId.slice(2)] })),
    getEmail: vi.fn(async (id: string) => ({ ...inbox().find((e) => e.id === id)!, bodyValues: {} })),
    moveEmail: vi.fn().mockResolvedValue(undefined),
    moveToTrash: vi.fn().mockResolvedValue(undefined),
    markAsRead: vi.fn().mockResolvedValue(undefined),
    markAsSpam: vi.fn().mockResolvedValue(undefined),
    undoSpam: vi.fn().mockResolvedValue(undefined),
    removeEmailsFromMailbox: vi.fn().mockResolvedValue(undefined),
  };
  useAuthStore.setState({
    isAuthenticated: true, isLoading: false, client: client as never, activeAccountId: 'login-a', identities: [],
    getClientForAccount: (id: string) => (id === 'login-a' ? client : undefined) as never,
    getAllConnectedClients: () => new Map([['login-a', client]]) as never,
  });
  useSettingsStore.setState({
    enableUnifiedMailbox: false, interfaceLayout: 'default', mailLayout: 'focus', archiveMode: 'single',
    deleteAction: 'trash', returnToListAfterAction: true, confirmArchive: false, confirmDelete: false,
    singleKeyShortcuts: true,
  } as never);
  fetchEmailContent = vi.fn().mockResolvedValue(undefined);
  const emails = inbox();
  useEmailStore.setState({
    emails, selectedEmail: emails[0], selectedMailbox: 'inbox', selectedKeyword: null, mailboxes: folders,
    viewingAccountId: null, accountMailboxes: {}, isUnifiedView: false, unifiedRole: null,
    isScheduledView: false, isLoadingEmail: false, isLoading: false, searchQuery: '',
    searchFilters: { ...DEFAULT_SEARCH_FILTERS }, searchMailboxId: '',
    selectedEmailKeys: new Set(), unreadSection: null,
    fetchMailboxes: vi.fn().mockResolvedValue(undefined), fetchEmails: vi.fn().mockResolvedValue(undefined),
    fetchQuota: vi.fn().mockResolvedValue(undefined), fetchTagCounts: vi.fn().mockResolvedValue(undefined),
    refreshScheduledMetadata: vi.fn().mockResolvedValue(undefined),
    fetchEmailContent,
  } as never);
  opened = [];
  unsubscribe = useEmailStore.subscribe((state, prev) => {
    if (state.selectedEmail !== prev.selectedEmail) opened.push(state.selectedEmail?.id ?? null);
  });
});
afterEach(() => {
  unsubscribe();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

const selectedId = () => useEmailStore.getState().selectedEmail?.id ?? null;
const press = (key: string) => act(() => { fireEvent.keyDown(window, { key }); });

describe('The reading pane in the default layout', () => {
  beforeEach(() => {
    useSettingsStore.setState({ interfaceLayout: 'default', mailLayout: 'split', disableThreading: false } as never);
    client.getThread = vi.fn(async (threadId: string) => ({
      id: threadId, emailIds: threadId === 't-m1' ? ['m0', 'm1'] : [threadId.slice(2)],
    }));
    client.getSomeEmails = vi.fn(async (ids: string[]) => ids.map((id) => (id === 'm0'
      ? { ...row('m0', 0), threadId: 't-m1', mailboxIds: { sent: true } }
      : { ...inbox().find((e) => e.id === id)!, threadId: 't-m1' })));
  });

  it('shows the whole conversation of the open message', async () => {
    render(<MailApp />);
    const reader = await screen.findByTestId('reader', {}, { timeout: 5000 });
    expect(reader).toHaveAttribute('data-pane', 'conversation');
    await waitFor(() => expect(reader).toHaveTextContent('m0,m1'));
  });

  it('shows the message alone with "Show emails as individual messages"', async () => {
    useSettingsStore.setState({ disableThreading: true } as never);
    render(<MailApp />);
    const reader = await screen.findByTestId('reader', {}, { timeout: 5000 });
    expect(reader).toHaveAttribute('data-pane', 'message');
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 50)); });
    expect(reader).toHaveTextContent('no conversation');
    expect(client.getThread).not.toHaveBeenCalled();
  });

  it('does not unfold the conversation in the list with x', async () => {
    useEmailStore.setState({ expandedThreadIds: new Set(), fetchThreadEmails: vi.fn().mockResolvedValue(undefined) } as never);
    render(<MailApp />);
    await screen.findByTestId('reader', {}, { timeout: 5000 });
    await press('x');
    expect(useEmailStore.getState().expandedThreadIds.size).toBe(0);
  });
});

describe('j and k after Escape', () => {
  beforeEach(() => {
    useSettingsStore.setState({ interfaceLayout: 'default', mailLayout: 'split' } as never);
    useEmailStore.setState({ listRows: null } as never);
  });

  it('j opens the message after the one that was open, not the first', async () => {
    render(<MailApp />);
    await screen.findByTestId('reader', {}, { timeout: 5000 });
    await press('j');
    await waitFor(() => expect(selectedId()).toBe('m2'));
    await press('Escape');
    await waitFor(() => expect(selectedId()).toBeNull());
    await press('j');
    await waitFor(() => expect(selectedId()).toBe('m3'));
  });

  it('k opens the message before it', async () => {
    useEmailStore.setState({ selectedEmail: inbox()[2] } as never);
    render(<MailApp />);
    await screen.findByTestId('reader', {}, { timeout: 5000 });
    await press('Escape');
    await waitFor(() => expect(selectedId()).toBeNull());
    await press('k');
    await waitFor(() => expect(selectedId()).toBe('m2'));
  });

  it('steps by conversation, in the order of the list', async () => {
    useEmailStore.setState({
      listRows: [{ key: 'm1', members: ['m1', 'm3'] }, { key: 'm2', members: ['m2'] }],
    } as never);
    render(<MailApp />);
    await screen.findByTestId('reader', {}, { timeout: 5000 });
    await press('j');
    await waitFor(() => expect(selectedId()).toBe('m2'));
    await press('j');
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 50)); });
    expect(selectedId()).toBe('m2');
    await press('k');
    await waitFor(() => expect(selectedId()).toBe('m1'));
  });
});
