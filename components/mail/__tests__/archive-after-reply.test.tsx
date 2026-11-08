import React, { Suspense, lazy } from 'react';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
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
import { resetHeldSends } from '@/lib/send-settled';

// Settings > Composing > "Archive after replying": a reply to or forward of
// an Inbox message archives that message once the reply has gone.

vi.mock('next/dynamic', () => ({ default: (load: () => Promise<React.ComponentType<Record<string, unknown>>>) => {
  const Component = lazy(async () => ({ default: await load() }));
  return function Dynamic(props: Record<string, unknown>) {
    return <Suspense fallback={null}><Component {...props} /></Suspense>;
  };
} }));
vi.mock('@/components/email/email-composer', () => ({
  EmailComposer: ({ onSend }: { onSend?: (data: unknown) => Promise<void> }) => (
    <button onClick={() => { void onSend?.({ to: ['bob@example.com'], cc: [], bcc: [], subject: 'Re: Hi', body: 'Thanks' }); }}>
      stub send
    </button>
  ),
}));
vi.mock('@/components/email/email-viewer', () => ({
  EmailViewer: ({ onReply, onForward }: { onReply?: () => void; onForward?: () => void }) => (
    <>
      <button onClick={() => onReply?.()}>stub reply</button>
      <button onClick={() => onForward?.()}>stub forward</button>
    </>
  ),
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

function mailbox(id: string, role: string): Mailbox {
  return {
    id, name: role || id, role, sortOrder: 0, totalEmails: 1, unreadEmails: 0, totalThreads: 1, unreadThreads: 0, isSubscribed: true,
  } as Mailbox;
}
const folders = [mailbox('inbox', 'inbox'), mailbox('archive', 'archive'), mailbox('work', '')];
const original = (mailboxIds: Record<string, boolean> = { inbox: true }, keywords: Record<string, boolean> = { $seen: true }) => ({
  id: 'm1', threadId: 't-m1', subject: 'Hi', receivedAt: '2026-10-31T10:00:00Z',
  from: [{ email: 'bob@example.com' }], to: [{ email: 'me@example.com' }],
  keywords, mailboxIds,
}) as unknown as Email;

const sendEmail = vi.fn();
const moveThreadToMailbox = vi.fn();
const cancelUndoSend = vi.fn();
const initialPolicy = usePolicyStore.getState().policy;

function openWith(email: Email) {
  useEmailStore.setState({ emails: [email], selectedEmail: email } as never);
}

beforeEach(() => {
  vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('Unexpected network request')));
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} });
  usePluginStore.setState({ initializePlugins: vi.fn().mockResolvedValue(undefined) });
  useThemeStore.setState({ syncServerThemes: vi.fn().mockResolvedValue(undefined) });
  useToastStore.setState({ toasts: [] });
  clearAllHooks();
  resetHeldSends();
  const client = {
    getAccountId: () => 'acc', getUsername: () => 'me@example.com',
    getSieveAccountId: () => null, hasDelayedSend: () => true, getSession: () => null,
    getMailboxes: vi.fn().mockResolvedValue(folders),
  };
  useAuthStore.setState({
    isAuthenticated: true, isLoading: false, client: client as never, activeAccountId: 'login', identities: [],
    getClientForAccount: () => client as never,
    getAllConnectedClients: () => new Map([['login', client]]) as never,
  });
  useSettingsStore.setState({
    enableUnifiedMailbox: false, mailLayout: 'split', sendDelaySeconds: 0, archiveMode: 'single',
    confirmArchive: false, archiveAfterReply: true,
  } as never);
  sendEmail.mockReset().mockResolvedValue({ scheduled: false, emailId: 'sent-1', emailSubmissionId: 's1' });
  moveThreadToMailbox.mockReset().mockResolvedValue(true);
  cancelUndoSend.mockReset().mockResolvedValue(null);
  useEmailStore.setState({
    emails: [], selectedEmail: null, selectedMailbox: 'inbox', mailboxes: folders,
    viewingAccountId: null, accountMailboxes: {}, isUnifiedView: false, unifiedRole: null,
    isScheduledView: false, isLoadingEmail: false, isLoading: false, searchQuery: '',
    searchFilters: { ...DEFAULT_SEARCH_FILTERS }, searchMailboxId: '', selectedKeyword: null,
    selectedEmailKeys: new Set(),
    fetchMailboxes: vi.fn().mockResolvedValue(undefined), fetchEmails: vi.fn().mockResolvedValue(undefined),
    fetchQuota: vi.fn().mockResolvedValue(undefined), fetchTagCounts: vi.fn().mockResolvedValue(undefined),
    fetchEmailContent: vi.fn().mockResolvedValue(undefined),
    refreshScheduledMetadata: vi.fn().mockResolvedValue(undefined),
    markEmailKeyword: vi.fn().mockResolvedValue(undefined),
    sendEmail, moveThreadToMailbox, cancelUndoSend,
    clearPendingUndoSend: () => useEmailStore.setState({ pendingUndoSend: null }),
    pendingUndoSend: null,
  } as never);
  openWith(original());
});
afterEach(() => {
  usePolicyStore.setState({ policy: initialPolicy });
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

async function replyAndSend(action: 'stub reply' | 'stub forward' = 'stub reply') {
  render(<MailApp />);
  fireEvent.click(await screen.findByText(action, {}, { timeout: 5000 }));
  fireEvent.click(await screen.findByText('stub send', {}, { timeout: 5000 }));
  await waitFor(() => expect(sendEmail).toHaveBeenCalled());
}

const archivedIds = () => moveThreadToMailbox.mock.calls.filter((c) => c[2] === 'archive').map((c) => c[1]);
/** Gives the send handler time to (not) archive. */
const settle = () => act(() => new Promise((r) => setTimeout(r, 50)));

describe('Archive after replying', () => {
  it('archives the Inbox message once the reply is sent', async () => {
    await replyAndSend();
    await waitFor(() => expect(archivedIds()).toEqual(['m1']));
  });

  it('archives without asking, even with "Confirm before archiving" on', async () => {
    useSettingsStore.setState({ confirmArchive: true } as never);
    await replyAndSend();
    await waitFor(() => expect(archivedIds()).toEqual(['m1']));
    expect(screen.queryByRole('alertdialog')).toBeNull();
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('archives after a forward too', async () => {
    await replyAndSend('stub forward');
    await waitFor(() => expect(archivedIds()).toEqual(['m1']));
  });

  it('does nothing with the setting off', async () => {
    useSettingsStore.setState({ archiveAfterReply: false } as never);
    await replyAndSend();
    await settle();
    expect(archivedIds()).toEqual([]);
  });

  it('leaves a message that is not in the Inbox where it is', async () => {
    openWith(original({ work: true }));
    await replyAndSend();
    await settle();
    expect(archivedIds()).toEqual([]);
  });

  it('does nothing when the admin has turned Archive off', async () => {
    usePolicyStore.setState((state) => ({
      policy: { ...state.policy, features: { ...state.policy.features, archiveActionEnabled: false } },
    }));
    await replyAndSend();
    await settle();
    expect(archivedIds()).toEqual([]);
  });

  it('keeps the original while the reply waits in the offline outbox, and says so', async () => {
    sendEmail.mockResolvedValue({ scheduled: false, queued: true });
    await replyAndSend();
    await waitFor(() => expect(useToastStore.getState().toasts.some((t) => t.title === 'email_composer.archive_after_reply_queued')).toBe(true));
    expect(archivedIds()).toEqual([]);
  });

  it('waits for the undo window, then archives', async () => {
    sendEmail.mockImplementation(async () => (
      { scheduled: true, emailId: 'sent-2', emailSubmissionId: 's2', sendAt: new Date(Date.now() + 600).toISOString() }
    ));
    await replyAndSend();
    await settle();
    expect(archivedIds()).toEqual([]);
    await waitFor(() => expect(archivedIds()).toEqual(['m1']), { timeout: 3000 });
  }, 15_000);

  it('keeps the original when the reply is undone', async () => {
    sendEmail.mockImplementation(async () => {
      const sendAt = new Date(Date.now() + 1500).toISOString();
      useEmailStore.setState({
        pendingUndoSend: { submissionId: 's3', emailId: 'sent-3', identityId: 'id-1', sendAt, isSmime: false },
      } as never);
      return { scheduled: true, emailId: 'sent-3', emailSubmissionId: 's3', sendAt };
    });
    await replyAndSend();
    const undoToast = () => useToastStore.getState().toasts.find((t) => t.action?.label === 'email_viewer.undo_send');
    await waitFor(() => expect(undoToast()).toBeDefined());
    act(() => { undoToast()!.action!.onClick(); });
    await waitFor(() => expect(cancelUndoSend).toHaveBeenCalled());
    await act(() => new Promise((r) => setTimeout(r, 1800)));
    expect(archivedIds()).toEqual([]);
  }, 15_000);
});
