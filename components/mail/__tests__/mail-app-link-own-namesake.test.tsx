import React, { Suspense, lazy } from 'react';
import { act, render, screen } from '@testing-library/react';
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
import { resetOpenEmail } from '@/lib/plugin-sandbox/open-email';
import { openMailLink, resetMailLinks } from '@/lib/desktop/mail-links';
import { EmbeddedContext } from '@/hooks/use-is-embedded';
import { useProTabStore } from '@/stores/pro-tab-store';

// A link to a message that names no owner account means the login's own
// account (a new-mail notification, a permalink, a search hit in the standard
// layout). It must open that message whatever folder is listed: here a team
// mailbox's Inbox is on screen and holds a message with the same id.
// The harness is the one of mail-app-plugin-open-email.test.tsx.

vi.mock('next/dynamic', () => ({ default: (load: () => Promise<React.ComponentType<Record<string, unknown>>>) => {
  const Component = lazy(async () => ({ default: await load() }));
  return function Dynamic(props: Record<string, unknown>) {
    return <Suspense fallback={null}><Component {...props} /></Suspense>;
  };
} }));
vi.mock('@/components/email/email-viewer', () => ({ EmailViewer: () => <div>reader</div> }));
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

function mailbox(id: string, role: string | undefined, accountId: string, shared = false): Mailbox {
  return {
    id: shared ? `${accountId}:${id}` : id, originalId: id, name: role ?? id, role, accountId, isShared: shared,
    sortOrder: 0, totalEmails: 0, unreadEmails: 0, totalThreads: 0, unreadThreads: 0, isSubscribed: true,
  } as Mailbox;
}

// The active login's folders: its own account `cf` and the group `ce`.
const folders = [mailbox('a', 'inbox', 'cf'), mailbox('a', 'inbox', 'ce', true)];

// The group's Inbox message, as Email/get gives it.
const groupMessage = {
  id: 'eaaaaab', threadId: 'c', subject: 'GRP one', receivedAt: '2026-10-26T10:00:00Z',
  keywords: { $seen: true }, mailboxIds: { a: true }, bodyValues: {},
} as unknown as Email;

let client: Record<string, unknown>;

/** The group account has `eaaaaab`, the own account nothing. */
const getEmail = vi.fn(async (id: string, accountId?: string) =>
  id === 'eaaaaab' && accountId === 'ce' ? { ...groupMessage } : null);

beforeEach(() => {
  vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('Unexpected network request')));
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} });
  usePluginStore.setState({ initializePlugins: vi.fn().mockResolvedValue(undefined) });
  useThemeStore.setState({ syncServerThemes: vi.fn().mockResolvedValue(undefined) });
  useToastStore.setState({ toasts: [] });
  clearAllHooks();
  resetOpenEmail();
  getEmail.mockClear();
  client = {
    getAccountId: () => 'cf', getUsername: () => 'a@example.org',
    getSieveAccountId: () => null, hasDelayedSend: () => false, getSession: () => null,
    getMailboxes: vi.fn().mockResolvedValue(folders),
    getEmail,
    getSharedAccounts: () => ['cf', 'ce'].map((id) => ({ id, name: id, isPrimary: id === 'cf', capabilities: { mail: true } })),
  };
  useAuthStore.setState({
    isAuthenticated: true, isLoading: false, client: client as never, activeAccountId: 'login-a', identities: [],
    getClientForAccount: (id: string) => (id === 'login-a' ? client : undefined) as never,
    getAllConnectedClients: () => new Map([['login-a', client]]) as never,
  });
  useSettingsStore.setState({ enableUnifiedMailbox: false, mailLayout: 'split', archiveMode: 'single', deleteAction: 'trash' } as never);
  useEmailStore.setState({
    emails: [], selectedEmail: null, selectedMailbox: 'a', selectedKeyword: null, mailboxes: folders,
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

const ownMessage = { ...groupMessage, subject: 'OWN private note' } as unknown as Email;
const teamMessage = { ...groupMessage, subject: 'TEAM customer order' } as unknown as Email;

describe('a link to an own message while a team folder lists a message with the same id', () => {
  beforeEach(() => {
    resetMailLinks();
    getEmail.mockImplementation(async (id: string, accountId?: string) =>
      id !== 'eaaaaab' ? null : accountId === 'ce' ? { ...teamMessage } : { ...ownMessage });
    useEmailStore.setState({ selectedMailbox: 'ce:a', emails: [{ ...teamMessage }] } as never);
  });

  it('opens the own message, not the listed one', async () => {
    render(<MailApp />);
    await screen.findByText('message list', {}, { timeout: 5000 });

    await act(async () => {
      openMailLink({ kind: 'message', id: 'eaaaaab' }, undefined, () => {});
      await new Promise((resolve) => setTimeout(resolve, 50));
    });

    const calls = getEmail.mock.calls.filter(([id]) => id === 'eaaaaab');
    expect(calls.length).toBeGreaterThan(0);
    for (const [, accountId] of calls) expect(accountId ?? 'cf').toBe('cf');
    expect(useEmailStore.getState().selectedEmail?.subject).toBe('OWN private note');
  });

  // Control: a link that names the team account still opens the team's message.
  it('opens the team message when the link names the team account', async () => {
    render(<MailApp />);
    await screen.findByText('message list', {}, { timeout: 5000 });

    await act(async () => {
      openMailLink({ kind: 'message', id: 'eaaaaab', ownerAccountId: 'ce' }, undefined, () => {});
      await new Promise((resolve) => setTimeout(resolve, 50));
    });

    expect(useEmailStore.getState().selectedEmail?.subject).toBe('TEAM customer order');
  });

  it('the list moves to the own folder that holds it, not the team folder with that folder id', async () => {
    // The team's Inbox listed first: its server id is the own Inbox's.
    useEmailStore.setState({ mailboxes: [folders[1], folders[0]] } as never);
    render(<MailApp />);
    await screen.findByText('message list', {}, { timeout: 5000 });

    await act(async () => {
      openMailLink({ kind: 'message', id: 'eaaaaab' }, undefined, () => {});
      await new Promise((resolve) => setTimeout(resolve, 50));
    });

    expect(useEmailStore.getState().selectedMailbox).toBe('a');
    expect(useEmailStore.getState().selectedEmail?.subject).toBe('OWN private note');
  });

  it('a link to a conversation opens its newest message in the own account', async () => {
    client.getThreadEmails = vi.fn(async () => [{ ...ownMessage }]);
    render(<MailApp />);
    await screen.findByText('message list', {}, { timeout: 5000 });

    await act(async () => {
      openMailLink({ kind: 'thread', id: 'c' }, undefined, () => {});
      await new Promise((resolve) => setTimeout(resolve, 50));
    });

    const calls = getEmail.mock.calls.filter(([id]) => id === 'eaaaaab');
    expect(calls.length).toBeGreaterThan(0);
    for (const [, accountId] of calls) expect(accountId ?? 'cf').toBe('cf');
    expect(useEmailStore.getState().selectedEmail?.subject).toBe('OWN private note');
  });

  it('in the Pro shell, the message tab names the login, so it reads the own message', async () => {
    const before = useProTabStore.getState().tabs.length;
    render(<EmbeddedContext.Provider value><MailApp /></EmbeddedContext.Provider>);
    await screen.findByText('message list', {}, { timeout: 5000 });

    await act(async () => {
      openMailLink({ kind: 'message', id: 'eaaaaab' }, undefined, () => {});
      await new Promise((resolve) => setTimeout(resolve, 50));
    });

    const tabs = useProTabStore.getState().tabs;
    expect(tabs.length).toBeGreaterThan(before);
    expect(tabs.find((tab) => tab.emailData?.emailId === 'eaaaaab')?.emailData).toMatchObject({ clientAccountId: 'login-a', accountId: '' });
  });
});
