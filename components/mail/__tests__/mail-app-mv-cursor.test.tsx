import React, { Suspense, lazy } from 'react';
import { act, fireEvent, render, screen } from '@testing-library/react';
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
import { forgetEmailPrefetches } from '@/lib/email-prefetch';

// Mountain View's list cursor moves to a ticked row (#1701) and with j / k.
// It shows no message, so it must not wait for the message to arrive: the
// ticked row showed the tick colour until then, then flicked to the cursor's
// (#1847).

vi.mock('next/dynamic', () => ({ default: (load: () => Promise<React.ComponentType<Record<string, unknown>>>) => {
  const Component = lazy(async () => ({ default: await load() }));
  return function Dynamic(props: Record<string, unknown>) {
    return <Suspense fallback={null}><Component {...props} /></Suspense>;
  };
} }));
vi.mock('@/components/email/email-viewer', () => ({ EmailViewer: () => null }));
vi.mock('@/components/email/email-composer', () => ({ EmailComposer: () => null }));
vi.mock('@/components/layout/sidebar', () => ({ Sidebar: () => null }));
vi.mock('@/components/layout/navigation-rail', () => ({ NavigationRail: () => null }));
vi.mock('@/components/layout/calendar-event-notification-toaster', () => ({ CalendarEventNotificationToaster: () => null }));
vi.mock('@/components/layout/share-notification-toaster', () => ({ ShareNotificationToaster: () => null }));
vi.mock('@/components/layout/mobile-header', () => ({ MobileHeader: () => null }));
vi.mock('@/components/layout/mv-top-bar', () => ({ MvTopBar: () => null }));
vi.mock('@/components/layout/mv-side-panel', () => ({ MvSidePanel: () => null }));
vi.mock('@/components/email/message-list-tabs', () => ({ useMessageListPanelProps: (id: string) => ({ id }), MessageListTabs: () => null }));
vi.mock('@/components/search/search-box', () => ({ SearchBox: () => <input aria-label="stub search field" data-search-input /> }));
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
type ListProps = { emails: Email[]; onRowTick?: (email: Email) => void; selectedEmailKey?: string };
vi.mock('@/components/email/email-list', () => ({
  EmailList: ({ emails, onRowTick, selectedEmailKey }: ListProps) => (
    <div>
      message list
      <output aria-label="cursor">{selectedEmailKey ?? ''}</output>
      <button onClick={() => onRowTick?.(emails[1])}>stub tick m2</button>
    </div>
  ),
}));

const { MailApp } = await import('../mail-app');

function mailbox(id: string, role: string): Mailbox {
  return {
    id, name: role, role, sortOrder: 0, totalEmails: 3, unreadEmails: 0, totalThreads: 3, unreadThreads: 0, isSubscribed: true,
  } as Mailbox;
}
const folders = [mailbox('inbox', 'inbox'), mailbox('archive', 'archive'), mailbox('trash', 'trash')];
const row = (id: string, minute: number) => ({
  id, threadId: `t-${id}`, subject: id, receivedAt: new Date(Date.UTC(2026, 9, 31, 10, minute)).toISOString(),
  keywords: { $seen: true }, mailboxIds: { inbox: true },
}) as unknown as Email;
const inbox = () => [row('m1', 30), row('m2', 20), row('m3', 10)];

let client: Record<string, ReturnType<typeof vi.fn> | (() => unknown)>;

beforeEach(() => {
  vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('Unexpected network request')));
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} });
  usePluginStore.setState({ initializePlugins: vi.fn().mockResolvedValue(undefined) });
  useThemeStore.setState({ syncServerThemes: vi.fn().mockResolvedValue(undefined) });
  useToastStore.setState({ toasts: [] });
  clearAllHooks();
  forgetEmailPrefetches();
  client = {
    getAccountId: () => 'acc', getUsername: () => 'a@example.org',
    getSieveAccountId: () => null, hasDelayedSend: () => false, getSession: () => null,
    getMailboxes: vi.fn().mockResolvedValue(folders),
    // The message and its conversation are still on their way.
    getThread: vi.fn(() => new Promise(() => {})),
    getEmail: vi.fn(() => new Promise(() => {})),
    markAsRead: vi.fn().mockResolvedValue(undefined),
  };
  useAuthStore.setState({
    isAuthenticated: true, isLoading: false, client: client as never, activeAccountId: 'login-a', identities: [],
    getClientForAccount: (id: string) => (id === 'login-a' ? client : undefined) as never,
    getAllConnectedClients: () => new Map([['login-a', client]]) as never,
  });
  useSettingsStore.setState({
    enableUnifiedMailbox: false, interfaceLayout: 'mountain-view', mailLayout: 'focus',
    singleKeyShortcuts: true,
  } as never);
  useEmailStore.setState({
    emails: inbox(), selectedEmail: null, selectedMailbox: 'inbox', selectedKeyword: null, mailboxes: folders,
    viewingAccountId: null, accountMailboxes: {}, isUnifiedView: false, unifiedRole: null,
    isScheduledView: false, isLoadingEmail: false, isLoading: false, searchQuery: '',
    searchFilters: { ...DEFAULT_SEARCH_FILTERS }, searchMailboxId: '',
    selectedEmailKeys: new Set(), unreadSection: null, listRows: null,
    fetchMailboxes: vi.fn().mockResolvedValue(undefined), fetchEmails: vi.fn().mockResolvedValue(undefined),
    fetchQuota: vi.fn().mockResolvedValue(undefined), fetchTagCounts: vi.fn().mockResolvedValue(undefined),
    refreshScheduledMetadata: vi.fn().mockResolvedValue(undefined),
    fetchEmailContent: vi.fn().mockResolvedValue(undefined),
  } as never);
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

const cursor = () => screen.getByLabelText('cursor').textContent;

describe('The Mountain View list cursor', () => {
  it('moves to a ticked row before the message arrives', async () => {
    render(<MailApp />);
    fireEvent.click(await screen.findByText('stub tick m2', {}, { timeout: 5000 }));
    await act(async () => {});
    expect(client.getEmail).toHaveBeenCalled();
    expect(cursor()).toBe('m2');
  });

  it('moves with j before the message arrives', async () => {
    render(<MailApp />);
    await screen.findByText('stub tick m2', {}, { timeout: 5000 });
    await act(async () => { fireEvent.keyDown(window, { key: 'j' }); });
    expect(cursor()).toBe('m1');
    // Pressed again before the first message came back, j goes on from there.
    await act(async () => { fireEvent.keyDown(window, { key: 'j' }); });
    expect(cursor()).toBe('m2');
  });
});
