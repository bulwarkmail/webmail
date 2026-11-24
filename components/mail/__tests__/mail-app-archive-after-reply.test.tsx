import React, { Suspense, lazy } from 'react';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Email, Mailbox } from '@/lib/jmap/types';
import { useAuthStore } from '@/stores/auth-store';
import { useEmailStore } from '@/stores/email-store';
import { useSettingsStore } from '@/stores/settings-store';
import { usePluginStore } from '@/stores/plugin-store';
import { usePolicyStore } from '@/stores/policy-store';
import { useThemeStore } from '@/stores/theme-store';
import { useToastStore } from '@/stores/toast-store';
import { DEFAULT_SEARCH_FILTERS } from '@/lib/jmap/search-utils';
import { clearAllHooks } from '@/lib/plugin-hooks';
import { forgetEmailPrefetches } from '@/lib/email-prefetch';

// "Archive after replying" (#1514): once a reply to an Inbox message has
// gone, its conversation's Inbox messages are archived through the login the
// original was read through; an undone send archives nothing.

vi.mock('next/dynamic', () => ({ default: (load: () => Promise<React.ComponentType<Record<string, unknown>>>) => {
  const Component = lazy(async () => ({ default: await load() }));
  return function Dynamic(props: Record<string, unknown>) {
    return <Suspense fallback={null}><Component {...props} /></Suspense>;
  };
} }));
vi.mock('@/components/email/email-viewer', () => ({
  EmailViewer: ({ onReply }: { onReply?: () => void }) => (
    <div data-testid="reader"><button type="button" onClick={() => onReply?.()}>reply</button></div>
  ),
}));
type ComposerProps = { onSend?: (data: Record<string, unknown>, state?: Record<string, unknown>) => Promise<unknown> };
vi.mock('@/components/email/email-composer', () => ({
  EmailComposer: ({ onSend }: ComposerProps) => (
    <div data-testid="composer">
      <button type="button" onClick={() => void onSend?.(
        { to: ['sam@example.org'], cc: [], bcc: [], subject: 'Re: Lunch tomorrow?', body: 'Works for me' },
        { mode: 'reply', body: '<p>Works for me</p>', to: 'sam@example.org', cc: '', bcc: '', subject: 'Re: Lunch tomorrow?', draftId: 'd-1', attachments: [] },
      )}>composer send</button>
    </div>
  ),
}));
vi.mock('@/components/layout/sidebar', () => ({ Sidebar: () => null }));
vi.mock('@/components/layout/navigation-rail', () => ({ NavigationRail: () => null }));
vi.mock('@/components/layout/calendar-event-notification-toaster', () => ({ CalendarEventNotificationToaster: () => null }));
vi.mock('@/components/layout/share-notification-toaster', () => ({ ShareNotificationToaster: () => null }));
vi.mock('@/components/layout/mobile-header', () => ({ MobileHeader: () => null }));
vi.mock('@/components/layout/mv-top-bar', () => ({ MvTopBar: () => null }));
vi.mock('@/components/layout/mv-side-panel', () => ({ MvSidePanel: () => null }));
vi.mock('@/components/email/message-list-tabs', () => ({ useMessageListPanelProps: (id: string) => ({ id }), MessageListTabs: () => null }));
vi.mock('@/components/search/search-box', () => ({ SearchBox: () => null }));
vi.mock('@/components/tour/tour-provider', () => ({ useTour: () => ({ activeTour: null, registerStep: vi.fn() }) }));
vi.mock('@/components/plugins/plugin-slot', () => ({ PluginSlot: () => null }));
vi.mock('@/hooks/use-plugin-slot-offers', () => ({ usePluginSlotOffers: () => [] }));
vi.mock('@/hooks/use-config', () => ({ useConfig: () => ({ appName: 'Mail' }), getCachedConfig: () => null }));
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
vi.mock('@/components/email/structured-mail/structured-mail-cards', () => ({ StructuredMailCards: () => null }));

const { MailApp } = await import('../mail-app');

function mailbox(id: string, role: string | undefined, totalEmails = 3): Mailbox {
  return {
    id, name: role ?? id, role, sortOrder: 0, totalEmails, unreadEmails: 0, totalThreads: 3, unreadThreads: 0, isSubscribed: true,
    myRights: { mayAddItems: true },
  } as Mailbox;
}
const receivedAt = new Date(Date.UTC(2026, 9, 31, 10, 30)).toISOString();
const original = {
  id: 'm1', threadId: 't-m1', subject: 'Lunch tomorrow?', receivedAt,
  keywords: { $seen: true }, mailboxIds: { inbox: true }, from: [{ name: 'Sam', email: 'sam@example.org' }],
  to: [{ name: 'Me', email: 'a@example.org' }],
} as unknown as Email;

type FakeClient = Record<string, ReturnType<typeof vi.fn> | (() => unknown)>;
let client: FakeClient;
let sendEmail: ReturnType<typeof vi.fn>;
let batchArchive: ReturnType<typeof vi.fn>;
let markEmailKeyword: ReturnType<typeof vi.fn>;
let cancelUndoSend: ReturnType<typeof vi.fn>;
/** What the server says of the conversation when the reply has gone. */
let serverMembers: Array<Record<string, unknown>>;

function setUp({ sendDelaySeconds = 0, archiveAfterReply = true } = {}) {
  vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('Unexpected network request')));
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} });
  usePluginStore.setState({ initializePlugins: vi.fn().mockResolvedValue(undefined) });
  useThemeStore.setState({ syncServerThemes: vi.fn().mockResolvedValue(undefined) });
  useToastStore.setState({ toasts: [] });
  usePolicyStore.setState({ demoFeatureOverrides: {} } as never);
  clearAllHooks();
  forgetEmailPrefetches();
  const folders = [mailbox('inbox', 'inbox'), mailbox('sent', 'sent', 51), mailbox('drafts', 'drafts'), mailbox('archive', 'archive')];
  serverMembers = [
    { id: 'm1', mailboxIds: { inbox: true }, keywords: { $seen: true }, receivedAt },
    { id: 'm0', mailboxIds: { inbox: true }, keywords: {}, receivedAt },
    { id: 'mine', mailboxIds: { sent: true }, keywords: { $seen: true }, receivedAt },
  ];
  client = {
    getAccountId: () => 'acc', getUsername: () => 'a@example.org',
    getSieveAccountId: () => null, hasDelayedSend: () => true, getSession: () => null,
    getMailboxes: vi.fn().mockResolvedValue(folders),
    getThread: vi.fn(async (threadId: string) => ({ id: threadId, emailIds: ['m0', 'm1', 'mine'] })),
    getEmailFields: vi.fn(async () => serverMembers),
    getSomeEmails: vi.fn(async () => [original]),
    getEmail: vi.fn(async () => ({ ...original, bodyValues: {} })),
    markAsRead: vi.fn().mockResolvedValue(undefined),
    deleteEmail: vi.fn().mockResolvedValue(undefined),
  };
  useAuthStore.setState({
    isAuthenticated: true, isLoading: false, client: client as never, activeAccountId: 'login-a', identities: [],
    getClientForAccount: (id: string) => (id === 'login-a' ? client : undefined) as never,
    getAllConnectedClients: () => new Map([['login-a', client]]) as never,
  });
  useSettingsStore.setState({
    enableUnifiedMailbox: false, interfaceLayout: 'default', mailLayout: 'split', disableThreading: false,
    sendDelaySeconds, sendConfirmation: false, placeholderWarningEnabled: false, attachmentReminderEnabled: false,
    archiveAfterReply,
  } as never);
  sendEmail = vi.fn(async () => {
    if (!sendDelaySeconds) return { scheduled: false, emailId: 'sent-1', emailAccountId: 'acc' };
    const sendAt = new Date(Date.now() + sendDelaySeconds * 1000).toISOString();
    useEmailStore.setState({
      pendingUndoSend: { submissionId: 'sub-1', emailId: 'sent-1', sendAt, isSmime: false, countsBefore: { sent: 51, scheduled: 0 } },
    } as never);
    return { scheduled: true, emailId: 'sent-1', emailAccountId: 'acc', emailSubmissionId: 'sub-1', sendAt };
  });
  batchArchive = vi.fn().mockResolvedValue(true);
  markEmailKeyword = vi.fn().mockResolvedValue(undefined);
  cancelUndoSend = vi.fn(async () => {
    useEmailStore.setState({ pendingUndoSend: null } as never);
    return { ...original, id: 'sent-1', mailboxIds: { drafts: true }, keywords: { $draft: true } };
  });
  useEmailStore.setState({
    emails: [original], selectedEmail: original, selectedMailbox: 'inbox', selectedKeyword: null, mailboxes: folders,
    viewingAccountId: null, accountMailboxes: {}, isUnifiedView: false, unifiedRole: null,
    isScheduledView: false, isLoadingEmail: false, isLoading: false, searchQuery: '',
    searchFilters: { ...DEFAULT_SEARCH_FILTERS }, searchMailboxId: '', scheduledTotal: 0, pendingUndoSend: null,
    selectedEmailKeys: new Set(), unreadSection: null, listRows: null,
    fetchMailboxes: vi.fn().mockResolvedValue(undefined), fetchEmails: vi.fn().mockResolvedValue(undefined),
    fetchQuota: vi.fn().mockResolvedValue(undefined), fetchTagCounts: vi.fn().mockResolvedValue(undefined),
    refreshScheduledMetadata: vi.fn().mockResolvedValue(undefined),
    fetchEmailContent: vi.fn().mockResolvedValue(undefined),
    sendEmail, batchArchive, markEmailKeyword, cancelUndoSend,
  } as never);
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

async function replyAndSend() {
  render(<MailApp />);
  await screen.findByTestId('reader', {}, { timeout: 5000 });
  fireEvent.click(screen.getByRole('button', { name: 'reply' }));
  await screen.findByTestId('composer');
  fireEvent.click(screen.getByRole('button', { name: 'composer send' }));
  await waitFor(() => expect(sendEmail).toHaveBeenCalled());
}

const wait = (ms: number) => act(async () => { await new Promise((r) => setTimeout(r, ms)); });
const toastTitled = (title: string) => useToastStore.getState().toasts.find((t) => t.title === title);

describe('Archive after replying', () => {
  it("archives the conversation's Inbox messages once the reply is sent, with Undo", async () => {
    setUp();
    await replyAndSend();
    await waitFor(() => expect(batchArchive).toHaveBeenCalledTimes(1));
    const [, target] = batchArchive.mock.calls[0];
    expect(target.client).toBe(client);
    expect(target.emailIds.sort()).toEqual(['m0', 'm1']);
    expect(target.userArchive).toBe(true);
    await waitFor(() => expect(toastTitled('mail_list_extra.archived')?.action).toBeTruthy());
  });

  it('archives nothing with the setting off', async () => {
    setUp({ archiveAfterReply: false });
    await replyAndSend();
    await waitFor(() => expect(markEmailKeyword).toHaveBeenCalled());
    await wait(100);
    expect(batchArchive).not.toHaveBeenCalled();
  });

  it('archives nothing while the admin has the Archive action off', async () => {
    setUp();
    usePolicyStore.setState({ demoFeatureOverrides: { archiveActionEnabled: false } } as never);
    await replyAndSend();
    await waitFor(() => expect(markEmailKeyword).toHaveBeenCalled());
    await wait(100);
    expect(batchArchive).not.toHaveBeenCalled();
  });

  it('leaves the original where the user put it in the meantime', async () => {
    setUp();
    serverMembers = [{ id: 'm1', mailboxIds: { projects: true }, keywords: {}, receivedAt }];
    await replyAndSend();
    await waitFor(() => expect(client.getEmailFields).toHaveBeenCalled());
    await wait(100);
    expect(batchArchive).not.toHaveBeenCalled();
  });
});

describe('Archive after replying with Undo send', () => {
  it('waits for the Undo window, then archives through the original login after a login switch', async () => {
    setUp({ sendDelaySeconds: 1 });
    await replyAndSend();
    await wait(200);
    expect(batchArchive).not.toHaveBeenCalled();

    // The user moves on to another login while the send is held.
    const other = { ...client, getMailboxes: vi.fn().mockResolvedValue([]), getEmailFields: vi.fn(async () => []) };
    useAuthStore.setState({ client: other as never, activeAccountId: 'login-b' });

    await waitFor(() => expect(batchArchive).toHaveBeenCalledTimes(1), { timeout: 3000 });
    const [activeClient, target] = batchArchive.mock.calls[0];
    expect(activeClient).toBe(other);
    expect(target.client).toBe(client);
    expect(other.getEmailFields).not.toHaveBeenCalled();
  });

  it('archives nothing when the send is undone', async () => {
    setUp({ sendDelaySeconds: 1 });
    await replyAndSend();
    const undo = await waitFor(() => {
      const toast = useToastStore.getState().toasts.find((t) => t.action);
      expect(toast).toBeTruthy();
      return toast!;
    });
    await act(async () => { undo.action!.onClick(); });
    await waitFor(() => expect(cancelUndoSend).toHaveBeenCalled());
    await wait(1500);
    expect(batchArchive).not.toHaveBeenCalled();
    expect(client.getEmailFields).not.toHaveBeenCalled();
  });
});
