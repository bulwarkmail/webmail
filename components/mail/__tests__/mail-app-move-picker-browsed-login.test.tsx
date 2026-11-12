import React, { Suspense, lazy } from 'react';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
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
import { useMoveDialogStore } from '@/components/email/move-to-dialog';

/**
 * "Move to" on a message of another login's folder, browsed in the Pro
 * sidebar. The pickers must offer the folders of the login the message is
 * in. Folder ids repeat across logins on Stalwart (`a` is every Inbox, the
 * next ids repeat too): offered the active login's folders, the user picks
 * "Projects" (`c` in the active login) and the message goes into the browsed
 * login's folder `c` ("Payroll"), the right account and the wrong folder,
 * with a toast that says "Projects". Where the browsed login's folder list is
 * not loaded, nothing of the active login's list is offered either, and Move
 * says why. A single login, and the team folders of the active login, are
 * offered what they always were.
 *
 * Harness of mail-app-archive-browsed-login.test.tsx.
 */

// Translations with their values, so a toast can be read for the folder it names.
vi.mock('next-intl', () => ({
  useTranslations: () => (key: string, values?: Record<string, unknown>) => (values ? `${key} ${JSON.stringify(values)}` : key),
  useLocale: () => 'en',
  useFormatter: () => ({ dateTime: (d: unknown) => String(d), relativeTime: (d: unknown) => String(d), number: (n: number) => String(n) }),
}));

let viewerFolders: string[] | null = null;
let viewerMoveHint: string | undefined;
vi.mock('next/dynamic', () => ({ default: (load: () => Promise<React.ComponentType<Record<string, unknown>>>) => {
  const Component = lazy(async () => ({ default: await load() }));
  return function Dynamic(props: Record<string, unknown>) {
    return <Suspense fallback={null}><Component {...props} /></Suspense>;
  };
} }));
vi.mock('@/components/email/email-viewer', () => ({
  EmailViewer: ({ mailboxes, onMoveToMailbox, moveUnavailableHint }: { mailboxes?: Mailbox[]; onMoveToMailbox?: (id: string) => void; moveUnavailableHint?: string }) => {
    viewerFolders = onMoveToMailbox ? (mailboxes ?? []).map((m) => m.name) : [];
    viewerMoveHint = moveUnavailableHint;
    return (
      <div>
        reader
        {onMoveToMailbox && (mailboxes ?? []).map((m) => (
          <button key={`${m.accountId}-${m.id}`} onClick={() => onMoveToMailbox(m.id)}>{`move to ${m.name}`}</button>
        ))}
      </div>
    );
  },
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

function mailbox(id: string, role: string | undefined, accountId: string, name?: string): Mailbox {
  return {
    id, originalId: id, name: name ?? role ?? id, role, accountId, isShared: false,
    sortOrder: 0, totalEmails: 0, unreadEmails: 0, totalThreads: 0, unreadThreads: 0, isSubscribed: true,
    myRights: { mayReadItems: true, mayAddItems: true, mayRemoveItems: true, maySetSeen: true, maySetKeywords: true, mayCreateChild: true, mayRename: true, mayDelete: true, maySubmit: true },
  } as unknown as Mailbox;
}

// The active login a: its custom folder `c` is "Projects".
const aFolders = [mailbox('a', 'inbox', 'cf'), mailbox('b', 'trash', 'cf'), mailbox('c', undefined, 'cf', 'Projects')];
// Login b, browsed in the sidebar: its folder `c` is "Payroll".
const bFolders = [mailbox('a', 'inbox', 'bf'), mailbox('b', 'trash', 'bf'), mailbox('c', undefined, 'bf', 'Payroll')];
const bMessage = {
  id: 'eaaaaab', threadId: 'c', subject: 'B payroll', receivedAt: '2026-10-26T10:00:00Z',
  keywords: { $seen: true }, mailboxIds: { a: true },
} as unknown as Email;

const moveToMailboxCrossAware = vi.fn();

beforeEach(() => {
  viewerFolders = null;
  vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('Unexpected network request')));
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} });
  usePluginStore.setState({ initializePlugins: vi.fn().mockResolvedValue(undefined) });
  useThemeStore.setState({ syncServerThemes: vi.fn().mockResolvedValue(undefined) });
  useToastStore.setState({ toasts: [] });
  useMoveDialogStore.setState({ request: null });
  clearAllHooks();
  const a = {
    getAccountId: () => 'cf', getUsername: () => 'a@example.org',
    getSieveAccountId: () => null, hasDelayedSend: () => false, getSession: () => null,
    getMailboxes: vi.fn().mockResolvedValue(aFolders),
  };
  const b = { ...a, getAccountId: () => 'bf', getUsername: () => 'b@example.org', getMailboxes: vi.fn().mockResolvedValue(bFolders) };
  useAuthStore.setState({
    isAuthenticated: true, isLoading: false, client: a as never, activeAccountId: 'login-a', identities: [],
    getClientForAccount: (id: string) => (id === 'login-a' ? a : id === 'login-b' ? b : undefined) as never,
    getAllConnectedClients: () => new Map([['login-a', a], ['login-b', b]]) as never,
  });
  useSettingsStore.setState({ enableUnifiedMailbox: false, mailLayout: 'split' } as never);
  moveToMailboxCrossAware.mockReset().mockResolvedValue(true);
  useEmailStore.setState({
    emails: [bMessage], selectedEmail: bMessage, selectedMailbox: 'a', selectedKeyword: null, mailboxes: aFolders,
    viewingAccountId: 'login-b', accountMailboxes: { 'login-b': bFolders }, isUnifiedView: false, unifiedRole: null,
    isScheduledView: false, isLoadingEmail: false, isLoading: false, searchQuery: '',
    searchFilters: { ...DEFAULT_SEARCH_FILTERS }, searchMailboxId: '',
    selectedEmailKeys: new Set(),
    fetchMailboxes: vi.fn().mockResolvedValue(undefined), fetchEmails: vi.fn().mockResolvedValue(undefined),
    fetchQuota: vi.fn().mockResolvedValue(undefined), fetchTagCounts: vi.fn().mockResolvedValue(undefined),
    refreshScheduledMetadata: vi.fn().mockResolvedValue(undefined),
    fetchAccountMailboxes: vi.fn().mockResolvedValue(undefined),
    moveToMailboxCrossAware,
  } as never);
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('"Move to" on a message of another login browsed in the sidebar', () => {
  it('the reader offers that login\'s folders, not the active login\'s', async () => {
    render(<MailApp />);
    await screen.findByText('reader', {}, { timeout: 5000 });
    expect(viewerFolders).toContain('Payroll');
    expect(viewerFolders).not.toContain('Projects');
  });

  it('the Move dialog offers that login\'s folders, not the active login\'s', async () => {
    render(<MailApp />);
    await screen.findByText('reader', {}, { timeout: 5000 });
    await act(async () => { useMoveDialogStore.getState().open({ emails: [bMessage], onMove: () => {} } as never); });
    await waitFor(() => expect(screen.queryAllByText(/Payroll|Projects/).length).toBeGreaterThan(0));
    expect(screen.queryByText('Projects')).toBeNull();
    expect(screen.getAllByText('Payroll').length).toBeGreaterThan(0);
  });

  it('while that login\'s folder list is not loaded, offers none of the active login\'s folders', async () => {
    useEmailStore.setState({ accountMailboxes: {} } as never);
    render(<MailApp />);
    await screen.findByText('reader', {}, { timeout: 5000 });
    expect(viewerFolders ?? []).not.toContain('Projects');
    expect(screen.queryByText('move to Projects')).toBeNull();
  });

  it('control: the active login\'s own message is offered the active login\'s folders', async () => {
    useEmailStore.setState({ viewingAccountId: null, accountMailboxes: {} } as never);
    render(<MailApp />);
    await screen.findByText('reader', {}, { timeout: 5000 });
    expect(viewerFolders).toContain('Projects');
    fireEvent.click(screen.getByText('move to Projects'));
    await waitFor(() => expect(moveToMailboxCrossAware).toHaveBeenCalled());
    expect(moveToMailboxCrossAware.mock.calls[0][2]).toBe('c');
  });

  it('a move to that login\'s folder goes there, and the toast names that folder', async () => {
    render(<MailApp />);
    await screen.findByText('reader', {}, { timeout: 5000 });
    fireEvent.click(screen.getByText('move to Payroll'));
    await waitFor(() => expect(moveToMailboxCrossAware).toHaveBeenCalled());
    expect(moveToMailboxCrossAware.mock.calls[0][2]).toBe('c');
    const titles = useToastStore.getState().toasts.map((toast) => toast.title);
    expect(titles.some((title) => title.includes('Payroll'))).toBe(true);
    expect(titles.some((title) => title.includes('Projects'))).toBe(false);
  });

  it('while that login\'s folder list is not loaded, the reader says why Move is not offered', async () => {
    useEmailStore.setState({ accountMailboxes: {} } as never);
    render(<MailApp />);
    await screen.findByText('reader', {}, { timeout: 5000 });
    expect(viewerFolders).toEqual([]);
    expect(viewerMoveHint).toBe('not_connected');
  });
});

describe('"Move to" with one login, and in a team folder of the active login', () => {
  const team = [
    { ...mailbox('a', 'inbox', 'ce'), id: 'ce:a', isShared: true },
    { ...mailbox('k', undefined, 'ce', 'Team projects'), id: 'ce:k', isShared: true },
  ] as Mailbox[];

  it('offers the active login\'s own and team folders, as before', async () => {
    useEmailStore.setState({
      viewingAccountId: null, accountMailboxes: {}, mailboxes: [...aFolders, ...team], selectedMailbox: 'ce:a',
      emails: [{ ...bMessage, mailboxIds: { 'ce:a': true } }], selectedEmail: { ...bMessage, mailboxIds: { 'ce:a': true } },
    } as never);
    render(<MailApp />);
    await screen.findByText('reader', {}, { timeout: 5000 });
    expect(viewerFolders).toEqual(expect.arrayContaining(['Projects', 'Team projects']));
    expect(viewerMoveHint).toBeUndefined();
    fireEvent.click(screen.getByText('move to Team projects'));
    await waitFor(() => expect(moveToMailboxCrossAware).toHaveBeenCalled());
    expect(moveToMailboxCrossAware.mock.calls[0][2]).toBe('ce:k');
  });

  it('offers a single login\'s folders and no hint, as before', async () => {
    const a = useAuthStore.getState().getClientForAccount('login-a');
    useAuthStore.setState({
      getClientForAccount: ((id: string) => (id === 'login-a' ? a : undefined)) as never,
      getAllConnectedClients: (() => new Map([['login-a', a]])) as never,
    });
    useEmailStore.setState({ viewingAccountId: null, accountMailboxes: {} } as never);
    render(<MailApp />);
    await screen.findByText('reader', {}, { timeout: 5000 });
    expect(viewerFolders).toEqual(['inbox', 'trash', 'Projects']);
    expect(viewerMoveHint).toBeUndefined();
  });
});
