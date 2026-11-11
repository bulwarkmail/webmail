import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import React from 'react';

/**
 * A Pro folder tab and the login it belongs to, beyond
 * pro-folder-tab-login-removed.test.tsx (same harness).
 *
 * A folder dragged from the active login's own folders carries no login in
 * its drag payload (the sidebar writes `accountId: null` for the active
 * login). The tab it opens is still that login's folder: when another login
 * becomes the active one (an account switch, a link that switches, the first
 * login signed out), the tab must not list the other login's folder with the
 * same id under the same tab.
 *
 * The shell names the active login when it opens the tab
 * (droppedFolderTab). Tabs kept from before still carry no login, and the
 * tab itself does not follow the active login either: it is the only
 * login's where there is one, and otherwise says that it has none.
 */

vi.mock('@/components/pro/pro-email-tab-body', () => ({ ProEmailView: () => null }));
vi.mock('@/components/email/email-viewer', () => ({ EmailViewer: () => null }));
vi.mock('next-intl', () => ({ useTranslations: () => (key: string) => key }));
vi.mock('@/hooks/use-media-query', () => ({ useDeviceDetection: () => ({ isMobile: false }) }));
vi.mock('@/hooks/use-pane-context', () => ({ usePaneId: () => 'main' }));
vi.mock('@/lib/utils', async (importOriginal) => ({
  ...await importOriginal<typeof import('@/lib/utils')>(),
  formatDate: () => 'today',
}));

import { useAuthStore } from '@/stores/auth-store';
import { useAccountStore } from '@/stores/account-store';
import { useEmailStore } from '@/stores/email-store';
import { ProFolderTabBody } from '../pro-folder-tab-body';
import { droppedFolderTab } from '../pro-tab-address';

const entry =(username: string, isDefault: boolean) => ({
  label: username, serverUrl: 'https://mail.example.org', username, authMode: 'basic' as const,
  rememberMe: false, displayName: username, email: username, lastLoginAt: 0,
  isConnected: true, hasError: false, isDefault,
});
const inbox = (accountId: string) => ({ id: 'a', name: 'Inbox', role: 'inbox', totalEmails: 1, unreadEmails: 1, accountId });
const row = (subject: string) => ({ id: 'eaaaaab', threadId: 't', subject, receivedAt: '2026-11-11T10:00:00Z', keywords: {}, mailboxIds: { a: true } });
const client = (account: string, subject: string) => ({
  getAccountId: () => account,
  getEmails: vi.fn().mockResolvedValue({ emails: [row(subject)], total: 1, hasMore: false }),
  markAsRead: vi.fn(),
});

const original = { auth: useAuthStore.getState(), email: useEmailStore.getState(), accounts: useAccountStore.getState() };

describe('a Pro folder tab and the active login', () => {
  let a: string;
  let b: string;
  let clientA: ReturnType<typeof client>;
  let clientB: ReturnType<typeof client>;
  let connected: Map<string, ReturnType<typeof client>>;

  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status: 200 })));
    useAccountStore.setState({ accounts: [], activeAccountId: null, defaultAccountId: null });
    a = useAccountStore.getState().addAccount(entry('a@example.org', true));
    b = useAccountStore.getState().addAccount(entry('b@example.org', false));
    useAccountStore.getState().setActiveAccount(a);
    clientA = client('ee', 'A private note');
    clientB = client('ef', 'B payroll');
    connected = new Map([[a, clientA], [b, clientB]]);
    const lookup = (id: string) => connected.get(id) as never;
    useAuthStore.setState({ isAuthenticated: true, activeAccountId: a, client: clientA as never, getClientForAccount: lookup } as never);
    useEmailStore.setState({ mailboxes: [inbox('ee')], accountMailboxes: { [b]: [inbox('ef')] } } as never);
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    useAuthStore.setState(original.auth);
    useEmailStore.setState(original.email);
    useAccountStore.setState(original.accounts);
  });

  // What a drop of the active login's folder on the shell opens: the drag
  // payload names no login, the tab names the login active at the drop.
  const droppedOwnInbox = () => {
    const data = droppedFolderTab({ mailboxId: 'a', name: 'Inbox', accountId: null });
    expect(data).toEqual({ accountId: a, mailboxId: 'a', title: 'Inbox' });
    return data!;
  };
  // Both logins listed and connected, b the active one, as switchAccount leaves the stores.
  const switchToB = () => {
    useAccountStore.getState().setActiveAccount(b);
    useEmailStore.setState({ mailboxes: [inbox('ef')], accountMailboxes: { [a]: [inbox('ee')] } } as never);
    useAuthStore.setState((state) => ({ activeAccountId: b, client: clientB as never, connectedAccountsRevision: (state.connectedAccountsRevision ?? 0) + 1 }) as never);
  };

  it("a tab of the active login's folder does not turn into the other login's folder when that one becomes active", async () => {
    render(<ProFolderTabBody tabId="tab-1" data={droppedOwnInbox()} />);
    await waitFor(() => expect(screen.getByText('A private note')).toBeTruthy());

    // The user switches to login b (what switchAccount leaves in the stores).
    act(() => {
      useAccountStore.getState().setActiveAccount(b);
      useEmailStore.setState({ mailboxes: [inbox('ef')], accountMailboxes: { [a]: [inbox('ee')] } } as never);
      useAuthStore.setState((state) => ({ activeAccountId: b, client: clientB as never, connectedAccountsRevision: (state.connectedAccountsRevision ?? 0) + 1 }) as never);
    });
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 50)); });

    expect(clientB.getEmails).not.toHaveBeenCalled();
    expect(screen.queryByText('B payroll')).toBeNull();
    // Still login a's folder, listed through login a.
    expect(screen.getByText('A private note')).toBeTruthy();
  });

  it("the same when the login the tab was opened under is signed out and the other one takes over", async () => {
    render(<ProFolderTabBody tabId="tab-1" data={droppedOwnInbox()} />);
    await waitFor(() => expect(screen.getByText('A private note')).toBeTruthy());

    act(() => {
      connected.delete(a);
      useAccountStore.getState().setActiveAccount(b);
      useEmailStore.setState({ mailboxes: [inbox('ef')], accountMailboxes: {} } as never);
      useAuthStore.setState((state) => ({ activeAccountId: b, client: clientB as never, connectedAccountsRevision: (state.connectedAccountsRevision ?? 0) + 1 }) as never);
    });
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 50)); });

    expect(clientB.getEmails).not.toHaveBeenCalled();
    expect(screen.queryByText('B payroll')).toBeNull();
  });

  it("a tab that names a login keeps listing that login's folder when another login becomes active", async () => {
    render(<ProFolderTabBody tabId="tab-1" data={{ accountId: b, mailboxId: 'a', title: 'Inbox' }} />);
    await waitFor(() => expect(screen.getByText('B payroll')).toBeTruthy());
    expect(clientA.getEmails).not.toHaveBeenCalled();
  });

  it("a tab of a login without a client lists its folder once the login is connected", async () => {
    connected.delete(b);
    render(<ProFolderTabBody tabId="tab-1" data={{ accountId: b, mailboxId: 'a', title: 'Inbox' }} />);
    expect(screen.getByText('not_connected')).toBeTruthy();
    act(() => {
      connected.set(b, clientB);
      useAuthStore.setState((state) => ({ connectedAccountsRevision: (state.connectedAccountsRevision ?? 0) + 1 }) as never);
    });
    await waitFor(() => expect(screen.getByText('B payroll')).toBeTruthy());
    expect(clientA.getEmails).not.toHaveBeenCalled();
  });

  // A tab kept from a version that wrote no login for the active one.
  describe('a tab kept from before, which names no login', () => {
    const kept = { accountId: null, mailboxId: 'a', title: 'Inbox' };

    it('with two logins signed in lists nothing, says so, and still lists nothing after an account switch', async () => {
      render(<ProFolderTabBody tabId="tab-1" data={kept} />);
      await act(async () => { await new Promise((resolve) => setTimeout(resolve, 30)); });
      expect(screen.getByText('tab_names_no_account')).toBeTruthy();
      expect(clientA.getEmails).not.toHaveBeenCalled();

      act(switchToB);
      await act(async () => { await new Promise((resolve) => setTimeout(resolve, 30)); });
      expect(screen.getByText('tab_names_no_account')).toBeTruthy();
      expect(clientA.getEmails).not.toHaveBeenCalled();
      expect(clientB.getEmails).not.toHaveBeenCalled();
    });

    it('with one login signed in is that login\'s, and stays its folder when a second one signs in and becomes active', async () => {
      useAccountStore.getState().removeAccount(b);
      connected.delete(b);
      expect(useAccountStore.getState().accounts).toHaveLength(1);
      render(<ProFolderTabBody tabId="tab-1" data={kept} />);
      await waitFor(() => expect(screen.getByText('A private note')).toBeTruthy());

      act(() => {
        b = useAccountStore.getState().addAccount(entry('b@example.org', false));
        connected.set(b, clientB);
        switchToB();
      });
      await act(async () => { await new Promise((resolve) => setTimeout(resolve, 50)); });
      expect(clientB.getEmails).not.toHaveBeenCalled();
      expect(screen.queryByText('B payroll')).toBeNull();
      expect(screen.getByText('A private note')).toBeTruthy();
    });
  });
});
