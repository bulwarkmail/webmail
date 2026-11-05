import React, { Suspense, lazy } from 'react';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Mailbox } from '@/lib/jmap/types';
import { useAuthStore } from '@/stores/auth-store';
import { useEmailStore } from '@/stores/email-store';
import { useSettingsStore } from '@/stores/settings-store';
import { usePluginStore } from '@/stores/plugin-store';
import { useThemeStore } from '@/stores/theme-store';
import { useToastStore } from '@/stores/toast-store';
import { DEFAULT_SEARCH_FILTERS } from '@/lib/jmap/search-utils';
import { emailHooks, clearAllHooks } from '@/lib/plugin-hooks';
import { resetAnnouncedSends } from '@/lib/plugin-after-send';

// onAfterEmailSend: once the server accepted the message, never for a failed
// send or one taken back with Undo.

vi.mock('next/dynamic', () => ({ default: (load: () => Promise<React.ComponentType<Record<string, unknown>>>) => {
  const Component = lazy(async () => ({ default: await load() }));
  return function Dynamic(props: Record<string, unknown>) {
    return <Suspense fallback={null}><Component {...props} /></Suspense>;
  };
} }));
const sendData = vi.hoisted(() => ({ delayedUntil: undefined as string | undefined, error: null as unknown }));
vi.mock('@/components/email/email-composer', () => ({
  EmailComposer: ({ onSend }: { onSend?: (data: unknown) => Promise<void> }) => (
    <button onClick={() => {
      onSend?.({ to: ['bob@example.com'], cc: ['carol@example.com'], bcc: [], subject: 'Hi', body: 'Hello', delayedUntil: sendData.delayedUntil, composerId: 'composer-1' })
        .catch((e) => { sendData.error = e; });
    }}>
      stub send
    </button>
  ),
}));
// A desktop has Compose in the folder sidebar (mail-13, mail-p3-11).
vi.mock('@/components/layout/sidebar', () => ({
  Sidebar: ({ onCompose }: { onCompose?: () => void }) => <button type="button" onClick={onCompose}>sidebar.compose</button>,
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

const inbox = { id: 'inbox', name: 'Inbox', role: 'inbox' } as Mailbox;
const cancelUndoSend = vi.fn();
const sendEmail = vi.fn();
const refreshScheduledMetadata = vi.fn();

beforeEach(() => {
  vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('Unexpected network request')));
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} });
  usePluginStore.setState({ initializePlugins: vi.fn().mockResolvedValue(undefined) });
  useThemeStore.setState({ syncServerThemes: vi.fn().mockResolvedValue(undefined) });
  useToastStore.setState({ toasts: [] });
  const client = {
    getAccountId: () => 'acc', getUsername: () => 'me@example.com',
    getSieveAccountId: () => null, hasDelayedSend: () => true, getSession: () => null,
  };
  useAuthStore.setState({
    isAuthenticated: true, isLoading: false, client: client as never, activeAccountId: 'login', identities: [],
    getClientForAccount: () => client as never,
    getAllConnectedClients: () => new Map([['login', client]]) as never,
  });
  useSettingsStore.setState({ enableUnifiedMailbox: false, mailLayout: 'split', sendDelaySeconds: 30 } as never);
  cancelUndoSend.mockReset();
  sendEmail.mockReset();
  clearAllHooks();
  resetAnnouncedSends();
  sendData.delayedUntil = undefined;
  sendData.error = null;
  refreshScheduledMetadata.mockReset().mockResolvedValue(undefined);
  useEmailStore.setState({
    emails: [], selectedEmail: null, selectedMailbox: inbox.id, mailboxes: [inbox],
    viewingAccountId: null, accountMailboxes: {}, isUnifiedView: false, unifiedRole: null,
    isScheduledView: false, isLoadingEmail: false, isLoading: false, searchQuery: '',
    searchFilters: { ...DEFAULT_SEARCH_FILTERS }, searchMailboxId: '', selectedKeyword: null,
    selectedEmailKeys: new Set(),
    fetchMailboxes: vi.fn().mockResolvedValue(undefined), fetchEmails: vi.fn().mockResolvedValue(undefined),
    fetchQuota: vi.fn().mockResolvedValue(undefined), fetchTagCounts: vi.fn().mockResolvedValue(undefined),
    refreshScheduledMetadata,
    cancelUndoSend,
    sendEmail,
    clearPendingUndoSend: () => useEmailStore.setState({ pendingUndoSend: null }),
    pendingUndoSend: null,
  } as never);
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});


async function sendFromComposer() {
  render(<MailApp />);
  fireEvent.click(screen.getByRole('button', { name: 'sidebar.compose' }));
  fireEvent.click(await screen.findByText('stub send', {}, { timeout: 5000 }));
  await waitFor(() => expect(sendEmail).toHaveBeenCalled());
}

const undoToast = () => useToastStore.getState().toasts.find((t) => t.action?.label === 'email_viewer.undo_send');

describe('onAfterEmailSend', () => {
  it('reports a send the server accepted', async () => {
    useSettingsStore.setState({ sendDelaySeconds: 0 } as never);
    const sent = vi.fn();
    emailHooks.onAfterEmailSend.register('test', sent);
    sendEmail.mockResolvedValue({ scheduled: false, emailId: 'e1', emailAccountId: 'acc', emailSubmissionId: 's1' });

    await sendFromComposer();

    await waitFor(() => expect(sent).toHaveBeenCalledTimes(1));
    expect(sent).toHaveBeenCalledWith({
      emailId: 'e1', accountId: 'acc', submissionId: 's1', to: ['bob@example.com'], cc: ['carol@example.com'], bcc: [],
      subject: 'Hi', scheduledFor: null, composerId: 'composer-1',
    });
  });

  it('says nothing when the send fails', async () => {
    const sent = vi.fn();
    emailHooks.onAfterEmailSend.register('test', sent);
    sendEmail.mockRejectedValue(new Error('refused'));
    vi.spyOn(console, 'error').mockImplementation(() => {});

    await sendFromComposer();
    await waitFor(() => expect(sendData.error).not.toBeNull());

    expect(sent).not.toHaveBeenCalled();
  });

  it('reports a scheduled send at once, with its time', async () => {
    const sent = vi.fn();
    emailHooks.onAfterEmailSend.register('test', sent);
    sendData.delayedUntil = '2030-01-01T08:00:00.000Z';
    sendEmail.mockResolvedValue({ scheduled: true, emailId: 'e2', emailSubmissionId: 's2', sendAt: '2030-01-01T08:00:00Z' });

    await sendFromComposer();

    await waitFor(() => expect(sent).toHaveBeenCalledTimes(1));
    expect(sent).toHaveBeenCalledWith(expect.objectContaining({ emailId: 'e2', scheduledFor: '2030-01-01T08:00:00Z' }));
  });

  it('waits out the undo window, and says nothing when the send is undone', async () => {
    const sent = vi.fn();
    emailHooks.onAfterEmailSend.register('test', sent);
    let sendAt = '';
    sendEmail.mockImplementation(async () => {
      sendAt = new Date(Date.now() + 1500).toISOString();
      useEmailStore.setState({
        pendingUndoSend: { submissionId: 's3', emailId: 'e3', identityId: 'id-1', sendAt, isSmime: false },
      } as never);
      return { scheduled: true, emailId: 'e3', emailSubmissionId: 's3', sendAt };
    });
    cancelUndoSend.mockResolvedValue(null);

    await sendFromComposer();
    expect(sent).not.toHaveBeenCalled();

    await waitFor(() => expect(undoToast()).toBeDefined());
    act(() => { undoToast()!.action!.onClick(); });
    await waitFor(() => expect(cancelUndoSend).toHaveBeenCalled());

    await act(() => new Promise((r) => setTimeout(r, 1800)));
    expect(sent).not.toHaveBeenCalled();
  }, 15_000);

  it('reports a held send once the undo window is over', async () => {
    const sent = vi.fn();
    emailHooks.onAfterEmailSend.register('test', sent);
    sendEmail.mockImplementation(async () => (
      { scheduled: true, emailId: 'e4', emailSubmissionId: 's4', sendAt: new Date(Date.now() + 1000).toISOString() }
    ));

    await sendFromComposer();
    expect(sent).not.toHaveBeenCalled();

    await waitFor(() => expect(sent).toHaveBeenCalledTimes(1), { timeout: 3000 });
    expect(sent).toHaveBeenCalledWith(expect.objectContaining({ emailId: 'e4', submissionId: 's4', scheduledFor: null }));
  }, 15_000);
});
