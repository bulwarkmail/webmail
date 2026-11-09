import React from 'react';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Email, Mailbox } from '@/lib/jmap/types';
import { useAuthStore } from '@/stores/auth-store';
import { useEmailStore } from '@/stores/email-store';
import { useSettingsStore } from '@/stores/settings-store';
import { usePluginStore } from '@/stores/plugin-store';
import { useThemeStore } from '@/stores/theme-store';
import { DEFAULT_SEARCH_FILTERS } from '@/lib/jmap/search-utils';

// Mountain View shows an open message in place of the list. A search started
// from the top bar while reading has to close it, or the results land in a
// list nobody can see until they press back. (#1468)

type TopBarSearch = {
  onSubmit: (query: string) => void;
  onSelectContact: (contact: { email: string; name?: string }, field: 'from' | 'to') => void;
};
vi.mock('@/components/layout/mv-top-bar', () => ({
  MvTopBar: ({ search }: { search: TopBarSearch }) => (
    <>
      <button onClick={() => search.onSubmit('invoice')}>stub search</button>
      <button onClick={() => search.onSelectContact({ email: 'bob@example.org' }, 'from')}>stub contact</button>
      <input aria-label="stub search field" data-search-input />
    </>
  ),
}));
vi.mock('@/components/search/mv-search-form', () => ({
  MvSearchForm: ({ onSearch }: { onSearch: () => void }) => <button onClick={onSearch}>stub filter search</button>,
}));
vi.mock('@/components/email/email-viewer', () => ({ EmailViewer: () => <div>message viewer</div> }));
vi.mock('@/components/email/email-composer', () => ({ EmailComposer: () => null }));
vi.mock('@/components/layout/sidebar', () => ({ Sidebar: () => null }));
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
  useDeviceDetection: () => ({ isMobile: false, isTablet: false, isDesktop: true }),
  useMediaQuery: () => false,
  useIsDesktop: () => true,
}));
vi.mock('@/lib/push-bindings', () => ({ reconcilePushBindings: () => {}, releasePushBindings: () => {} }));
vi.mock('@/components/email/email-list', () => ({ EmailList: () => <div>message list</div> }));

const { MailApp } = await import('../mail-app');

const inbox = { id: 'inbox', name: 'Inbox', role: 'inbox', totalEmails: 2, unreadEmails: 0 } as Mailbox;
const row = (id: string) => ({
  id, threadId: `t-${id}`, subject: id, receivedAt: '2026-10-31T10:00:00Z', keywords: { $seen: true }, mailboxIds: { inbox: true },
}) as unknown as Email;

let searchEmails: ReturnType<typeof vi.fn>;
let advancedSearch: ReturnType<typeof vi.fn>;

beforeEach(() => {
  vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('Unexpected network request')));
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} });
  usePluginStore.setState({ initializePlugins: vi.fn().mockResolvedValue(undefined) });
  useThemeStore.setState({ syncServerThemes: vi.fn().mockResolvedValue(undefined) });
  const client = {
    getAccountId: () => 'acc', getUsername: () => 'a@example.org',
    getSieveAccountId: () => null, hasDelayedSend: () => false, getSession: () => null,
    getThread: vi.fn(async (threadId: string) => ({ id: threadId, emailIds: [threadId.slice(2)] })),
    getEmail: vi.fn(async (id: string) => ({ ...row(id), bodyValues: {} })),
    markAsRead: vi.fn().mockResolvedValue(undefined),
  };
  useAuthStore.setState({
    isAuthenticated: true, isLoading: false, client: client as never, activeAccountId: 'login-a', identities: [],
    getClientForAccount: () => client as never,
    getAllConnectedClients: () => new Map([['login-a', client]]) as never,
  });
  useSettingsStore.setState({ enableUnifiedMailbox: false, interfaceLayout: 'mountain-view', mailLayout: 'focus' } as never);
  searchEmails = vi.fn().mockResolvedValue(undefined);
  advancedSearch = vi.fn().mockResolvedValue(undefined);
  const emails = [row('m1'), row('m2')];
  useEmailStore.setState({
    emails, selectedEmail: emails[0], selectedMailbox: 'inbox', selectedKeyword: null, mailboxes: [inbox],
    viewingAccountId: null, accountMailboxes: {}, isUnifiedView: false, unifiedRole: null,
    isScheduledView: false, isLoadingEmail: false, isLoading: false, searchQuery: '',
    searchFilters: { ...DEFAULT_SEARCH_FILTERS }, searchMailboxId: '', isAdvancedSearchOpen: false,
    selectedEmailKeys: new Set(), unreadSection: null,
    fetchMailboxes: vi.fn().mockResolvedValue(undefined), fetchEmails: vi.fn().mockResolvedValue(undefined),
    fetchQuota: vi.fn().mockResolvedValue(undefined), fetchTagCounts: vi.fn().mockResolvedValue(undefined),
    refreshScheduledMetadata: vi.fn().mockResolvedValue(undefined),
    fetchEmailContent: vi.fn().mockResolvedValue(undefined),
    searchEmails, advancedSearch,
  } as never);
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

const selectedId = () => useEmailStore.getState().selectedEmail?.id ?? null;

describe('searching in Mountain View while a message is open', () => {
  it('closes the message and runs the search from the top bar', async () => {
    render(<MailApp />);
    expect(selectedId()).toBe('m1');
    fireEvent.click(screen.getByText('stub search'));
    await waitFor(() => expect(searchEmails).toHaveBeenCalledWith(expect.anything(), 'invoice'));
    expect(selectedId()).toBeNull();
  });

  it('closes the message for a contact picked from the suggestions', async () => {
    render(<MailApp />);
    fireEvent.click(screen.getByText('stub contact'));
    await waitFor(() => expect(advancedSearch).toHaveBeenCalled());
    expect(selectedId()).toBeNull();
  });

  it('closes the message for a search from the filter form', async () => {
    useEmailStore.setState({ isAdvancedSearchOpen: true } as never);
    render(<MailApp />);
    fireEvent.click(screen.getByText('stub filter search'));
    await waitFor(() => expect(advancedSearch).toHaveBeenCalled());
    expect(selectedId()).toBeNull();
  });

  it('leaves the message open for the / shortcut, whose field is in the top bar', async () => {
    render(<MailApp />);
    await screen.findByText('message viewer');
    act(() => { fireEvent.keyDown(window, { key: '/' }); });
    await waitFor(() => expect(document.activeElement).toBe(screen.getByLabelText('stub search field')));
    // Long enough for a go-back that runs after the field is focused.
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 50)); });
    expect(selectedId()).toBe('m1');
  });
});
