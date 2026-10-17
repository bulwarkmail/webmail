import React from 'react';
import { act, fireEvent, render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Email, Mailbox } from '@/lib/jmap/types';
import { useAuthStore } from '@/stores/auth-store';
import { useEmailStore } from '@/stores/email-store';
import { useSettingsStore } from '@/stores/settings-store';
import { usePluginStore } from '@/stores/plugin-store';
import { useThemeStore } from '@/stores/theme-store';
import { DEFAULT_SEARCH_FILTERS } from '@/lib/jmap/search-utils';

// The `x` shortcut expands the selected conversation and marks it read. It has
// to follow markAsReadDelay like the reading pane, and a delayed mark must not
// land once the user has moved on (`j`/`k`) to a message outside it.

vi.mock('@/components/email/email-composer', () => ({ EmailComposer: () => null }));
vi.mock('@/components/email/email-viewer', () => ({ EmailViewer: () => null }));
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
  useIsMobile: () => false,
}));
vi.mock('@/lib/push-bindings', () => ({ reconcilePushBindings: () => {}, releasePushBindings: () => {} }));
vi.mock('@/components/email/email-list', () => ({ EmailList: () => <div>message list</div> }));

const { MailApp } = await import('../mail-app');

const inbox = { id: 'inbox', name: 'Inbox', role: 'inbox' } as Mailbox;
const mail = (id: string, threadId: string, seen: boolean, time: string): Email => ({
  id, threadId, mailboxIds: { inbox: true }, keywords: seen ? { $seen: true } : {}, size: 1,
  receivedAt: `2026-10-01T${time}:00Z`, from: [{ email: 'sender@example.com' }], subject: id,
  preview: '', hasAttachment: false,
}) as Email;

// Newest first, as the list shows it: the conversation, then a single message.
const conversation = [mail('c2', 'conv', false, '12:00'), mail('c1', 'conv', true, '11:00')];
const single = mail('s1', 'single', true, '10:00');

let client: {
  getAccountId: () => string; getUsername: () => string; getSieveAccountId: () => null;
  hasDelayedSend: () => boolean; getSession: () => null;
  getEmail: ReturnType<typeof vi.fn>; getThreadEmails: ReturnType<typeof vi.fn>;
  batchMarkAsRead: ReturnType<typeof vi.fn>; markAsRead: ReturnType<typeof vi.fn>;
};

beforeEach(() => {
  vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('Unexpected network request')));
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} });
  usePluginStore.setState({ initializePlugins: vi.fn().mockResolvedValue(undefined) });
  useThemeStore.setState({ syncServerThemes: vi.fn().mockResolvedValue(undefined) });
  client = {
    getAccountId: () => 'acc', getUsername: () => 'me@example.com',
    getSieveAccountId: () => null, hasDelayedSend: () => false, getSession: () => null,
    getEmail: vi.fn(async (id: string) => [...conversation, single].find((e) => e.id === id) ?? null),
    getThreadEmails: vi.fn(async () => conversation),
    batchMarkAsRead: vi.fn(async () => {}),
    markAsRead: vi.fn(async () => {}),
  };
  useAuthStore.setState({
    isAuthenticated: true, isLoading: false, client: client as never, activeAccountId: 'login', identities: [],
    getClientForAccount: () => client as never,
    getAllConnectedClients: () => new Map([['login', client]]) as never,
  });
  useSettingsStore.setState({ enableUnifiedMailbox: false, mailLayout: 'split', interfaceLayout: 'default' } as never);
  useEmailStore.setState({
    // The conversation's newest message is open (selected with `j`).
    emails: [...conversation, single], selectedEmail: conversation[0], selectedMailbox: inbox.id, mailboxes: [inbox],
    viewingAccountId: null, accountMailboxes: {}, isUnifiedView: false, unifiedRole: null,
    isScheduledView: false, isLoadingEmail: false, isLoading: false, searchQuery: '',
    searchFilters: { ...DEFAULT_SEARCH_FILTERS }, searchMailboxId: '', selectedKeyword: null,
    selectedEmailKeys: new Set(), expandedThreadIds: new Set(), threadEmailsCache: new Map(),
    processingReadStatus: new Set(),
    fetchMailboxes: vi.fn().mockResolvedValue(undefined), fetchEmails: vi.fn().mockResolvedValue(undefined),
    fetchQuota: vi.fn().mockResolvedValue(undefined), fetchTagCounts: vi.fn().mockResolvedValue(undefined),
    refreshScheduledMetadata: vi.fn().mockResolvedValue(undefined),
  } as never);
});
afterEach(() => {
  useEmailStore.getState().collapseAllThreads();
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

const press = async (code: string) => {
  fireEvent.keyDown(window, { key: code.slice(3).toLowerCase(), code });
  await act(async () => { await vi.advanceTimersByTimeAsync(0); });
};

describe('`x` expansion follows markAsReadDelay', () => {
  it('marks nothing read with "Never" (-1)', async () => {
    useSettingsStore.setState({ markAsReadDelay: -1 });
    vi.useFakeTimers();
    render(<MailApp />);
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });

    await press('KeyX');
    expect(useEmailStore.getState().expandedThreadIds.has('conv')).toBe(true);
    await act(async () => { await vi.advanceTimersByTimeAsync(60_000); });

    expect(client.batchMarkAsRead).not.toHaveBeenCalled();
    expect(client.markAsRead).not.toHaveBeenCalled();
  });

  it('drops the delayed conversation mark once `j` opens a message outside it', async () => {
    // The reading pane already shows c2 marked read here: only the thread
    // expansion is under test.
    useEmailStore.setState({ selectedEmail: { ...conversation[0], keywords: { $seen: true } } });
    useSettingsStore.setState({ markAsReadDelay: 5000 });
    vi.useFakeTimers();
    render(<MailApp />);
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });

    await press('KeyX');
    expect(useEmailStore.getState().expandedThreadIds.has('conv')).toBe(true);
    await act(async () => { await vi.advanceTimersByTimeAsync(1000); });

    // Move past the conversation to the single message.
    await press('KeyJ');
    await press('KeyJ');
    expect(useEmailStore.getState().selectedEmail?.id).toBe('s1');
    await act(async () => { await vi.advanceTimersByTimeAsync(10_000); });

    expect(client.batchMarkAsRead).not.toHaveBeenCalled();
    // Moving on does not collapse the conversation.
    expect(useEmailStore.getState().expandedThreadIds.has('conv')).toBe(true);
  });

  it('still marks the conversation read after the delay while the user stays in it', async () => {
    useEmailStore.setState({ selectedEmail: { ...conversation[0], keywords: { $seen: true } } });
    useSettingsStore.setState({ markAsReadDelay: 5000 });
    vi.useFakeTimers();
    render(<MailApp />);
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });

    await press('KeyX');
    await act(async () => { await vi.advanceTimersByTimeAsync(4999); });
    expect(client.batchMarkAsRead).not.toHaveBeenCalled();
    await act(async () => { await vi.advanceTimersByTimeAsync(1); });

    expect(client.batchMarkAsRead).toHaveBeenCalledWith(['c2'], true, undefined);
  });
});
