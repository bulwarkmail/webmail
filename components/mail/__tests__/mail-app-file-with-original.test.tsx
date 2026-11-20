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

// "File in folder" in a reply: once sent, the reply goes into the folder as
// well as Sent, and the message it answers moves there.

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
type ComposerProps = {
  fileTargets?: Mailbox[];
  onSend?: (data: Record<string, unknown>, state?: Record<string, unknown>) => Promise<unknown>;
};
vi.mock('@/components/email/email-composer', () => ({
  EmailComposer: ({ fileTargets, onSend }: ComposerProps) => (
    <div data-testid="composer" data-file-targets={(fileTargets ?? []).map((m) => m.id).join(',')}>
      <button type="button" onClick={() => void onSend?.(
        { to: ['sam@example.org'], cc: [], bcc: [], subject: 'Re: Lunch tomorrow?', body: 'Works for me', fileInMailboxId: 'projects' },
        { mode: 'reply', body: '<p>Works for me</p>', to: 'sam@example.org', cc: '', bcc: '', subject: 'Re: Lunch tomorrow?', draftId: 'd-1', attachments: [], fileInMailboxId: 'projects' },
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
const original = {
  id: 'm1', threadId: 't-m1', subject: 'Lunch tomorrow?', receivedAt: new Date(Date.UTC(2026, 9, 31, 10, 30)).toISOString(),
  keywords: { $seen: true }, mailboxIds: { inbox: true }, from: [{ name: 'Sam', email: 'sam@example.org' }],
  to: [{ name: 'Me', email: 'a@example.org' }],
} as unknown as Email;

let client: Record<string, ReturnType<typeof vi.fn> | (() => unknown)>;
let sendEmail: ReturnType<typeof vi.fn>;
let moveToMailboxCrossAware: ReturnType<typeof vi.fn>;

function setUp(sendDelaySeconds: number) {
  vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('Unexpected network request')));
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} });
  usePluginStore.setState({ initializePlugins: vi.fn().mockResolvedValue(undefined) });
  useThemeStore.setState({ syncServerThemes: vi.fn().mockResolvedValue(undefined) });
  useToastStore.setState({ toasts: [] });
  clearAllHooks();
  forgetEmailPrefetches();
  const folders = [mailbox('inbox', 'inbox'), mailbox('sent', 'sent', 51), mailbox('drafts', 'drafts'), mailbox('projects', undefined)];
  client = {
    getAccountId: () => 'acc', getUsername: () => 'a@example.org',
    getSieveAccountId: () => null, hasDelayedSend: () => true, getSession: () => null,
    getMailboxes: vi.fn().mockResolvedValue(folders),
    getThread: vi.fn(async (threadId: string) => ({ id: threadId, emailIds: ['m1'] })),
    getSomeEmails: vi.fn(async () => [original]),
    getEmail: vi.fn(async () => ({ ...original, bodyValues: {} })),
    markAsRead: vi.fn().mockResolvedValue(undefined),
    addEmailToMailbox: vi.fn().mockResolvedValue(undefined),
    moveEmail: vi.fn().mockResolvedValue(undefined),
  };
  useAuthStore.setState({
    isAuthenticated: true, isLoading: false, client: client as never, activeAccountId: 'login-a', identities: [],
    getClientForAccount: (id: string) => (id === 'login-a' ? client : undefined) as never,
    getAllConnectedClients: () => new Map([['login-a', client]]) as never,
  });
  useSettingsStore.setState({
    enableUnifiedMailbox: false, interfaceLayout: 'default', mailLayout: 'split', disableThreading: false,
    sendDelaySeconds, sendConfirmation: false, placeholderWarningEnabled: false, attachmentReminderEnabled: false,
  } as never);
  sendEmail = vi.fn(async () => {
    if (!sendDelaySeconds) return { scheduled: false, emailId: 'sent-1', emailAccountId: 'acc' };
    const sendAt = new Date(Date.now() + sendDelaySeconds * 1000).toISOString();
    useEmailStore.setState({
      pendingUndoSend: { submissionId: 'sub-1', emailId: 'sent-1', sendAt, isSmime: false, countsBefore: { sent: 51, scheduled: 0 } },
    } as never);
    return { scheduled: true, emailId: 'sent-1', emailAccountId: 'acc', emailSubmissionId: 'sub-1', sendAt };
  });
  moveToMailboxCrossAware = vi.fn().mockResolvedValue(true);
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
    markEmailKeyword: vi.fn().mockResolvedValue(undefined),
    sendEmail, moveToMailboxCrossAware,
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
  const composer = await screen.findByTestId('composer');
  const targets = composer.getAttribute('data-file-targets');
  fireEvent.click(screen.getByRole('button', { name: 'composer send' }));
  return targets;
}

const toastTitled = (title: string) => useToastStore.getState().toasts.find((t) => t.title === title);

describe('File in folder', () => {
  beforeEach(() => setUp(0));

  it("offers the original's folders and files the reply and the original in the one picked", async () => {
    expect(await replyAndSend()).toBe('inbox,projects');

    await waitFor(() => expect(client.addEmailToMailbox).toHaveBeenCalledWith('sent-1', 'projects', undefined));
    await waitFor(() => expect(moveToMailboxCrossAware).toHaveBeenCalledWith(client, 'm1', 'projects', expect.any(String)));
    expect(toastTitled('email_composer.file_in_failed')).toBeUndefined();
  });

  it('says so when the original could not be moved', async () => {
    moveToMailboxCrossAware.mockRejectedValue(new Error('forbidden'));
    await replyAndSend();
    await waitFor(() => expect(toastTitled('email_composer.file_in_failed')).toBeDefined());
  });
});

describe('File in folder with Undo send', () => {
  beforeEach(() => setUp(5));

  it('files nothing while the send can still be undone', async () => {
    await replyAndSend();
    await waitFor(() => expect(sendEmail).toHaveBeenCalled());
    await act(async () => { await new Promise((r) => setTimeout(r, 200)); });
    expect(client.addEmailToMailbox).not.toHaveBeenCalled();
    expect(moveToMailboxCrossAware).not.toHaveBeenCalled();
  });
});
