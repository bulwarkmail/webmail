import React, { Suspense, lazy } from 'react';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Mailbox } from '@/lib/jmap/types';
import { useAuthStore } from '@/stores/auth-store';
import { useEmailStore } from '@/stores/email-store';
import { useSettingsStore } from '@/stores/settings-store';
import { usePluginStore } from '@/stores/plugin-store';
import { useThemeStore } from '@/stores/theme-store';
import { useUIStore } from '@/stores/ui-store';
import { requestAppCommand } from '@/lib/app-commands';
import { DEFAULT_SEARCH_FILTERS } from '@/lib/jmap/search-utils';

// After the tour on a phone, Mail showed only the empty reading pane: no
// list, header or tab bar. The tour's composer had left the view on the
// reader, which outlives Mail when the tour moves on to Calendar.
vi.mock('next/dynamic', () => ({ default: (load: () => Promise<React.ComponentType<Record<string, unknown>>>) => {
  const Component = lazy(async () => ({ default: await load() }));
  return function Dynamic(props: Record<string, unknown>) {
    return <Suspense fallback={null}><Component {...props} /></Suspense>;
  };
} }));
vi.mock('@/components/email/email-composer', () => ({
  EmailComposer: ({ onClose, requestCloseRef }: {
    onClose?: () => void;
    requestCloseRef?: { current: ((afterClose?: () => void) => void) | null };
  }) => {
    if (requestCloseRef) requestCloseRef.current = (afterClose) => { onClose?.(); afterClose?.(); };
    return <p>stub composer</p>;
  },
}));
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
const device = vi.hoisted(() => ({ isMobile: true }));
vi.mock('@/hooks/use-media-query', () => ({
  useDeviceDetection: () => ({ isMobile: device.isMobile, isTablet: false, isDesktop: !device.isMobile }),
  useMediaQuery: () => false,
  useIsDesktop: () => false,
}));
vi.mock('@/lib/push-bindings', () => ({ reconcilePushBindings: () => {}, releasePushBindings: () => {} }));
vi.mock('@/components/email/email-list', () => ({ EmailList: () => <div>message list</div> }));

const { MailApp } = await import('../mail-app');

const inbox = { id: 'inbox', name: 'Inbox', role: 'inbox' } as Mailbox;
const sendEmail = vi.fn();

beforeEach(() => {
  vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('Unexpected network request')));
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} });
  usePluginStore.setState({ initializePlugins: vi.fn().mockResolvedValue(undefined) });
  useThemeStore.setState({ syncServerThemes: vi.fn().mockResolvedValue(undefined) });
  const client = {
    getAccountId: () => 'acc', getUsername: () => 'me@example.com',
    getSieveAccountId: () => null, hasDelayedSend: () => false, getSession: () => null,
  };
  useAuthStore.setState({
    isAuthenticated: true, isLoading: false, client: client as never, activeAccountId: 'login', identities: [],
    getClientForAccount: () => client as never,
    getAllConnectedClients: () => new Map([['login', client]]) as never,
  });
  useSettingsStore.setState({ enableUnifiedMailbox: false, mailLayout: 'split', sendDelaySeconds: 0 } as never);
  sendEmail.mockReset().mockResolvedValue({});
  useUIStore.setState({ activeView: 'list', sidebarOpen: false });
  useEmailStore.setState({
    emails: [], selectedEmail: null, selectedMailbox: inbox.id, mailboxes: [inbox],
    viewingAccountId: null, accountMailboxes: {}, isUnifiedView: false, unifiedRole: null,
    isScheduledView: false, isLoadingEmail: false, isLoading: false, searchQuery: '',
    searchFilters: { ...DEFAULT_SEARCH_FILTERS }, searchMailboxId: '', selectedKeyword: null,
    selectedEmailKeys: new Set(),
    fetchMailboxes: vi.fn().mockResolvedValue(undefined), fetchEmails: vi.fn().mockResolvedValue(undefined),
    fetchQuota: vi.fn().mockResolvedValue(undefined), fetchTagCounts: vi.fn().mockResolvedValue(undefined),
    refreshScheduledMetadata: vi.fn().mockResolvedValue(undefined),
    sendEmail,
  } as never);
});
afterEach(() => {
  device.isMobile = true;
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

/** On a phone only one of list and reading pane shows; the other gets max-md:hidden. */
const listHidden = () => screen.getByText('message list').closest('.max-md\\:hidden') !== null;

describe('Mail after the tour on a phone', () => {
  it('shows the list when it opens with the reader left on and nothing to read', () => {
    useUIStore.setState({ activeView: 'viewer' });
    render(<MailApp />);
    expect(listHidden()).toBe(false);
  });

  it('keeps an open composer in view when the window narrows to a phone', async () => {
    device.isMobile = false;
    useUIStore.setState({ activeView: 'list' });
    const view = render(<MailApp />);
    fireEvent.click(screen.getByRole('button', { name: 'sidebar.compose' }));
    await screen.findByText('stub composer', {}, { timeout: 5000 });
    expect(useUIStore.getState().activeView).toBe('list');

    device.isMobile = true;
    view.rerender(<MailApp />);

    expect(useUIStore.getState().activeView).toBe('viewer');
  });

  it('closes the composer the tour opened when the tour ends', async () => {
    render(<MailApp />);
    fireEvent.click(screen.getByRole('button', { name: 'sidebar.compose' }));
    await screen.findByText('stub composer', {}, { timeout: 5000 });
    expect(listHidden()).toBe(true);

    act(() => { requestAppCommand('tour-end'); });

    expect(screen.queryByText('stub composer')).not.toBeInTheDocument();
    expect(listHidden()).toBe(false);
  });
});
