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

// Actions on the open message act in its own login and account. Stalwart
// numbers every account's folders and messages alike (Inbox `a`, Deleted
// Items `b`, first message `eaaaaab`), so a folder or message picked from
// another account's list names something else there.

vi.mock('next/dynamic', () => ({ default: (load: () => Promise<React.ComponentType<Record<string, unknown>>>) => {
  const Component = lazy(async () => ({ default: await load() }));
  return function Dynamic(props: Record<string, unknown>) {
    return <Suspense fallback={null}><Component {...props} /></Suspense>;
  };
} }));
vi.mock('@/components/email/email-viewer', () => ({
  EmailViewer: ({ onArchive, onDelete, onReply }: { onArchive?: () => void; onDelete?: () => void; onReply?: () => void }) => (
    <div>
      <button onClick={() => onArchive?.()}>stub archive</button>
      <button onClick={() => onDelete?.()}>stub delete</button>
      <button onClick={() => onReply?.()}>stub reply</button>
    </div>
  ),
}));
vi.mock('@/components/email/email-composer', () => ({
  EmailComposer: ({ onSend, onDiscardDraft }: {
    onSend?: (data: unknown) => Promise<void>;
    onDiscardDraft?: (id: string, draft?: { accountId?: string; localAccountId?: string }) => void;
  }) => (
    <div>
      <button onClick={() => { void onSend?.({ to: ['c@example.org'], cc: [], bcc: [], subject: 'Re: GRP one', body: 'Hi' }); }}>
        stub send
      </button>
      {/* A draft login B saved in its own account `cg`. */}
      <button onClick={() => onDiscardDraft?.('maaaaad', { accountId: 'cg', localAccountId: 'login-b' })}>stub discard</button>
    </div>
  ),
}));
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
const folders = [
  mailbox('a', 'inbox', 'cf'), mailbox('b', 'trash', 'cf'), mailbox('i', 'archive', 'cf'),
  mailbox('a', 'inbox', 'ce', true), mailbox('b', 'trash', 'ce', true), mailbox('k', 'archive', 'ce', true),
];

// The group's message, opened in the Red tag view, which lists own and group
// messages together and stamps each with its login and account.
const groupMessage = {
  id: 'eaaaaab', threadId: 'c', subject: 'GRP one', receivedAt: '2026-10-26T10:00:00Z',
  keywords: { $seen: true, '$label:red': true }, mailboxIds: { 'ce:a': true },
  sourceClientAccountId: 'login-a', sourceAccountId: 'ce',
} as unknown as Email;

let client: Record<string, unknown>;
const moveToMailbox = vi.fn();
const moveThreadToMailbox = vi.fn();

beforeEach(() => {
  vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('Unexpected network request')));
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} });
  usePluginStore.setState({ initializePlugins: vi.fn().mockResolvedValue(undefined) });
  useThemeStore.setState({ syncServerThemes: vi.fn().mockResolvedValue(undefined) });
  useToastStore.setState({ toasts: [] });
  clearAllHooks();
  client = {
    getAccountId: () => 'cf', getUsername: () => 'a@example.org',
    getSieveAccountId: () => null, hasDelayedSend: () => false, getSession: () => null,
    getMailboxes: vi.fn().mockResolvedValue(folders),
  };
  useAuthStore.setState({
    isAuthenticated: true, isLoading: false, client: client as never, activeAccountId: 'login-a', identities: [],
    getClientForAccount: (id: string) => (id === 'login-a' ? client : undefined) as never,
    getAllConnectedClients: () => new Map([['login-a', client]]) as never,
  });
  useSettingsStore.setState({ enableUnifiedMailbox: false, mailLayout: 'split', archiveMode: 'single', deleteAction: 'trash' } as never);
  moveToMailbox.mockReset().mockResolvedValue(true);
  moveThreadToMailbox.mockReset().mockResolvedValue(true);
  useEmailStore.setState({
    emails: [groupMessage], selectedEmail: groupMessage, selectedMailbox: '', selectedKeyword: 'red', mailboxes: folders,
    viewingAccountId: null, accountMailboxes: {}, isUnifiedView: false, unifiedRole: null,
    isScheduledView: false, isLoadingEmail: false, isLoading: false, searchQuery: '',
    searchFilters: { ...DEFAULT_SEARCH_FILTERS }, searchMailboxId: '',
    selectedEmailKeys: new Set(),
    fetchMailboxes: vi.fn().mockResolvedValue(undefined), fetchEmails: vi.fn().mockResolvedValue(undefined),
    fetchQuota: vi.fn().mockResolvedValue(undefined), fetchTagCounts: vi.fn().mockResolvedValue(undefined),
    refreshScheduledMetadata: vi.fn().mockResolvedValue(undefined),
    moveToMailbox, moveThreadToMailbox,
  } as never);
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('a reply to a message of the group\'s Inbox', () => {
  it('flags the group\'s message as answered after the own Inbox, with its own message of that id, was opened', async () => {
    const setKeyword = vi.fn().mockResolvedValue(undefined);
    client.setKeyword = setKeyword;
    const sendEmail = vi.fn().mockResolvedValue({ scheduled: false });
    const unstamped = { ...groupMessage, sourceClientAccountId: undefined, sourceAccountId: undefined } as Email;
    useEmailStore.setState({ selectedMailbox: 'ce:a', selectedKeyword: null, emails: [unstamped], selectedEmail: unstamped, sendEmail } as never);

    render(<MailApp />);
    fireEvent.click(await screen.findByText('stub reply', {}, { timeout: 5000 }));
    const send = await screen.findByText('stub send', {}, { timeout: 5000 });
    // The own Inbox is opened while the reply is written.
    const ownMessage = { ...unstamped, subject: 'A own one', mailboxIds: { a: true } } as Email;
    act(() => { useEmailStore.setState({ selectedMailbox: 'a', emails: [ownMessage], selectedEmail: null } as never); });
    fireEvent.click(send);

    await waitFor(() => expect(setKeyword).toHaveBeenCalled());
    expect(setKeyword).toHaveBeenCalledWith('eaaaaab', '$answered', 'ce');
  });
});

describe('discarding a draft another login saved', () => {
  it('deletes it through that login', async () => {
    const other = { deleteEmail: vi.fn().mockResolvedValue(undefined) };
    client.deleteEmail = vi.fn();
    useAuthStore.setState({ getClientForAccount: (id: string) => (id === 'login-a' ? client : id === 'login-b' ? other : undefined) as never });

    render(<MailApp />);
    fireEvent.click(await screen.findByText('stub reply', {}, { timeout: 5000 }));
    fireEvent.click(await screen.findByText('stub discard', {}, { timeout: 5000 }));

    await waitFor(() => expect(other.deleteEmail).toHaveBeenCalledWith('maaaaad', 'cg'));
    expect(client.deleteEmail).not.toHaveBeenCalled();
  });

  it('leaves it alone, and says so, once that login is gone', async () => {
    client.deleteEmail = vi.fn();

    render(<MailApp />);
    fireEvent.click(await screen.findByText('stub reply', {}, { timeout: 5000 }));
    fireEvent.click(await screen.findByText('stub discard', {}, { timeout: 5000 }));

    await waitFor(() => expect(useToastStore.getState().toasts.map(t => t.title)).toContain('email_composer.discard_signed_out'));
    expect(client.deleteEmail).not.toHaveBeenCalled();
  });
});

describe('the open message of a group account in a tag view', () => {
  it('is archived into the group\'s Archive, not the own one', async () => {
    render(<MailApp />);
    fireEvent.click(await screen.findByText('stub archive', {}, { timeout: 5000 }));
    await waitFor(() => expect(moveThreadToMailbox).toHaveBeenCalled());
    expect(moveThreadToMailbox).toHaveBeenCalledWith(client, 'eaaaaab', 'ce:k', 'login-a/ce:eaaaaab');
  });

  it('is deleted into the group\'s Deleted Items, not the own one', async () => {
    render(<MailApp />);
    fireEvent.click(await screen.findByText('stub delete', {}, { timeout: 5000 }));
    await waitFor(() => expect(moveToMailbox).toHaveBeenCalled());
    expect(moveToMailbox).toHaveBeenCalledWith(client, 'eaaaaab', 'ce:b', 'login-a/ce:eaaaaab');
  });
});

describe('archiving a group message by month', () => {
  // The group's Archive `k` already holds 2026/10, as the list names them:
  // store ids and parents namespaced `ce:...`, the server's ids bare.
  const year = { ...mailbox('y1', undefined, 'ce', true), name: '2026', parentId: 'ce:k' };
  const month = { ...mailbox('m1', undefined, 'ce', true), name: '10', parentId: 'ce:y1' };
  const withMonth = [...folders, year, month] as Mailbox[];

  beforeEach(() => {
    useSettingsStore.setState({ archiveMode: 'month' } as never);
    client.createMailbox = vi.fn();
  });

  it('reuses the year and month folders in a tag view', async () => {
    useEmailStore.setState({ mailboxes: withMonth } as never);
    render(<MailApp />);
    fireEvent.click(await screen.findByText('stub archive', {}, { timeout: 5000 }));
    await waitFor(() => expect(moveThreadToMailbox).toHaveBeenCalled());
    expect(client.createMailbox).not.toHaveBeenCalled();
    expect(moveThreadToMailbox).toHaveBeenCalledWith(client, 'eaaaaab', 'ce:m1', 'login-a/ce:eaaaaab');
  });

  it('reuses them with the group\'s Inbox open', async () => {
    const unstamped = { ...groupMessage, sourceClientAccountId: undefined, sourceAccountId: undefined } as Email;
    useEmailStore.setState({ mailboxes: withMonth, selectedMailbox: 'ce:a', selectedKeyword: null, emails: [unstamped], selectedEmail: unstamped } as never);
    render(<MailApp />);
    fireEvent.click(await screen.findByText('stub archive', {}, { timeout: 5000 }));
    await waitFor(() => expect(moveThreadToMailbox).toHaveBeenCalled());
    expect(client.createMailbox).not.toHaveBeenCalled();
    expect(moveThreadToMailbox).toHaveBeenCalledWith(client, 'eaaaaab', 'ce:m1', 'eaaaaab');
  });

  // The own account has a folder with the server id of the group's Archive,
  // with 2026/10 below it (live on 0.16: a's "Shared" folder is `h`, and so
  // was the group's Archive).
  it('does not take the own account\'s namesake folders', async () => {
    const unstamped = { ...groupMessage, sourceClientAccountId: undefined, sourceAccountId: undefined } as Email;
    const ownNamesakes = [
      { ...mailbox('k', undefined, 'cf'), name: 'Shared' },
      { ...mailbox('oy', undefined, 'cf'), name: '2026', parentId: 'k' },
      { ...mailbox('om', undefined, 'cf'), name: '10', parentId: 'oy' },
    ];
    useEmailStore.setState({ mailboxes: [...ownNamesakes, ...withMonth], selectedMailbox: 'ce:a', selectedKeyword: null, emails: [unstamped], selectedEmail: unstamped } as never);
    render(<MailApp />);
    fireEvent.click(await screen.findByText('stub archive', {}, { timeout: 5000 }));
    await waitFor(() => expect(moveThreadToMailbox).toHaveBeenCalled());
    expect(moveThreadToMailbox).toHaveBeenCalledWith(client, 'eaaaaab', 'ce:m1', 'eaaaaab');
  });

  it('creates a missing year folder in the group account with the group\'s Inbox open', async () => {
    const unstamped = { ...groupMessage, sourceClientAccountId: undefined, sourceAccountId: undefined } as Email;
    useSettingsStore.setState({ archiveMode: 'year' } as never);
    (client.createMailbox as ReturnType<typeof vi.fn>).mockResolvedValue({ ...mailbox('y2', undefined, 'ce', true), id: 'y2', name: '2026' });
    useEmailStore.setState({ selectedMailbox: 'ce:a', selectedKeyword: null, emails: [unstamped], selectedEmail: unstamped } as never);
    render(<MailApp />);
    fireEvent.click(await screen.findByText('stub archive', {}, { timeout: 5000 }));
    await waitFor(() => expect(client.createMailbox).toHaveBeenCalled());
    expect(client.createMailbox).toHaveBeenCalledWith('2026', 'k', 'ce', undefined);
  });
});
