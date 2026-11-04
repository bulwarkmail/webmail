import React, { Suspense, lazy } from 'react';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Email, Mailbox } from '@/lib/jmap/types';
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
// On a desktop Compose sits at the head of the folder sidebar (mail-13).
vi.mock('@/components/layout/sidebar', () => ({
  Sidebar: ({ onCompose }: { onCompose?: () => void }) => (device.isMobile ? null : <button type="button" onClick={onCompose}>sidebar.compose</button>),
}));
vi.mock('@/components/layout/navigation-rail', () => ({ NavigationRail: () => null }));
vi.mock('@/components/layout/calendar-event-notification-toaster', () => ({ CalendarEventNotificationToaster: () => null }));
vi.mock('@/components/layout/share-notification-toaster', () => ({ ShareNotificationToaster: () => null }));
vi.mock('@/components/layout/mobile-header', () => ({ MobileHeader: () => null }));
vi.mock('@/components/layout/mv-top-bar', () => ({ MvTopBar: () => null }));
vi.mock('@/components/layout/mv-side-panel', () => ({ MvSidePanel: () => null }));
vi.mock('@/components/search/mv-search-form', () => ({ MvSearchForm: () => null }));
// As the real one, it marks the message it is given as read, mounted or not.
vi.mock('@/components/email/email-viewer', async () => {
  const { useEffect } = await import('react');
  return {
    EmailViewer: ({ email, onMarkAsRead }: {
      email?: { id: string } | null;
      onMarkAsRead?: (id: string, read: boolean, opts?: { automatic?: boolean }) => void;
    }) => {
      useEffect(() => {
        if (email) onMarkAsRead?.(email.id, true, { automatic: true });
        // eslint-disable-next-line react-hooks/exhaustive-deps
      }, [email?.id]);
      return <div>message viewer</div>;
    },
  };
});
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
const device = vi.hoisted(() => ({ isMobile: true, isCompact: false }));
vi.mock('@/hooks/use-media-query', () => ({
  useDeviceDetection: () => ({ isMobile: device.isMobile, isCompact: device.isCompact, isDesktop: !device.isMobile }),
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
  device.isCompact = false;
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

/** On a phone only one of list and reading pane shows; the other gets max-desk:hidden. */
const listHidden = () => screen.getByText('message list').closest('.max-desk\\:hidden') !== null;

describe('Mail after the tour on a phone', () => {
  it('shows the list when it opens with the reader left on and nothing to read', () => {
    useUIStore.setState({ activeView: 'viewer' });
    render(<MailApp />);
    expect(listHidden()).toBe(false);
  });

  // Usability test 2026-11-04, mail-13: on a desktop the round button sat on
  // the list's rows; Compose is at the head of the folder sidebar there.
  it('draws the round Compose button on a phone, not on a desktop', () => {
    const view = render(<MailApp />);
    expect(document.querySelectorAll('[data-tour="compose-button"]')).toHaveLength(1);

    device.isMobile = false;
    view.rerender(<MailApp />);
    expect(document.querySelector('[data-tour="compose-button"]')).toBeNull();
  });

  // mail-27 kept the tablet from drawing the header's ⋮ and the list's ⋮ one
  // above the other. The tablet widths are a compact desktop now, which has
  // no phone header: the list's ⋮ is the only one there.
  it('draws the list ⋮ on a desktop, compact or full', () => {
    device.isMobile = false;
    const view = render(<MailApp />);
    expect(screen.queryByTestId('mail-folder-menu')).not.toBeNull();

    device.isCompact = true;
    view.rerender(<MailApp />);
    expect(screen.queryByTestId('mail-folder-menu')).not.toBeNull();
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

  const unread = (id: string) => ({
    id, threadId: `t-${id}`, subject: id, receivedAt: '2026-10-31T10:00:00Z', keywords: {}, mailboxIds: { inbox: true },
  }) as unknown as Email;

  it('keeps an open message in view when the window narrows to a phone', () => {
    device.isMobile = false;
    const message = unread('m1');
    useEmailStore.setState({ emails: [message], selectedEmail: message, fetchEmailContent: vi.fn().mockResolvedValue(undefined) } as never);
    const view = render(<MailApp />);
    expect(useUIStore.getState().activeView).toBe('list');

    device.isMobile = true;
    view.rerender(<MailApp />);

    expect(useUIStore.getState().activeView).toBe('viewer');
  });

  it('does not open a message left selected behind the list when Mail is entered again', () => {
    const message = unread('m1');
    useEmailStore.setState({ emails: [message], selectedEmail: message, fetchEmailContent: vi.fn().mockResolvedValue(undefined) } as never);
    render(<MailApp />);
    expect(useUIStore.getState().activeView).toBe('list');
    expect(listHidden()).toBe(false);
  });

  it('drops the Mountain View cursor when the window narrows, unopened and still unread', async () => {
    device.isMobile = false;
    const first = unread('m1');
    const markAsRead = vi.fn().mockResolvedValue(undefined);
    useSettingsStore.setState({ interfaceLayout: 'mountain-view', mailLayout: 'focus', singleKeyShortcuts: true, markAsReadDelay: 0 } as never);
    Object.assign(useAuthStore.getState().client as object, {
      getThread: vi.fn(async (threadId: string) => ({ id: threadId, emailIds: [threadId.slice(2)] })),
      getEmail: vi.fn(async (id: string) => ({ ...unread(id), bodyValues: {} })),
    });
    useEmailStore.setState({ emails: [first, unread('m2')], markAsRead } as never);
    const view = render(<MailApp />);

    act(() => { fireEvent.keyDown(window, { key: 'j' }); });
    await waitFor(() => expect(useEmailStore.getState().selectedEmail?.id).toBe('m1'));
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 50)); });
    expect(markAsRead).not.toHaveBeenCalled();

    device.isMobile = true;
    view.rerender(<MailApp />);

    await waitFor(() => expect(useEmailStore.getState().selectedEmail).toBeNull());
    expect(useUIStore.getState().activeView).toBe('list');
    expect(markAsRead).not.toHaveBeenCalled();
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
