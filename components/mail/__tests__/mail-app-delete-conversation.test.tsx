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

// #1885: "Delete conversation" in the reader's More menu deletes every
// message of the open conversation the list holds, as ticking its row and
// Delete do: one batch, the batch delete's question, and Undo.

vi.mock('next/dynamic', () => ({ default: (load: () => Promise<React.ComponentType<Record<string, unknown>>>) => {
  const Component = lazy(async () => ({ default: await load() }));
  return function Dynamic(props: Record<string, unknown>) {
    return <Suspense fallback={null}><Component {...props} /></Suspense>;
  };
} }));
vi.mock('@/components/email/email-viewer', () => ({
  EmailViewer: ({ onDeleteConversation }: { onDeleteConversation?: () => void }) => (
    <div>
      <span>stub viewer</span>
      {onDeleteConversation && <button onClick={() => onDeleteConversation()}>stub delete conversation</button>}
    </div>
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
const message = (id: string, threadId: string, at: string) => ({
  id, threadId, subject: 'Plans', receivedAt: at, keywords: { $seen: true }, mailboxIds: { inbox: true },
} as unknown as Email);
const first = message('m1', 't1', '2026-10-26T10:00:00Z');
const reply = message('m2', 't1', '2026-10-26T11:00:00Z');
const latest = message('m3', 't1', '2026-10-26T12:00:00Z');
const other = message('o1', 't2', '2026-10-26T09:00:00Z');

let client: Record<string, ReturnType<typeof vi.fn> | (() => unknown)>;

function setup(emails: Email[], open: Email) {
  useEmailStore.setState({ emails, selectedEmail: open } as never);
  render(<MailApp />);
}

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
    batchMoveEmails: vi.fn().mockResolvedValue(undefined),
    batchDeleteEmails: vi.fn().mockResolvedValue(undefined),
    restoreEmails: vi.fn().mockResolvedValue(undefined),
  };
  useAuthStore.setState({
    isAuthenticated: true, isLoading: false, client: client as never, activeAccountId: 'login-a', identities: [],
    getClientForAccount: (id: string) => (id === 'login-a' ? client : undefined) as never,
    getAllConnectedClients: () => new Map([['login-a', client]]) as never,
  });
  useSettingsStore.setState({
    enableUnifiedMailbox: false, mailLayout: 'split', interfaceLayout: 'default', disableThreading: false,
    permanentlyDeleteJunk: false, deleteAction: 'trash', confirmDelete: false, confirmBulkDelete: false,
  } as never);
  useEmailStore.setState({
    selectedMailbox: 'inbox', selectedKeyword: null, mailboxes: folders,
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

const calls = (fn: unknown) => (fn as ReturnType<typeof vi.fn>).mock.calls;

describe('Delete conversation in the reader (#1885)', () => {
  it('moves every message of the conversation in the list to Trash in one batch, and Undo puts them back', async () => {
    setup([latest, reply, first, other], latest);
    fireEvent.click(await screen.findByText('stub delete conversation', {}, { timeout: 5000 }));
    await waitFor(() => expect(client.batchMoveEmails).toHaveBeenCalledTimes(1));
    const [ids, to] = calls(client.batchMoveEmails)[0];
    expect([...ids].sort()).toEqual(['m1', 'm2', 'm3']);
    expect(to).toBe('trash');
    expect(client.moveToTrash).not.toHaveBeenCalled();
    expect(useEmailStore.getState().emails.map((e) => e.id)).toEqual(['o1']);

    const title = 'mail_p2_list.conversations_to_trash';
    await waitFor(() => expect(useToastStore.getState().toasts.some((t) => t.title === title)).toBe(true));
    useToastStore.getState().toasts.find((t) => t.title === title)!.action!.onClick();
    await waitFor(() => expect(client.restoreEmails).toHaveBeenCalled());
    const restored = calls(client.restoreEmails).flatMap((call) => (call[0] as { id: string }[]).map((e) => e.id));
    expect(restored.sort()).toEqual(['m1', 'm2', 'm3']);
  });

  it('asks first in Trash, and No deletes nothing and leaves the ticked rows as they were', async () => {
    const inTrash = [latest, reply].map((e) => ({ ...e, mailboxIds: { trash: true } }) as Email);
    useEmailStore.setState({ selectedMailbox: 'trash', selectedEmailKeys: new Set(['o1']) } as never);
    setup(inTrash, inTrash[0]);
    fireEvent.click(await screen.findByText('stub delete conversation', {}, { timeout: 5000 }));
    const dialog = await screen.findByRole('alertdialog');
    fireEvent.keyDown(dialog, { key: 'Escape' });
    await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull());
    expect(client.batchDeleteEmails).not.toHaveBeenCalled();
    expect([...useEmailStore.getState().selectedEmailKeys]).toEqual(['o1']);
  });

  it('destroys them after the question in Trash', async () => {
    const inTrash = [latest, reply].map((e) => ({ ...e, mailboxIds: { trash: true } }) as Email);
    useEmailStore.setState({ selectedMailbox: 'trash' } as never);
    setup(inTrash, inTrash[0]);
    fireEvent.click(await screen.findByText('stub delete conversation', {}, { timeout: 5000 }));
    fireEvent.click(await screen.findByText('reader_actions.delete_forever', { selector: 'button' }));
    await waitFor(() => expect(client.batchDeleteEmails).toHaveBeenCalledTimes(1));
    expect([...calls(client.batchDeleteEmails)[0][0]].sort()).toEqual(['m2', 'm3']);
  });

  it('is not offered for a conversation of one message in the list', async () => {
    setup([latest, other], latest);
    await screen.findByText('stub viewer', {}, { timeout: 5000 });
    expect(screen.queryByText('stub delete conversation')).toBeNull();
  });

  it('is not offered with "Show emails as individual messages"', async () => {
    useSettingsStore.setState({ disableThreading: true } as never);
    setup([latest, reply, first], latest);
    await screen.findByText('stub viewer', {}, { timeout: 5000 });
    expect(screen.queryByText('stub delete conversation')).toBeNull();
  });
});
