import React, { Suspense, lazy } from 'react';
import { act, render, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Mailbox } from '@/lib/jmap/types';
import { useAuthStore } from '@/stores/auth-store';
import { useEmailStore } from '@/stores/email-store';
import { useSettingsStore } from '@/stores/settings-store';
import { usePluginStore } from '@/stores/plugin-store';
import { useThemeStore } from '@/stores/theme-store';
import { useUIStore } from '@/stores/ui-store';
import { DEFAULT_SEARCH_FILTERS } from '@/lib/jmap/search-utils';

// The mail page hands over from the page skeleton the server drew without
// anything jumping: the auth gate draws that same skeleton, the list keeps
// its skeleton rows until the folder's first page is in, and a linked message
// keeps the reader open while it loads.

const nav = vi.hoisted(() => ({ replace: vi.fn(), push: vi.fn(), back: vi.fn(), prefetch: vi.fn() }));
vi.mock('@/i18n/navigation', () => ({
  useRouter: () => nav,
  usePathname: () => '/en',
  Link: ({ children }: { children: React.ReactNode }) => children,
}));
vi.mock('next/dynamic', () => ({ default: (load: () => Promise<React.ComponentType<Record<string, unknown>>>) => {
  const Component = lazy(async () => ({ default: await load() }));
  return function Dynamic(props: Record<string, unknown>) {
    return <Suspense fallback={null}><Component {...props} /></Suspense>;
  };
} }));
const viewer = vi.hoisted(() => ({ isLoading: [] as boolean[] }));
vi.mock('@/components/email/email-viewer', () => ({
  EmailViewer: ({ isLoading }: { isLoading?: boolean }) => {
    viewer.isLoading.push(!!isLoading);
    return <div data-testid="viewer" data-loading={isLoading ? '' : undefined} />;
  },
}));
const list = vi.hoisted(() => ({ isLoading: [] as boolean[] }));
vi.mock('@/components/email/email-list', () => ({
  EmailList: ({ isLoading }: { isLoading?: boolean }) => {
    list.isLoading.push(!!isLoading);
    return <div data-testid="list" data-loading={isLoading ? '' : undefined} />;
  },
}));
vi.mock('@/components/email/email-composer', () => ({ EmailComposer: () => null }));
vi.mock('@/components/layout/sidebar', () => ({ Sidebar: () => null }));
vi.mock('@/components/layout/navigation-rail', () => ({ NavigationRail: () => <div data-testid="bottom-nav" /> }));
vi.mock('@/components/layout/calendar-event-notification-toaster', () => ({ CalendarEventNotificationToaster: () => null }));
vi.mock('@/components/layout/share-notification-toaster', () => ({ ShareNotificationToaster: () => null }));
vi.mock('@/components/layout/mobile-header', () => ({ MobileHeader: () => null }));
vi.mock('@/components/layout/mv-top-bar', () => ({ MvTopBar: () => null }));
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
const device = vi.hoisted(() => ({ isMobile: false }));
vi.mock('@/hooks/use-media-query', () => ({
  useDeviceDetection: () => ({ isMobile: device.isMobile, isTablet: false, isDesktop: !device.isMobile }),
  useMediaQuery: () => false,
  useIsDesktop: () => !device.isMobile,
}));
vi.mock('@/lib/push-bindings', () => ({ reconcilePushBindings: () => {}, releasePushBindings: () => {} }));

const { MailApp } = await import('../mail-app');

const inbox = {
  id: 'inbox', name: 'Inbox', role: 'inbox', sortOrder: 0, totalEmails: 0, unreadEmails: 0, totalThreads: 0, unreadThreads: 0, isSubscribed: true,
} as Mailbox;

/** A promise the test settles by hand. */
function deferred<T = void>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => { resolve = r; });
  return { promise, resolve };
}

let fetchEmails: ReturnType<typeof vi.fn>;
let fetchEmailContent: ReturnType<typeof vi.fn>;

beforeEach(() => {
  list.isLoading = [];
  viewer.isLoading = [];
  device.isMobile = false;
  nav.replace.mockReset();
  vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('Unexpected network request')));
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} });
  usePluginStore.setState({ initializePlugins: vi.fn().mockResolvedValue(undefined) });
  useThemeStore.setState({ syncServerThemes: vi.fn().mockResolvedValue(undefined) });
  useUIStore.setState({ activeView: 'list' });
  const client = {
    getAccountId: () => 'acc', getUsername: () => 'a@example.org',
    getSieveAccountId: () => null, hasDelayedSend: () => false, getSession: () => null,
    getMailboxes: vi.fn().mockResolvedValue([inbox]),
  };
  useAuthStore.setState({
    isAuthenticated: true, isLoading: false, client: client as never, activeAccountId: 'login-a', identities: [],
    getClientForAccount: () => client as never,
    getAllConnectedClients: () => new Map([['login-a', client]]) as never,
  });
  useSettingsStore.setState({ enableUnifiedMailbox: false, interfaceLayout: 'default', mailLayout: 'focus' } as never);
  fetchEmails = vi.fn().mockResolvedValue(undefined);
  fetchEmailContent = vi.fn().mockResolvedValue(null);
  useEmailStore.setState({
    emails: [], selectedEmail: null, selectedMailbox: 'inbox', selectedKeyword: null, mailboxes: [inbox],
    viewingAccountId: null, accountMailboxes: {}, isUnifiedView: false, unifiedRole: null,
    isScheduledView: false, isLoadingEmail: false, isLoading: false, searchQuery: '',
    searchFilters: { ...DEFAULT_SEARCH_FILTERS }, searchMailboxId: '',
    selectedEmailKeys: new Set(), unreadSection: null,
    fetchMailboxes: vi.fn().mockResolvedValue(undefined), fetchEmails,
    fetchQuota: vi.fn().mockResolvedValue(undefined), fetchTagCounts: vi.fn().mockResolvedValue(undefined),
    refreshScheduledMetadata: vi.fn().mockResolvedValue(undefined),
    fetchEmailContent,
  } as never);
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('mail page hand-off from the boot skeleton', () => {
  it('draws the mail skeleton, not a spinner, while the session is restored', async () => {
    useAuthStore.setState({ isAuthenticated: false, client: null, checkAuth: vi.fn(() => new Promise(() => {})) } as never);
    const { container } = render(<MailApp />);
    await act(async () => {});
    expect(container.querySelector('[data-boot-skeleton="mail"]')).not.toBeNull();
    expect(container.querySelector('[data-boot-skeleton="mail"] [role="status"]')?.textContent).toBeTruthy();
    expect(container.querySelector('.animate-spin')).toBeNull();
  });

  it('keeps the list loading until the folder\'s first page is in, then shows an empty folder as empty', async () => {
    const page = deferred();
    fetchEmails.mockReturnValue(page.promise);
    const { getByTestId } = render(<MailApp />);
    await act(async () => {});
    // Nothing fetched yet: the store is not loading, but the list must not say "no emails".
    expect(useEmailStore.getState().isLoading).toBe(false);
    expect(getByTestId('list').hasAttribute('data-loading')).toBe(true);
    await act(async () => { page.resolve(); });
    await waitFor(() => expect(getByTestId('list').hasAttribute('data-loading')).toBe(false));
  });

  it('keeps the reader open in its loading state while a linked message loads (focus layout)', async () => {
    const content = deferred<null>();
    fetchEmailContent.mockReturnValue(content.promise);
    const { getByTestId, container } = render(<MailApp linkSegments={['message', 'm9']} />);
    await act(async () => {});
    const reader = container.querySelector('[data-pane="reader"]')!;
    expect(reader.className).not.toMatch(/(^|\s)desk:hidden(\s|$)/);
    expect(getByTestId('viewer').hasAttribute('data-loading')).toBe(true);
    // Not found: the reader goes away again and the list takes the page.
    await act(async () => { content.resolve(null); });
    await waitFor(() => expect(container.querySelector('[data-pane="reader"]')!.className).toMatch(/(^|\s)desk:hidden(\s|$)/));
  });

  it('opens a linked message over the list on a phone and hides the bottom bar meanwhile', async () => {
    device.isMobile = true;
    fetchEmailContent.mockReturnValue(new Promise(() => {}));
    const { container, queryByTestId } = render(<MailApp linkSegments={['message', 'm9']} />);
    await act(async () => {});
    const reader = container.querySelector('[data-pane="reader"]')!;
    expect(reader.className).not.toMatch(/(^|\s)max-desk:hidden(\s|$)/);
    expect(queryByTestId('bottom-nav')).toBeNull();
  });

  it('draws a linked conversation on a phone as the conversation view, not the message viewer, while it loads', async () => {
    device.isMobile = true;
    const client = useAuthStore.getState().client as unknown as Record<string, unknown>;
    client.getThreadEmails = vi.fn(() => new Promise(() => {}));
    const { container, queryByTestId } = render(<MailApp linkSegments={['thread', 't9']} />);
    await act(async () => {});
    const reader = container.querySelector('[data-pane="reader"]')!;
    expect(reader.querySelector('[aria-busy="true"] [role="status"]')).not.toBeNull();
    expect(queryByTestId('viewer')).toBeNull();
  });
});
