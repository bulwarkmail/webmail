import React, { Suspense, lazy } from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
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

// mail-18: a toast says what happened once. "Moved to Family", not "Email
// moved. Moved to Family."; "Archived"; "Moved to Trash".

vi.mock('next/dynamic', () => ({ default: (load: () => Promise<React.ComponentType<Record<string, unknown>>>) => {
  const Component = lazy(async () => ({ default: await load() }));
  return function Dynamic(props: Record<string, unknown>) {
    return <Suspense fallback={null}><Component {...props} /></Suspense>;
  };
} }));
vi.mock('@/components/email/email-viewer', () => ({
  EmailViewer: ({ onDelete, onArchive, onMoveToMailbox }: { onDelete?: () => void; onArchive?: () => void; onMoveToMailbox?: (id: string) => void }) => (
    <>
      <button onClick={() => onDelete?.()}>stub delete</button>
      <button onClick={() => onArchive?.()}>stub archive</button>
      <button onClick={() => onMoveToMailbox?.('family')}>stub move</button>
    </>
  ),
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

const mailbox = (id: string, role: string | null, name = id): Mailbox => ({
  id, name, role, sortOrder: 0, totalEmails: 1, unreadEmails: 0, totalThreads: 1, unreadThreads: 0, isSubscribed: true,
} as Mailbox);
const folders = [mailbox('inbox', 'inbox'), mailbox('trash', 'trash'), mailbox('archive', 'archive'), mailbox('family', null, 'Family')];
const open = {
  id: 'm1', threadId: 't1', subject: 'Hello', receivedAt: '2026-10-26T10:00:00Z',
  keywords: { $seen: true }, mailboxIds: { inbox: true },
} as unknown as Email;

let client: Record<string, unknown>;

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
  };
  useAuthStore.setState({
    isAuthenticated: true, isLoading: false, client: client as never, activeAccountId: 'login-a', identities: [],
    getClientForAccount: (id: string) => (id === 'login-a' ? client : undefined) as never,
    getAllConnectedClients: () => new Map([['login-a', client]]) as never,
  });
  useSettingsStore.setState({ enableUnifiedMailbox: false, mailLayout: 'split', deleteAction: 'trash', archiveMode: 'single', confirmBulkDelete: false } as never);
  useEmailStore.setState({
    emails: [open], selectedEmail: open, selectedMailbox: 'inbox', selectedKeyword: null, mailboxes: folders,
    viewingAccountId: null, accountMailboxes: {}, isUnifiedView: false, unifiedRole: null,
    isScheduledView: false, isLoadingEmail: false, isLoading: false, searchQuery: '',
    searchFilters: { ...DEFAULT_SEARCH_FILTERS }, searchMailboxId: '',
    selectedEmailKeys: new Set(),
    fetchMailboxes: vi.fn().mockResolvedValue(undefined), fetchEmails: vi.fn().mockResolvedValue(undefined),
    fetchQuota: vi.fn().mockResolvedValue(undefined), fetchTagCounts: vi.fn().mockResolvedValue(undefined),
    refreshScheduledMetadata: vi.fn().mockResolvedValue(undefined),
    moveToMailboxCrossAware: vi.fn().mockResolvedValue(true),
    moveThreadToMailbox: vi.fn().mockResolvedValue(true),
  } as never);
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

const toastTitles = () => useToastStore.getState().toasts.map((t) => [t.title, t.message ?? null]);

describe('toasts after acting on the open message', () => {
  it('a move names the folder once', async () => {
    render(<MailApp />);
    fireEvent.click(await screen.findByText('stub move', {}, { timeout: 5000 }));
    await waitFor(() => expect(toastTitles()).toContainEqual(['mail_list_extra.moved_to', null]));
  });

  it('archiving says Archived', async () => {
    render(<MailApp />);
    fireEvent.click(await screen.findByText('stub archive', {}, { timeout: 5000 }));
    await waitFor(() => expect(toastTitles()).toContainEqual(['mail_list_extra.archived', null]));
  });

  it('deleting to Trash says Moved to Trash', async () => {
    render(<MailApp />);
    fireEvent.click(await screen.findByText('stub delete', {}, { timeout: 5000 }));
    await waitFor(() => expect(toastTitles()).toContainEqual(['mail_list_extra.moved_to_trash', null]));
  });
});
