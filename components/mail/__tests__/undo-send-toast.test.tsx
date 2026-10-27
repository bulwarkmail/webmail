import React, { Suspense, lazy } from 'react';
import { act, render, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Mailbox } from '@/lib/jmap/types';
import { useAuthStore } from '@/stores/auth-store';
import { useEmailStore } from '@/stores/email-store';
import { useSettingsStore } from '@/stores/settings-store';
import { usePluginStore } from '@/stores/plugin-store';
import { useThemeStore } from '@/stores/theme-store';
import { useToastStore } from '@/stores/toast-store';
import { DEFAULT_SEARCH_FILTERS } from '@/lib/jmap/search-utils';

// The Undo send toast outlived the send-delay window: hovering paused it, and
// a click after the release failed without a word.
vi.mock('next/dynamic', () => ({ default: (load: () => Promise<React.ComponentType<Record<string, unknown>>>) => {
  const Component = lazy(async () => ({ default: await load() }));
  return function Dynamic(props: Record<string, unknown>) {
    return <Suspense fallback={null}><Component {...props} /></Suspense>;
  };
} }));
vi.mock('@/components/email/email-composer', () => ({
  EmailComposer: ({ onSend }: { onSend?: (data: unknown) => Promise<void> }) => (
    <button onClick={() => void onSend?.({ to: ['bob@example.com'], cc: [], bcc: [], subject: 'Hi', body: 'Hello' })}>
      stub send
    </button>
  ),
}));
vi.mock('@/components/layout/sidebar', () => ({ Sidebar: () => null }));
vi.mock('@/components/layout/navigation-rail', () => ({ NavigationRail: () => null }));
vi.mock('@/components/layout/calendar-event-notification-toaster', () => ({ CalendarEventNotificationToaster: () => null }));
vi.mock('@/components/layout/share-notification-toaster', () => ({ ShareNotificationToaster: () => null }));
vi.mock('@/components/layout/mobile-header', () => ({ MobileHeader: () => null }));
vi.mock('@/components/email/message-list-tabs', () => ({ MessageListTabs: () => null }));
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
    clearPendingUndoSend: () => useEmailStore.setState({ pendingUndoSend: null }),
    pendingUndoSend: null,
  } as never);
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

/** A delayed send the server will release `inMs` from now. */
function sendDelayedBy(inMs: number) {
  act(() => {
    useEmailStore.setState({
      pendingUndoSend: {
        submissionId: 'sub-1', emailId: 'email-1', identityId: 'id-1',
        sendAt: new Date(Date.now() + inMs).toISOString(), isSmime: false,
      },
    } as never);
  });
}

const undoToast = () => useToastStore.getState().toasts.find((t) => t.action?.label === 'email_viewer.undo_send');

describe('undo send toast', () => {
  it('ends before the server releases the message and does not pause on hover', async () => {
    render(<MailApp />);
    sendDelayedBy(10_000);

    await waitFor(() => expect(undoToast()).toBeDefined());
    const toast = undoToast()!;
    expect(toast.title).toBe('email_viewer.sending_in');
    // 30 s is the setting, but only 10 s are left of the window.
    expect(toast.duration).toBeLessThan(10_000);
    expect(toast.pauseOnHover).toBe(false);
  });

  it('says so when the undo comes too late', async () => {
    cancelUndoSend.mockRejectedValue(new Error('The requested message is no longer in the queue.'));
    vi.spyOn(console, 'error').mockImplementation(() => {});
    render(<MailApp />);
    sendDelayedBy(10_000);
    await waitFor(() => expect(undoToast()).toBeDefined());

    act(() => { undoToast()!.action!.onClick(); });

    await waitFor(() => expect(useToastStore.getState().toasts.some((t) => t.type === 'error' && t.title === 'email_viewer.undo_send_failed')).toBe(true));
  });

  // Sent through login B, which is signed out before Undo is clicked. The
  // submission id names another submission in the active login.
  describe('of a login that is gone', () => {
    beforeEach(() => {
      const active = useAuthStore.getState().client;
      const rescheduleEmailSubmission = vi.fn();
      Object.assign(active as object, { rescheduleEmailSubmission });
      useAuthStore.setState({ getClientForAccount: (id: string) => (id === 'login' ? active : undefined) as never });
    });
    function sendThroughGoneLogin() {
      act(() => {
        useEmailStore.setState({
          pendingUndoSend: {
            submissionId: 'sub-1', emailId: 'email-1', identityId: 'id-1', localAccountId: 'login-b',
            sendAt: new Date(Date.now() + 10_000).toISOString(), isSmime: false,
          },
        } as never);
      });
    }

    it('does not undo through the active login', async () => {
      render(<MailApp />);
      sendThroughGoneLogin();
      await waitFor(() => expect(undoToast()).toBeDefined());

      act(() => { undoToast()!.action!.onClick(); });

      await waitFor(() => expect(useToastStore.getState().toasts.some((t) => t.type === 'error' && t.title === 'email_viewer.undo_send_signed_out')).toBe(true));
      expect(cancelUndoSend).not.toHaveBeenCalled();
    });

    it('does not send now through the active login', async () => {
      render(<MailApp />);
      sendThroughGoneLogin();
      await waitFor(() => expect(undoToast()).toBeDefined());

      act(() => { undoToast()!.secondaryAction!.onClick(); });

      await waitFor(() => expect(useToastStore.getState().toasts.some((t) => t.type === 'error' && t.title === 'email_viewer.undo_send_signed_out')).toBe(true));
      expect((useAuthStore.getState().client as unknown as { rescheduleEmailSubmission: ReturnType<typeof vi.fn> }).rescheduleEmailSubmission).not.toHaveBeenCalled();
    });
  });
});
