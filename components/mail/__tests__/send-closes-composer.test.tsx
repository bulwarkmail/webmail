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

// compose-24: after Send the composer stayed on screen, greyed and without a
// word, until the server answered. It closes at once now, "Sending…" and then
// "Sent · View" say what happens, and a send that fails brings the text back.
vi.mock('next/dynamic', () => ({ default: (load: () => Promise<React.ComponentType<Record<string, unknown>>>) => {
  const Component = lazy(async () => ({ default: await load() }));
  return function Dynamic(props: Record<string, unknown>) {
    return <Suspense fallback={null}><Component {...props} /></Suspense>;
  };
} }));
vi.mock('@/components/email/email-composer', () => ({
  EmailComposer: ({ onSend, onSendFailed, initialData }: {
    onSend?: (data: unknown) => Promise<void>;
    onSendFailed?: (state: unknown) => void;
    initialData?: { subject?: string } | null;
  }) => (
    <div>
      <span>stub subject: {initialData?.subject ?? ''}</span>
      <button onClick={() => {
        // As the composer does: what it handed over comes back on a failure.
        onSend?.({ to: ['bob@example.com'], cc: [], bcc: [], subject: 'Hi', body: 'Hello' })
          ?.catch(() => onSendFailed?.({ to: 'bob@example.com', cc: '', bcc: '', subject: 'Hi', body: 'Hello', mode: 'compose' }));
      }}>
        stub send
      </button>
    </div>
  ),
}));
vi.mock('@/components/layout/sidebar', () => ({ Sidebar: () => null }));
vi.mock('@/components/layout/navigation-rail', () => ({ NavigationRail: () => null }));
vi.mock('@/components/layout/calendar-event-notification-toaster', () => ({ CalendarEventNotificationToaster: () => null }));
vi.mock('@/components/layout/share-notification-toaster', () => ({ ShareNotificationToaster: () => null }));
vi.mock('@/components/layout/mobile-header', () => ({
  MobileHeader: ({ onOpenSearch }: { onOpenSearch?: () => void }) => <button onClick={onOpenSearch}>stub open search</button>,
}));
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
const sendEmail = vi.fn();

beforeEach(() => {
  vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('Unexpected network request')));
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} });
  usePluginStore.setState({ initializePlugins: vi.fn().mockResolvedValue(undefined) });
  useThemeStore.setState({ syncServerThemes: vi.fn().mockResolvedValue(undefined) });
  const client = {
    getAccountId: () => 'acc', getUsername: () => 'me@example.com',
    getSieveAccountId: () => null, hasDelayedSend: () => false, getSession: () => null,
  };
  useAuthStore.setState({
    isAuthenticated: true, isLoading: false, client: client as never, activeAccountId: 'login', identities: [],
    getClientForAccount: () => client as never,
    getAllConnectedClients: () => new Map([['login', client]]) as never,
  });
  useSettingsStore.setState({ enableUnifiedMailbox: false, mailLayout: 'split', sendDelaySeconds: 0 } as never);
  sendEmail.mockReset().mockResolvedValue({});
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
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

const toastTitled = (title: string) => useToastStore.getState().toasts.find((t) => t.title === title);

async function openComposer() {
  render(<MailApp />);
  fireEvent.click(screen.getByRole('button', { name: 'sidebar.compose' }));
  await screen.findByText('stub send', {}, { timeout: 5000 });
}

describe('sending', () => {
  it('closes the composer at once and says "Sending…", then "Sent" with View', async () => {
    let finish: (result: unknown) => void = () => {};
    sendEmail.mockReturnValue(new Promise((resolve) => { finish = resolve; }));
    await openComposer();

    fireEvent.click(screen.getByText('stub send'));

    // The server hasn't answered yet.
    await waitFor(() => expect(screen.queryByText('stub send')).not.toBeInTheDocument());
    expect(sendEmail).toHaveBeenCalled();
    expect(toastTitled('compose_send.sending')).toBeDefined();

    await act(async () => { finish({ scheduled: false, emailId: 'sent-1' }); });

    await waitFor(() => expect(toastTitled('compose_send.sent')).toBeDefined());
    expect(toastTitled('compose_send.sent')!.action?.label).toBe('compose_send.view');
    expect(toastTitled('compose_send.sending')).toBeUndefined();
  });

  it('opens the composer again with the text when the send fails', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    sendEmail.mockRejectedValue(new Error('refused'));
    await openComposer();

    fireEvent.click(screen.getByText('stub send'));

    expect(await screen.findByText('stub subject: Hi', {}, { timeout: 5000 })).toBeInTheDocument();
    expect(toastTitled('compose_send.sending')).toBeUndefined();
    expect(toastTitled('compose_send.sent')).toBeUndefined();
  });

  it('leaves a delayed send to the undo toast', async () => {
    sendEmail.mockResolvedValue({ scheduled: true, emailSubmissionId: 'sub-1', sendAt: new Date(Date.now() + 5000).toISOString() });
    await openComposer();

    fireEvent.click(screen.getByText('stub send'));

    await waitFor(() => expect(sendEmail).toHaveBeenCalled());
    await waitFor(() => expect(toastTitled('compose_send.sending')).toBeUndefined());
    expect(toastTitled('compose_send.sent')).toBeUndefined();
    expect(screen.queryByText('stub send')).not.toBeInTheDocument();
  });
});
