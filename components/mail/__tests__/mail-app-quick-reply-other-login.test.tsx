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

// Login B's Inbox is open in the Pro sidebar while login A is active, and one
// of B's messages is in the reader. The quick reply box under it must not
// send the reply through A, from A's address: it goes to the full composer
// with the typed text, or, while B has no connection, sends nothing and
// keeps the text.

vi.mock('next/dynamic', () => ({ default: (load: () => Promise<React.ComponentType<Record<string, unknown>>>) => {
  const Component = lazy(async () => ({ default: await load() }));
  return function Dynamic(props: Record<string, unknown>) {
    return <Suspense fallback={null}><Component {...props} /></Suspense>;
  };
} }));
const reader = vi.hoisted(() => ({ props: null as Record<string, unknown> | null }));
vi.mock('@/components/email/email-viewer', () => ({
  EmailViewer: (props: Record<string, unknown>) => {
    reader.props = props;
    return <div>reader</div>;
  },
}));
const composer = vi.hoisted(() => ({ props: null as Record<string, unknown> | null }));
vi.mock('@/components/email/email-composer', () => ({
  EmailComposer: (props: Record<string, unknown>) => {
    composer.props = props;
    return <div>composer</div>;
  },
}));
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

function mailbox(id: string, role: string, accountId: string): Mailbox {
  return {
    id, originalId: id, name: role, role, accountId, isShared: false,
    sortOrder: 0, totalEmails: 1, unreadEmails: 0, totalThreads: 1, unreadThreads: 0, isSubscribed: true,
  } as Mailbox;
}
const own = [mailbox('a', 'inbox', 'ee')];
const theirs = [mailbox('a', 'inbox', 'ef')];
const message = {
  id: 'eaaaaab', threadId: 't-b', subject: 'B payroll', receivedAt: '2026-11-11T10:00:00Z', keywords: { $seen: true }, mailboxIds: { a: true },
  from: [{ name: 'Sam', email: 'sam@example.org' }], to: [{ email: 'b@example.org' }], messageId: ['m@example.org'],
  bodyValues: { '1': { value: 'B payroll' } }, textBody: [{ partId: '1', type: 'text/plain' }], htmlBody: [{ partId: '1', type: 'text/plain' }],
  attachments: [], size: 10,
} as unknown as Email;

function makeClient(account: string) {
  return {
    getAccountId: () => account, getUsername: () => `${account}@example.org`, getServerUrl: () => `https://${account}.example.org`,
    getSieveAccountId: () => null, hasDelayedSend: () => false, getSession: () => null, getSharedAccounts: () => [],
    getMailboxes: vi.fn().mockResolvedValue(account === 'ee' ? own : theirs),
    getEmails: vi.fn().mockResolvedValue({ emails: [message], hasMore: false, total: 1 }),
    getEmail: vi.fn().mockResolvedValue(null),
    getThreadEmails: vi.fn().mockResolvedValue([]), getThread: vi.fn().mockResolvedValue(null),
  };
}

let active: ReturnType<typeof makeClient>;
let other: ReturnType<typeof makeClient> | undefined;
let sendEmail: ReturnType<typeof vi.fn>;

beforeEach(() => {
  vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('Unexpected network request')));
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} });
  vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  usePluginStore.setState({ initializePlugins: vi.fn().mockResolvedValue(undefined) });
  useThemeStore.setState({ syncServerThemes: vi.fn().mockResolvedValue(undefined) });
  useToastStore.setState({ toasts: [] });
  clearAllHooks();
  reader.props = null;
  composer.props = null;
  active = makeClient('ee');
  other = makeClient('ef');
  useAuthStore.setState({
    isAuthenticated: true, isLoading: false, client: active as never, activeAccountId: 'login-a',
    identities: [{ id: 'id-a', email: 'a@example.org', name: 'A' }] as never,
    getClientForAccount: (id: string) => (id === 'login-a' ? active : id === 'login-b' ? other : undefined) as never,
    getAllConnectedClients: () => new Map<string, unknown>([['login-a', active], ...(other ? [['login-b', other] as [string, unknown]] : [])]) as never,
  });
  useSettingsStore.setState({
    enableUnifiedMailbox: false, mailLayout: 'split', markAsReadDelay: -1,
    sendConfirmation: false, placeholderWarningEnabled: false, attachmentReminderEnabled: false, sendDelaySeconds: 0,
  } as never);
  sendEmail = vi.fn().mockResolvedValue({ emailId: 'sent-1' });
  useEmailStore.setState({
    emails: [message], selectedEmail: message, selectedMailbox: 'a', selectedKeyword: null, mailboxes: own,
    viewingAccountId: 'login-b', accountMailboxes: { 'login-b': theirs },
    isUnifiedView: false, unifiedRole: null,
    isScheduledView: false, isLoadingEmail: false, isLoading: false, searchQuery: '',
    searchFilters: { ...DEFAULT_SEARCH_FILTERS }, searchMailboxId: '',
    selectedEmailKeys: new Set(), processingReadStatus: new Set(), threadEmailsCache: new Map(), expandedThreadIds: new Set(),
    fetchMailboxes: vi.fn().mockResolvedValue(undefined),
    fetchQuota: vi.fn().mockResolvedValue(undefined), fetchTagCounts: vi.fn().mockResolvedValue(undefined),
    refreshScheduledMetadata: vi.fn().mockResolvedValue(undefined),
    sendEmail,
  } as never);
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

async function quickReply(text: string) {
  render(<MailApp />);
  await screen.findByText('reader', {}, { timeout: 5000 });
  const send = reader.props?.onQuickReply as (body: string) => Promise<boolean>;
  expect(send).toBeTypeOf('function');
  let outcome: boolean | undefined;
  await act(async () => {
    outcome = await send(text);
    await new Promise((resolve) => setTimeout(resolve, 30));
  });
  return outcome;
}

describe('the quick reply under a message of another login', () => {
  it('sends nothing through the active login and opens the full composer with the text', async () => {
    await quickReply('Thanks, see you there');
    expect(sendEmail).not.toHaveBeenCalled();
    expect(await screen.findByText('composer')).toBeTruthy();
    expect(composer.props?.mode).toBe('reply');
  });

  it('keeps the text while that login has no connection', async () => {
    other = undefined;
    const outcome = await quickReply('Thanks, see you there');
    expect(outcome).toBe(false);
    expect(sendEmail).not.toHaveBeenCalled();
    expect(screen.queryByText('composer')).toBeNull();
  });
});
