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
import { useQuickReplyRestoreStore } from '@/stores/quick-reply-restore-store';
import { DEFAULT_SEARCH_FILTERS } from '@/lib/jmap/search-utils';
import { clearAllHooks } from '@/lib/plugin-hooks';
import { forgetEmailPrefetches } from '@/lib/email-prefetch';

// mail-p2-1: a quick reply that went out shows in the open conversation at
// once. mail-p2-8: during its Undo window it isn't counted in Sent or
// Scheduled and the message isn't marked answered; Undo takes it out of the
// conversation and puts the text back into the quick reply box, leaving no
// draft behind.

vi.mock('next/dynamic', () => ({ default: (load: () => Promise<React.ComponentType<Record<string, unknown>>>) => {
  const Component = lazy(async () => ({ default: await load() }));
  return function Dynamic(props: Record<string, unknown>) {
    return <Suspense fallback={null}><Component {...props} /></Suspense>;
  };
} }));
type ViewerProps = { mvConversation?: { id: string }[]; onQuickReply?: (body: string) => Promise<boolean | void>; onReply?: () => void };
vi.mock('@/components/email/email-viewer', () => ({
  EmailViewer: ({ mvConversation, onQuickReply, onReply }: ViewerProps) => (
    <div>
      <div data-testid="reader">{mvConversation ? mvConversation.map((e) => e.id).join(',') : 'no conversation'}</div>
      <button type="button" onClick={() => void onQuickReply?.('Thanks, see you there')}>quick send</button>
      <button type="button" onClick={() => onReply?.()}>reply</button>
    </div>
  ),
}));
type ComposerProps = {
  mode: string;
  initialData?: { draftId?: string | null; body?: string } | null;
  onSend?: (data: Record<string, unknown>, state?: Record<string, unknown>) => Promise<unknown>;
};
vi.mock('@/components/email/email-composer', () => ({
  EmailComposer: ({ mode, initialData, onSend }: ComposerProps) => (
    <div data-testid="composer" data-mode={mode} data-draft={initialData?.draftId ?? ''} data-body={initialData?.body ?? ''}>
      <button type="button" onClick={() => void onSend?.(
        { to: ['sam@example.org'], cc: [], bcc: [], subject: 'Re: Lunch tomorrow?', body: 'Works for me' },
        { mode: 'reply', body: '<p>Works for me</p>', to: 'sam@example.org', cc: '', bcc: '', subject: 'Re: Lunch tomorrow?', draftId: 'd-1', attachments: [] },
      )}>composer send</button>
    </div>
  ),
}));
vi.mock('@/components/layout/sidebar', () => ({
  Sidebar: ({ scheduledTotal, mailboxes }: { scheduledTotal?: number; mailboxes: Mailbox[] }) => (
    <div data-testid="sidebar-counts">{`scheduled ${scheduledTotal} sent ${mailboxes.find((m) => m.role === 'sent')?.totalEmails}`}</div>
  ),
}));
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

const { MailApp } = await import('../mail-app');

function mailbox(id: string, role: string, totalEmails = 3): Mailbox {
  return {
    id, name: role, role, sortOrder: 0, totalEmails, unreadEmails: 0, totalThreads: 3, unreadThreads: 0, isSubscribed: true,
  } as Mailbox;
}
const row = (id: string, minute: number, extra: Partial<Email> = {}) => ({
  id, threadId: 't-m1', subject: 'Lunch tomorrow?', receivedAt: new Date(Date.UTC(2026, 9, 31, 10, minute)).toISOString(),
  keywords: { $seen: true }, mailboxIds: { inbox: true }, from: [{ name: 'Sam', email: 'sam@example.org' }],
  to: [{ name: 'Me', email: 'a@example.org' }], ...extra,
}) as unknown as Email;

let client: Record<string, ReturnType<typeof vi.fn> | (() => unknown)>;
let sendEmail: ReturnType<typeof vi.fn>;
let markEmailKeyword: ReturnType<typeof vi.fn>;
let cancelUndoSend: ReturnType<typeof vi.fn>;
let folders: Mailbox[];

beforeEach(() => {
  vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('Unexpected network request')));
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} });
  usePluginStore.setState({ initializePlugins: vi.fn().mockResolvedValue(undefined) });
  useThemeStore.setState({ syncServerThemes: vi.fn().mockResolvedValue(undefined) });
  useToastStore.setState({ toasts: [] });
  useQuickReplyRestoreStore.setState({ pending: null });
  clearAllHooks();
  forgetEmailPrefetches();
  folders = [mailbox('inbox', 'inbox'), mailbox('sent', 'sent', 51), mailbox('drafts', 'drafts')];
  const thread = [row('m0', 0, { mailboxIds: { inbox: true } }), row('m1', 30)];
  client = {
    getAccountId: () => 'acc', getUsername: () => 'a@example.org',
    getSieveAccountId: () => null, hasDelayedSend: () => true, getSession: () => null,
    getMailboxes: vi.fn().mockResolvedValue(folders),
    getThread: vi.fn(async (threadId: string) => ({ id: threadId, emailIds: ['m0', 'm1'] })),
    getSomeEmails: vi.fn(async (ids: string[]) => thread.filter((e) => ids.includes(e.id))),
    getEmail: vi.fn(async (id: string) => ({ ...thread.find((e) => e.id === id)!, bodyValues: {} })),
    deleteEmail: vi.fn().mockResolvedValue(undefined),
    markAsRead: vi.fn().mockResolvedValue(undefined),
  };
  useAuthStore.setState({
    isAuthenticated: true, isLoading: false, client: client as never, activeAccountId: 'login-a', identities: [],
    getClientForAccount: (id: string) => (id === 'login-a' ? client : undefined) as never,
    getAllConnectedClients: () => new Map([['login-a', client]]) as never,
  });
  useSettingsStore.setState({
    enableUnifiedMailbox: false, interfaceLayout: 'default', mailLayout: 'split', disableThreading: false,
    sendDelaySeconds: 5, sendConfirmation: false, placeholderWarningEnabled: false, attachmentReminderEnabled: false,
  } as never);
  sendEmail = vi.fn(async () => {
    const sendAt = new Date(Date.now() + 5000).toISOString();
    useEmailStore.setState({
      pendingUndoSend: {
        submissionId: 'sub-1', emailId: 'sent-1', sendAt, isSmime: false,
        countsBefore: { sent: 51, scheduled: 0 },
      },
    } as never);
    // The server files it in Sent and lists its submission at once.
    useEmailStore.setState({ scheduledTotal: 1, mailboxes: folders.map((m) => m.role === 'sent' ? { ...m, totalEmails: 52 } : m) } as never);
    return { scheduled: true, emailId: 'sent-1', emailSubmissionId: 'sub-1', sendAt };
  });
  markEmailKeyword = vi.fn().mockResolvedValue(undefined);
  cancelUndoSend = vi.fn(async () => {
    useEmailStore.setState({ pendingUndoSend: null } as never);
    return { ...row('sent-1', 40), id: 'sent-1', mailboxIds: { drafts: true }, keywords: { $draft: true } };
  });
  const emails = [row('m1', 30)];
  useEmailStore.setState({
    emails, selectedEmail: emails[0], selectedMailbox: 'inbox', selectedKeyword: null, mailboxes: folders,
    viewingAccountId: null, accountMailboxes: {}, isUnifiedView: false, unifiedRole: null,
    isScheduledView: false, isLoadingEmail: false, isLoading: false, searchQuery: '',
    searchFilters: { ...DEFAULT_SEARCH_FILTERS }, searchMailboxId: '', scheduledTotal: 0, pendingUndoSend: null,
    selectedEmailKeys: new Set(), unreadSection: null, listRows: null,
    fetchMailboxes: vi.fn().mockResolvedValue(undefined), fetchEmails: vi.fn().mockResolvedValue(undefined),
    fetchQuota: vi.fn().mockResolvedValue(undefined), fetchTagCounts: vi.fn().mockResolvedValue(undefined),
    refreshScheduledMetadata: vi.fn().mockResolvedValue(undefined),
    fetchEmailContent: vi.fn().mockResolvedValue(undefined),
    sendEmail, markEmailKeyword, cancelUndoSend,
  } as never);
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('a quick reply in its Undo window', () => {
  it('shows in the conversation at once, counts nowhere and answers nothing yet; Undo puts it back in the box', async () => {
    render(<MailApp />);
    const reader = await screen.findByTestId('reader', {}, { timeout: 5000 });
    await waitFor(() => expect(reader).toHaveTextContent('m0,m1'));

    fireEvent.click(screen.getByRole('button', { name: 'quick send' }));
    await waitFor(() => expect(sendEmail).toHaveBeenCalled());
    await waitFor(() => expect(reader).toHaveTextContent('m0,m1,sent-1'));

    expect(markEmailKeyword).not.toHaveBeenCalled();
    expect(screen.getByTestId('sidebar-counts')).toHaveTextContent('scheduled 0 sent 51');

    const undo = await waitFor(() => {
      const toast = useToastStore.getState().toasts.find((t) => t.action);
      expect(toast).toBeTruthy();
      return toast!;
    });
    await act(async () => { undo.action!.onClick(); });
    await waitFor(() => expect(cancelUndoSend).toHaveBeenCalled());
    await waitFor(() => expect(reader).toHaveTextContent(/^m0,m1$/));
    await waitFor(() => expect(useQuickReplyRestoreStore.getState().pending).toEqual({ emailId: 'm1', text: 'Thanks, see you there' }));
    expect(client.deleteEmail).toHaveBeenCalledWith('sent-1', undefined);
    expect(markEmailKeyword).not.toHaveBeenCalled();
  });

  it('brings an undone reply back into the dock, as it was', async () => {
    render(<MailApp />);
    await screen.findByTestId('reader', {}, { timeout: 5000 });
    fireEvent.click(screen.getByRole('button', { name: 'reply' }));
    const composer = await screen.findByTestId('composer');
    expect(composer.closest('[data-reply-dock]')).not.toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'composer send' }));
    await waitFor(() => expect(sendEmail).toHaveBeenCalled());
    await waitFor(() => expect(screen.queryByTestId('composer')).toBeNull());
    expect(markEmailKeyword).not.toHaveBeenCalled();

    const undo = await waitFor(() => {
      const toast = useToastStore.getState().toasts.find((t) => t.action);
      expect(toast).toBeTruthy();
      return toast!;
    });
    await act(async () => { undo.action!.onClick(); });
    const back = await screen.findByTestId('composer');
    expect(back).toHaveAttribute('data-mode', 'reply');
    expect(back).toHaveAttribute('data-draft', 'sent-1');
    expect(back).toHaveAttribute('data-body', '<p>Works for me</p>');
    expect(back.closest('[data-reply-dock]')).not.toBeNull();
  });
});
