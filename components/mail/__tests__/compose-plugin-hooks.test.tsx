import React, { Suspense, lazy } from 'react';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Mailbox } from '@/lib/jmap/types';
import { useAuthStore } from '@/stores/auth-store';
import { useEmailStore } from '@/stores/email-store';
import { useSettingsStore } from '@/stores/settings-store';
import { usePluginStore } from '@/stores/plugin-store';
import { useThemeStore } from '@/stores/theme-store';
import { DEFAULT_SEARCH_FILTERS } from '@/lib/jmap/search-utils';
import { emailHooks, clearAllHooks } from '@/lib/plugin-hooks';
import { requestInternalMailto } from '@/lib/protocol-handlers/mailto';

// onBeforeCompose and onMailtoIntercept in the mail page: a plugin can stop
// the composer from opening or prefill it, and stop a mailto: link.

vi.mock('next/dynamic', () => ({ default: (load: () => Promise<React.ComponentType<Record<string, unknown>>>) => {
  const Component = lazy(async () => ({ default: await load() }));
  return function Dynamic(props: Record<string, unknown>) {
    return <Suspense fallback={null}><Component {...props} /></Suspense>;
  };
} }));
const composerProps = vi.hoisted(() => ({ last: null as Record<string, unknown> | null }));
vi.mock('@/components/email/email-composer', () => ({
  EmailComposer: (props: Record<string, unknown>) => {
    composerProps.last = props;
    return <div>stub composer</div>;
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
vi.mock('@/hooks/use-media-query', () => ({
  useDeviceDetection: () => ({ isMobile: true, isTablet: false, isDesktop: false }),
  useMediaQuery: () => false,
  useIsDesktop: () => false,
}));
vi.mock('@/lib/push-bindings', () => ({ reconcilePushBindings: () => {}, releasePushBindings: () => {} }));
vi.mock('@/components/email/email-list', () => ({ EmailList: () => <div>message list</div> }));
// The desktop app's compose windows, for a mail link from another program.
const desktopWindows = vi.hoisted(() => ({ on: false, handOver: vi.fn(async () => true), open: vi.fn() }));
vi.mock('@/lib/popout/support', async (original) => ({
  ...(await original<object>()),
  hasDesktopWindows: () => desktopWindows.on,
  popoutsAvailable: () => desktopWindows.on,
}));
vi.mock('@/lib/popout/open', async (original) => ({
  ...(await original<object>()),
  openComposerWindow: (account?: string | null) => {
    desktopWindows.open(account);
    return { handOver: desktopWindows.handOver, cancel: vi.fn() };
  },
}));

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
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});


const openCompose = () => fireEvent.click(screen.getByRole('button', { name: 'sidebar.compose' }));

describe('onBeforeCompose', () => {
  beforeEach(() => {
    clearAllHooks();
    composerProps.last = null;
  });

  it('opens the composer as before when no plugin listens', async () => {
    render(<MailApp />);
    openCompose();
    await screen.findByText('stub composer', {}, { timeout: 5000 });
    expect(composerProps.last?.prefill).toBeNull();
  });

  it('keeps the composer closed when a plugin returns false', async () => {
    const handler = vi.fn(() => false);
    emailHooks.onBeforeCompose.register('test', handler);
    render(<MailApp />);
    openCompose();
    await waitFor(() => expect(handler).toHaveBeenCalledTimes(1));
    await act(() => new Promise((r) => setTimeout(r, 50)));
    expect(screen.queryByText('stub composer')).not.toBeInTheDocument();
    expect(handler).toHaveBeenCalledWith({ mode: 'new', to: [], cc: [], subject: '', body: '' });
  });

  it('hands the fields a plugin returns to the composer', async () => {
    emailHooks.onBeforeCompose.register('test', (opts: Record<string, unknown>) => ({
      ...opts, to: ['carol@example.com'], subject: 'Weekly report',
    }));
    render(<MailApp />);
    openCompose();
    await screen.findByText('stub composer', {}, { timeout: 5000 });
    expect(composerProps.last?.prefill).toEqual({ to: ['carol@example.com'], subject: 'Weekly report' });
  });
});

describe('onMailtoIntercept', () => {
  beforeEach(() => {
    clearAllHooks();
    composerProps.last = null;
  });

  it('asks plugins with the link and opens the composer when they agree', async () => {
    const intercept = vi.fn(() => true);
    const before = vi.fn(() => undefined);
    emailHooks.onMailtoIntercept.register('test', intercept);
    emailHooks.onBeforeCompose.register('test', before);
    render(<MailApp />);

    let taken = false;
    act(() => { taken = requestInternalMailto('mailto:bob@example.com?subject=Hi'); });
    expect(taken).toBe(true);

    await screen.findByText('stub composer', {}, { timeout: 5000 });
    expect(intercept).toHaveBeenCalledWith({ href: 'mailto:bob@example.com?subject=Hi', to: ['bob@example.com'], subject: 'Hi' });
    expect(before).toHaveBeenCalledWith(expect.objectContaining({ mode: 'new', to: ['bob@example.com'], subject: 'Hi' }));
    expect(composerProps.last?.initialData).toEqual(expect.objectContaining({ to: 'bob@example.com', subject: 'Hi' }));
  });

  it('keeps the composer closed when a plugin returns false', async () => {
    const intercept = vi.fn(() => false);
    emailHooks.onMailtoIntercept.register('test', intercept);
    render(<MailApp />);

    let taken = false;
    act(() => { taken = requestInternalMailto('mailto:bob@example.com'); });
    // Still taken: the click must not fall through to the OS handler.
    expect(taken).toBe(true);
    await waitFor(() => expect(intercept).toHaveBeenCalledTimes(1));
    await act(() => new Promise((r) => setTimeout(r, 50)));
    expect(screen.queryByText('stub composer')).not.toBeInTheDocument();
  });
});

describe('a mail link from another program in the desktop app', () => {
  beforeEach(() => {
    clearAllHooks();
    composerProps.last = null;
    desktopWindows.on = true;
    desktopWindows.open.mockClear();
    desktopWindows.handOver.mockClear();
  });
  afterEach(() => {
    desktopWindows.on = false;
  });

  const fromOs = async () => {
    const { savePendingMailto, notifyPendingMailto } = await import('@/lib/protocol-handlers/session');
    act(() => {
      savePendingMailto({ to: ['bob@example.com'], cc: [], bcc: [], subject: 'Hi', body: 'Text', fromOs: true });
      notifyPendingMailto();
    });
  };

  it('opens in a compose window of its own, not in the main window', async () => {
    render(<MailApp />);
    await fromOs();
    await waitFor(() => expect(desktopWindows.handOver).toHaveBeenCalledTimes(1));
    expect(desktopWindows.handOver).toHaveBeenCalledWith(expect.objectContaining({
      mode: 'compose',
      initialData: expect.objectContaining({ to: 'bob@example.com', subject: 'Hi' }),
    }));
    await act(() => new Promise((r) => setTimeout(r, 50)));
    expect(screen.queryByText('stub composer')).not.toBeInTheDocument();
  });

  it('a link inside the app still opens here', async () => {
    render(<MailApp />);
    act(() => { requestInternalMailto('mailto:bob@example.com?subject=Hi'); });
    await screen.findByText('stub composer', {}, { timeout: 5000 });
    expect(desktopWindows.open).not.toHaveBeenCalled();
  });

  it('a plugin that says no keeps both closed', async () => {
    emailHooks.onBeforeCompose.register('test', () => false);
    render(<MailApp />);
    await fromOs();
    await act(() => new Promise((r) => setTimeout(r, 100)));
    expect(desktopWindows.open).not.toHaveBeenCalled();
    expect(screen.queryByText('stub composer')).not.toBeInTheDocument();
  });
});
