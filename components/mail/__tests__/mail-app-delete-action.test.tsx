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

// Settings > Message list > "Delete action" decides what Delete does with the
// open message: move it to Trash, move it there read, or destroy it.

vi.mock('next/dynamic', () => ({ default: (load: () => Promise<React.ComponentType<Record<string, unknown>>>) => {
  const Component = lazy(async () => ({ default: await load() }));
  return function Dynamic(props: Record<string, unknown>) {
    return <Suspense fallback={null}><Component {...props} /></Suspense>;
  };
} }));
vi.mock('@/components/email/email-viewer', () => ({
  EmailViewer: ({ onDelete }: { onDelete?: () => void }) => (
    <button onClick={() => onDelete?.()}>stub delete</button>
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

describe('Delete on the open message', () => {
  it('moves it to Trash read with "Move to Trash and mark as read"', async () => {
    useSettingsStore.setState({ deleteAction: 'trash-and-read' } as never);
    render(<MailApp />);
    fireEvent.click(await screen.findByText('stub delete', {}, { timeout: 5000 }));
    await waitFor(() => expect(client.moveToTrash).toHaveBeenCalled());
    expect(client.moveToTrash).toHaveBeenCalledWith('m1', 'trash', undefined, true);
    expect(client.moveEmail).not.toHaveBeenCalled();
  });

  it('asks, then destroys it, with "Delete permanently"', async () => {
    useSettingsStore.setState({ deleteAction: 'permanent' } as never);
    render(<MailApp />);
    fireEvent.click(await screen.findByText('stub delete', {}, { timeout: 5000 }));
    const confirm = await screen.findByRole('alertdialog');
    expect(client.deleteEmail).not.toHaveBeenCalled();
    fireEvent.click(await screen.findByText('email_list.permanent_delete', { selector: 'button' }));
    await waitFor(() => expect(client.deleteEmail).toHaveBeenCalledWith('m1', undefined));
    expect(confirm).toBeTruthy();
    expect(client.moveToTrash).not.toHaveBeenCalled();
    expect(client.moveEmail).not.toHaveBeenCalled();
  });
});

describe('Delete on a selection', () => {
  it('destroys it, after the confirm, with "Delete permanently"', async () => {
    const { bulkDeleteIsPermanent, shouldConfirmBulkDelete } = await import('@/stores/email-store');
    useSettingsStore.setState({ deleteAction: 'permanent', confirmBulkDelete: false } as never);
    expect(bulkDeleteIsPermanent({ role: 'inbox' })).toBe(true);
    expect(shouldConfirmBulkDelete({ role: 'inbox' })).toBe(true);
    useSettingsStore.setState({ deleteAction: 'trash' } as never);
    expect(bulkDeleteIsPermanent({ role: 'inbox' })).toBe(false);
  });
});

describe('Undo after a delete to Trash', () => {
  it('puts the message back where it was, unread again', async () => {
    useSettingsStore.setState({ deleteAction: 'trash-and-read' } as never);
    client.restoreEmails = vi.fn().mockResolvedValue(undefined);
    render(<MailApp />);
    fireEvent.click(await screen.findByText('stub delete', {}, { timeout: 5000 }));
    await waitFor(() => expect(useToastStore.getState().toasts.some(t => t.title === 'mail_list_extra.moved_to_trash')).toBe(true));
    const deleted = useToastStore.getState().toasts.find(t => t.title === 'mail_list_extra.moved_to_trash')!;
    expect(deleted.action?.label).toBe('undo');
    deleted.action!.onClick();
    await waitFor(() => expect(client.restoreEmails).toHaveBeenCalled());
    expect(client.restoreEmails).toHaveBeenCalledWith([{ id: 'm1', mailboxIds: { inbox: true }, seen: false }], undefined);
  });

  it('is not offered for a permanent delete', async () => {
    useSettingsStore.setState({ deleteAction: 'permanent' } as never);
    render(<MailApp />);
    fireEvent.click(await screen.findByText('stub delete', {}, { timeout: 5000 }));
    fireEvent.click(await screen.findByText('email_list.permanent_delete', { selector: 'button' }));
    await waitFor(() => expect(useToastStore.getState().toasts.some(t => t.title === 'notifications.email_deleted')).toBe(true));
    expect(useToastStore.getState().toasts.find(t => t.title === 'notifications.email_deleted')!.action).toBeUndefined();
  });
});
