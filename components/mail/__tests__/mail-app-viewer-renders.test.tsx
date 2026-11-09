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

// The reading pane draws again only when what it shows changes: a search, a
// folder switch or a list update re-render the mail page around the same open
// message, and drew the whole viewer again each time.

vi.mock('next/dynamic', () => ({ default: (load: () => Promise<React.ComponentType<Record<string, unknown>>>) => {
  const Component = lazy(async () => ({ default: await load() }));
  return function Dynamic(props: Record<string, unknown>) {
    return <Suspense fallback={null}><Component {...props} /></Suspense>;
  };
} }));
const viewerRenders = vi.hoisted(() => ({ count: 0 }));
vi.mock('@/components/email/email-viewer', () => ({
  EmailViewer: ({ onDelete, email }: { onDelete?: () => void; email?: { subject?: string } | null }) => {
    viewerRenders.count++;
    return <button onClick={() => onDelete?.()}>stub delete {email?.subject}</button>;
  },
}));
vi.mock('@/components/email/email-composer', () => ({ EmailComposer: () => null }));
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
    id, name: role, role, sortOrder: 0, totalEmails: 1, unreadEmails: 1, totalThreads: 1, unreadThreads: 1, isSubscribed: true,
  } as Mailbox;
}
const folders = [mailbox('inbox', 'inbox'), mailbox('trash', 'trash')];
const unread = {
  id: 'm1', threadId: 't1', subject: 'Hello', receivedAt: '2026-10-26T10:00:00Z',
  keywords: {}, mailboxIds: { inbox: true },
} as unknown as Email;

let client: Record<string, ReturnType<typeof vi.fn> | (() => unknown)>;

beforeEach(() => {
  vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('Unexpected network request')));
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} });
  usePluginStore.setState({ initializePlugins: vi.fn().mockResolvedValue(undefined) });
  useThemeStore.setState({ syncServerThemes: vi.fn().mockResolvedValue(undefined) });
  useToastStore.setState({ toasts: [] });
  clearAllHooks();
  client = {
    getAccountId: () => 'acc', getUsername: () => 'a@example.org',
    getSieveAccountId: () => null, hasDelayedSend: () => false, getSession: () => null,
    getMailboxes: vi.fn().mockResolvedValue(folders),
    moveToTrash: vi.fn().mockResolvedValue(undefined),
    moveEmail: vi.fn().mockResolvedValue(undefined),
    deleteEmail: vi.fn().mockResolvedValue(undefined),
  };
  useAuthStore.setState({
    isAuthenticated: true, isLoading: false, client: client as never, activeAccountId: 'login-a', identities: [],
    getClientForAccount: (id: string) => (id === 'login-a' ? client : undefined) as never,
    getAllConnectedClients: () => new Map([['login-a', client]]) as never,
  });
  useSettingsStore.setState({ enableUnifiedMailbox: false, mailLayout: 'split', permanentlyDeleteJunk: false } as never);
  useEmailStore.setState({
    emails: [unread], selectedEmail: unread, selectedMailbox: 'inbox', selectedKeyword: null, mailboxes: folders,
    viewingAccountId: null, accountMailboxes: {}, isUnifiedView: false, unifiedRole: null,
    isScheduledView: false, isLoadingEmail: false, isLoading: false, searchQuery: '',
    searchFilters: { ...DEFAULT_SEARCH_FILTERS }, searchMailboxId: '',
    selectedEmailKeys: new Set(),
    fetchMailboxes: vi.fn().mockResolvedValue(undefined), fetchEmails: vi.fn().mockResolvedValue(undefined),
    fetchQuota: vi.fn().mockResolvedValue(undefined), fetchTagCounts: vi.fn().mockResolvedValue(undefined),
    refreshScheduledMetadata: vi.fn().mockResolvedValue(undefined),
  } as never);
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

const other = { ...unread, id: 'm2', threadId: 't2', subject: 'Other' } as unknown as Email;

describe('the reading pane around an unchanged message', () => {
  it('does not draw again for list updates or a search', async () => {
    useSettingsStore.setState({ deleteAction: 'trash' } as never);
    render(<MailApp />);
    await screen.findByText('stub delete Hello', {}, { timeout: 5000 });
    act(() => { useEmailStore.setState({ emails: [unread, other] }); });
    // Let the mount settle (late effects, the folder list).
    await new Promise((r) => setTimeout(r, 300));
    const before = viewerRenders.count;

    act(() => { useEmailStore.setState({ emails: [unread, { ...other }] }); });
    act(() => { useEmailStore.setState({ searchQuery: 'report', isLoading: true }); });
    act(() => { useEmailStore.setState({ isLoading: false, emails: [unread, other] }); });
    act(() => { useEmailStore.setState({ searchQuery: '' }); });
    expect(viewerRenders.count).toBe(before);

    // Its handlers still act on the message on screen.
    fireEvent.click(screen.getByText('stub delete Hello'));
    await waitFor(() => expect(client.moveToTrash).toHaveBeenCalled());
    expect((client.moveToTrash as ReturnType<typeof vi.fn>).mock.calls[0][0]).toBe('m1');
  });

  it('draws again when another message opens', async () => {
    render(<MailApp />);
    await screen.findByText('stub delete Hello', {}, { timeout: 5000 });
    act(() => { useEmailStore.setState({ selectedEmail: other }); });
    expect(await screen.findByText('stub delete Other')).toBeTruthy();
  });
});
