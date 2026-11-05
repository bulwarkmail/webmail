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

// mail-p3-6: Delete or Archive opens the next message, which marks it read.
// Undo put the first one back but left the next one read, though nobody read it.

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
  keywords: { $seen: true }, mailboxIds: { inbox: true },
} as unknown as Email;
const next = {
  id: 'm2', threadId: 't2', subject: 'Next', receivedAt: '2026-10-26T09:00:00Z',
  keywords: {}, mailboxIds: { inbox: true },
} as unknown as Email;
const later = {
  id: 'm3', threadId: 't3', subject: 'Later', receivedAt: '2026-10-26T08:00:00Z',
  keywords: {}, mailboxIds: { inbox: true },
} as unknown as Email;

let client: Record<string, ReturnType<typeof vi.fn> | (() => unknown)>;
const markAsReadSpy = vi.fn().mockResolvedValue(true);

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
    emails: [unread, next, later], selectedEmail: unread, selectedMailbox: 'inbox', selectedKeyword: null, mailboxes: folders,
    viewingAccountId: null, accountMailboxes: {}, isUnifiedView: false, unifiedRole: null,
    isScheduledView: false, isLoadingEmail: false, isLoading: false, searchQuery: '',
    searchFilters: { ...DEFAULT_SEARCH_FILTERS }, searchMailboxId: '',
    selectedEmailKeys: new Set(),
    fetchMailboxes: vi.fn().mockResolvedValue(undefined), fetchEmails: vi.fn().mockResolvedValue(undefined),
    fetchQuota: vi.fn().mockResolvedValue(undefined), fetchTagCounts: vi.fn().mockResolvedValue(undefined),
    refreshScheduledMetadata: vi.fn().mockResolvedValue(undefined),
    markAsRead: markAsReadSpy,
  } as never);
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

/** As opening it does: the row turns read. */
function readByOpening(id: string) {
  useEmailStore.setState((state) => ({
    emails: state.emails.map((e) => (e.id === id ? { ...e, keywords: { ...e.keywords, $seen: true } } : e)),
  }));
}

async function deleteAndUndo(afterDelete: () => void) {
  useSettingsStore.setState({ deleteAction: 'trash' } as never);
  client.restoreEmails = vi.fn(async () => {
    // The message is back in the list.
    useEmailStore.setState((state) => ({ emails: [unread, ...state.emails] }));
  });
  render(<MailApp />);
  fireEvent.click(await screen.findByText('stub delete', {}, { timeout: 5000 }));
  await waitFor(() => expect(useToastStore.getState().toasts.some(t => t.title === 'mail_list_extra.moved_to_trash')).toBe(true));
  await waitFor(() => expect(useEmailStore.getState().selectedEmail?.id).toBe('m2'));
  afterDelete();
  markAsReadSpy.mockClear();
  const deleted = useToastStore.getState().toasts.find(t => t.title === 'mail_list_extra.moved_to_trash')!;
  deleted.action!.onClick();
  await waitFor(() => expect(client.restoreEmails).toHaveBeenCalled());
}

describe('Undo after a delete that opened the next message', () => {
  it('gives the next message its unread mark back', async () => {
    await deleteAndUndo(() => readByOpening('m2'));
    await waitFor(() => expect(markAsReadSpy).toHaveBeenCalledWith(client, 'm2', false, expect.anything()));
  });

  it('leaves alone a message the user opened after it', async () => {
    await deleteAndUndo(() => {
      readByOpening('m2');
      useEmailStore.setState((state) => ({ selectedEmail: state.emails.find((e) => e.id === 'm3') ?? null }));
      readByOpening('m3');
    });
    await new Promise((r) => setTimeout(r, 50));
    expect(markAsReadSpy).not.toHaveBeenCalledWith(client, expect.anything(), false, expect.anything());
  });

  it('leaves alone a next message that was read already', async () => {
    useEmailStore.setState((state) => ({ emails: state.emails.map((e) => (e.id === 'm2' ? { ...e, keywords: { $seen: true } } : e)) }));
    await deleteAndUndo(() => {});
    await new Promise((r) => setTimeout(r, 50));
    expect(markAsReadSpy).not.toHaveBeenCalledWith(client, 'm2', false, expect.anything());
  });
});
