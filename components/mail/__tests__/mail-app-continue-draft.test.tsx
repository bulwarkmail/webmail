import React from 'react';
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

// The "Continue draft" bar and clicking another message while writing: the
// bar's X is its own button and deletes the saved draft, with Undo; another
// message closes the composer the way its X does (it keeps the draft).

const device = vi.hoisted(() => ({ current: { isMobile: false, isTablet: false, isDesktop: true } }));
const stub = vi.hoisted(() => ({ requestClose: null as null | ((afterClose?: () => void) => void) }));

vi.mock('@/components/layout/mv-top-bar', () => ({ MvTopBar: () => null }));
vi.mock('@/components/layout/sidebar', () => ({
  Sidebar: ({ onCompose }: { onCompose: () => void }) => <button onClick={onCompose}>stub compose</button>,
}));
// The composer hands its draft to the host as it unmounts, and offers the
// host its close when the test says so.
vi.mock('@/components/email/email-composer', async () => {
  const { useEffect } = await import('react');
  return {
    EmailComposer: ({ onSaveState, requestCloseRef }: {
      onSaveState: (data: Record<string, unknown>) => void;
      requestCloseRef?: { current: unknown };
    }) => {
      useEffect(() => {
        if (requestCloseRef && stub.requestClose) requestCloseRef.current = stub.requestClose;
        return () => {
          if (requestCloseRef) requestCloseRef.current = null;
          onSaveState({ subject: 'Parked', draftId: 'draft-7', draftAccountId: 'acc', mode: 'compose' });
        };
        // eslint-disable-next-line react-hooks/exhaustive-deps
      }, []);
      return <div>stub composer</div>;
    },
  };
});
vi.mock('@/components/search/mv-search-form', () => ({
  MvSearchForm: ({ onSearch }: { onSearch: () => void }) => <button onClick={onSearch}>stub filter search</button>,
}));
vi.mock('@/components/email/email-viewer', () => ({ EmailViewer: () => <div>message viewer</div> }));
vi.mock('@/components/layout/navigation-rail', () => ({ NavigationRail: () => null }));
vi.mock('@/components/layout/calendar-event-notification-toaster', () => ({ CalendarEventNotificationToaster: () => null }));
vi.mock('@/components/layout/share-notification-toaster', () => ({ ShareNotificationToaster: () => null }));
vi.mock('@/components/layout/mobile-header', () => ({ MobileHeader: () => null }));
vi.mock('@/components/layout/mv-side-panel', () => ({ MvSidePanel: () => null }));
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
  useDeviceDetection: () => device.current,
  useMediaQuery: () => false,
  useIsDesktop: () => true,
}));
vi.mock('@/lib/push-bindings', () => ({ reconcilePushBindings: () => {}, releasePushBindings: () => {} }));
vi.mock('@/components/email/email-list', () => ({
  EmailList: ({ onEmailSelect }: { onEmailSelect: (email: { id: string }) => void }) => (
    <button onClick={() => void onEmailSelect({ id: 'other-mail' })}>stub other mail</button>
  ),
}));


const { MailApp } = await import('../mail-app');

const inbox = { id: 'inbox', name: 'Inbox', role: 'inbox', totalEmails: 0, unreadEmails: 0 } as Mailbox;
let deleteEmail: ReturnType<typeof vi.fn>;

beforeEach(() => {
  device.current = { isMobile: false, isTablet: false, isDesktop: true };
  stub.requestClose = null;
  vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('Unexpected network request')));
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} });
  usePluginStore.setState({ initializePlugins: vi.fn().mockResolvedValue(undefined) });
  useThemeStore.setState({ syncServerThemes: vi.fn().mockResolvedValue(undefined) });
  deleteEmail = vi.fn().mockResolvedValue(undefined);
  const client = {
    getAccountId: () => 'acc', getUsername: () => 'a@example.org',
    getSieveAccountId: () => null, hasDelayedSend: () => false, getSession: () => null,
    deleteEmail,
    getEmail: vi.fn().mockResolvedValue(null),
  };
  useAuthStore.setState({
    isAuthenticated: true, isLoading: false, client: client as never, activeAccountId: 'login-a', identities: [],
    getClientForAccount: () => client as never,
    getAllConnectedClients: () => new Map([['login-a', client]]) as never,
  });
  useSettingsStore.setState({ enableUnifiedMailbox: false, interfaceLayout: 'default', mailLayout: 'split' } as never);
  useEmailStore.setState({
    emails: [], selectedEmail: null, selectedMailbox: 'inbox', selectedKeyword: null, mailboxes: [inbox],
    viewingAccountId: null, accountMailboxes: {}, isUnifiedView: false, unifiedRole: null,
    isScheduledView: false, isLoadingEmail: false, isLoading: false, searchQuery: '',
    searchFilters: { ...DEFAULT_SEARCH_FILTERS }, searchMailboxId: '', isAdvancedSearchOpen: false,
    selectedEmailKeys: new Set(), unreadSection: null,
    fetchMailboxes: vi.fn().mockResolvedValue(undefined), fetchEmails: vi.fn().mockResolvedValue(undefined),
    fetchQuota: vi.fn().mockResolvedValue(undefined), fetchTagCounts: vi.fn().mockResolvedValue(undefined),
    refreshScheduledMetadata: vi.fn().mockResolvedValue(undefined),
  } as never);
  useToastStore.getState().clearToasts();
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  useToastStore.getState().clearToasts();
});

async function parkDraft() {
  render(<MailApp />);
  fireEvent.click(screen.getByText('stub compose'));
  await screen.findByText('stub composer');
  // No close offered: the composer unmounts and parks its draft.
  fireEvent.click(screen.getByText('stub other mail'));
  await screen.findByText('email_composer.continue_draft');
}

const discardButton = () => screen.getByRole('button', { name: 'discard_draft' });

describe('the Continue draft bar', () => {
  it('has a Discard button of its own, outside the bar button', async () => {
    await parkDraft();
    expect(discardButton().parentElement?.closest('button')).toBeNull();
  });

  it('deletes the saved draft once the Undo window is over', async () => {
    await parkDraft();
    vi.useFakeTimers({ shouldAdvanceTime: true });
    fireEvent.click(discardButton());
    expect(screen.queryByText('email_composer.continue_draft')).toBeNull();
    const undoToast = useToastStore.getState().toasts.find((t) => t.title === 'draft_discarded');
    expect(undoToast?.action?.label).toBe('undo');
    expect(deleteEmail).not.toHaveBeenCalled();
    await act(async () => { await vi.advanceTimersByTimeAsync(undoToast!.duration! + 10); });
    expect(deleteEmail).toHaveBeenCalledWith('draft-7', 'acc');
  });

  it('brings the bar back on Undo and keeps the draft', async () => {
    await parkDraft();
    vi.useFakeTimers({ shouldAdvanceTime: true });
    fireEvent.click(discardButton());
    const undoToast = useToastStore.getState().toasts.find((t) => t.title === 'draft_discarded')!;
    act(() => undoToast.action!.onClick());
    expect(await screen.findByText('email_composer.continue_draft')).toBeInTheDocument();
    await act(async () => { await vi.advanceTimersByTimeAsync(60_000); });
    expect(deleteEmail).not.toHaveBeenCalled();
  });
});

describe('another message clicked while writing', () => {
  it('closes the composer through its own close, which keeps the draft', async () => {
    const requestClose = vi.fn();
    stub.requestClose = requestClose;
    render(<MailApp />);
    fireEvent.click(screen.getByText('stub compose'));
    await screen.findByText('stub composer');

    fireEvent.click(screen.getByText('stub other mail'));

    await waitFor(() => expect(requestClose).toHaveBeenCalledTimes(1));
    // Still there until it has saved and closes itself; no bar.
    expect(screen.getByText('stub composer')).toBeInTheDocument();
    expect(screen.queryByText('email_composer.continue_draft')).toBeNull();
  });
});
