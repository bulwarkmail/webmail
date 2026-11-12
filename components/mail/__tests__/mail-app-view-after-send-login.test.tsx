import React, { Suspense, lazy } from 'react';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
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

// "Sent · View" opens the message that was just sent. The link names the
// login it went out through: when another login is the active one by the
// time View is clicked, the sent id is another message there, so the app
// goes back to the sending login instead of opening that one.
// Harness of send-closes-composer.test.tsx.
vi.mock('next/dynamic', () => ({ default: (load: () => Promise<React.ComponentType<Record<string, unknown>>>) => {
  const Component = lazy(async () => ({ default: await load() }));
  return function Dynamic(props: Record<string, unknown>) {
    return <Suspense fallback={null}><Component {...props} /></Suspense>;
  };
} }));
vi.mock('@/components/email/email-composer', () => ({
  EmailComposer: ({ onSend }: { onSend?: (data: unknown) => Promise<void> }) => (
    <button onClick={() => { void onSend?.({ to: ['bob@example.com'], cc: [], bcc: [], subject: 'Hi', body: 'Hello' }); }}>
      stub send
    </button>
  ),
}));
vi.mock('@/components/email/email-viewer', () => ({ EmailViewer: () => <div>reader</div> }));
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
  useDeviceDetection: () => ({ isMobile: true, isTablet: false, isDesktop: false }),
  useMediaQuery: () => false,
  useIsDesktop: () => false,
}));
vi.mock('@/lib/push-bindings', () => ({ reconcilePushBindings: () => {}, releasePushBindings: () => {} }));
vi.mock('@/components/email/email-list', () => ({ EmailList: () => <div>message list</div> }));

const { MailApp } = await import('../mail-app');

const inbox = { id: 'inbox', name: 'Inbox', role: 'inbox' } as Mailbox;
const SENT = 'eaaaaab';
const message = (subject: string) => ({ id: SENT, threadId: 't', subject, receivedAt: '2026-11-11T10:00:00Z', keywords: {}, mailboxIds: { inbox: true } });
const makeClient = (account: string, subject: string) => ({
  getAccountId: () => account, getUsername: () => `${account}@example.com`,
  getSieveAccountId: () => null, hasDelayedSend: () => false, getSession: () => null,
  getEmail: vi.fn(async (_id: string, _accountId?: string) => message(subject)),
  getEmails: vi.fn(async () => ({ emails: [], total: 0, hasMore: false })),
  getMailboxes: vi.fn(async () => [inbox]),
  getSharedAccounts: () => [],
});
const entry = (id: string) => ({ id, label: id, email: id, username: id, serverUrl: 'https://mail.example', isConnected: true }) as never;
const sendEmail = vi.fn();
const originalAccounts = useAccountStore.getState().accounts;
let clientA: ReturnType<typeof makeClient>;
let clientB: ReturnType<typeof makeClient>;
let switchAccount: ReturnType<typeof vi.fn>;

beforeEach(() => {
  vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('Unexpected network request')));
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} });
  usePluginStore.setState({ initializePlugins: vi.fn().mockResolvedValue(undefined) });
  useThemeStore.setState({ syncServerThemes: vi.fn().mockResolvedValue(undefined) });
  clientA = makeClient('ee', 'What login a sent');
  clientB = makeClient('ef', 'Another message of login b');
  const clients: Record<string, ReturnType<typeof makeClient>> = { 'login-a': clientA, 'login-b': clientB };
  // As the store's own: the login becomes the active one, with its client.
  switchAccount = vi.fn(async (id: string) => {
    useAuthStore.setState({ activeAccountId: id, client: clients[id] as never });
  });
  useAccountStore.setState({ accounts: [entry('login-a'), entry('login-b')] });
  useAuthStore.setState({
    isAuthenticated: true, isLoading: false, client: clientA as never, activeAccountId: 'login-a', identities: [],
    getClientForAccount: ((id: string) => clients[id]) as never,
    getAllConnectedClients: () => new Map(Object.entries(clients)) as never,
    switchAccount: switchAccount as never,
  });
  useSettingsStore.setState({ enableUnifiedMailbox: false, mailLayout: 'split', sendDelaySeconds: 0, proInterface: false } as never);
  sendEmail.mockReset().mockResolvedValue({ scheduled: false, emailId: SENT });
  useToastStore.setState({ toasts: [] });
  useEmailStore.setState({
    emails: [], selectedEmail: null, selectedMailbox: inbox.id, mailboxes: [inbox],
    viewingAccountId: null, accountMailboxes: {}, isUnifiedView: false, unifiedRole: null,
    isScheduledView: false, isLoadingEmail: false, isLoading: false, searchQuery: '',
    searchFilters: { ...DEFAULT_SEARCH_FILTERS }, searchMailboxId: '', selectedKeyword: null,
    selectedEmailKeys: new Set(),
    fetchMailboxes: vi.fn().mockResolvedValue(undefined), fetchEmails: vi.fn().mockResolvedValue(undefined),
    fetchQuota: vi.fn().mockResolvedValue(undefined), fetchTagCounts: vi.fn().mockResolvedValue(undefined),
    refreshScheduledMetadata: vi.fn().mockResolvedValue(undefined),
    sendEmail,
  } as never);
});
afterEach(() => {
  useAccountStore.setState({ accounts: originalAccounts });
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

const sentToast = () => useToastStore.getState().toasts.find((toast) => toast.title === 'compose_send.sent');

async function sendAndGetView() {
  render(<MailApp />);
  fireEvent.click(screen.getByRole('button', { name: 'sidebar.compose' }));
  fireEvent.click(await screen.findByText('stub send', {}, { timeout: 5000 }));
  await waitFor(() => expect(sentToast()?.action?.label).toBe('compose_send.view'));
  expect(sendEmail.mock.calls[0][0]).toBe(clientA);
  return sentToast()!.action!.onClick;
}

describe('"View" after a send', () => {
  it('opens the sent message through the login it was sent from', async () => {
    const view = await sendAndGetView();
    await act(async () => { view(); await new Promise((resolve) => setTimeout(resolve, 50)); });
    expect(clientA.getEmail).toHaveBeenCalled();
    expect(clientA.getEmail.mock.calls[0][0]).toBe(SENT);
    expect(switchAccount).not.toHaveBeenCalled();
  });

  it('clicked after another login became the active one goes back to the sending login, and never reads the id through the other', async () => {
    const view = await sendAndGetView();
    // The user switches to login b before clicking View.
    await act(async () => { useAuthStore.setState({ activeAccountId: 'login-b', client: clientB as never }); });
    await act(async () => { view(); await new Promise((resolve) => setTimeout(resolve, 100)); });
    expect(clientB.getEmail).not.toHaveBeenCalled();
    expect(switchAccount).toHaveBeenCalledWith('login-a');
    await waitFor(() => expect(clientA.getEmail).toHaveBeenCalled());
    expect(clientA.getEmail.mock.calls[0][0]).toBe(SENT);
  });
});
