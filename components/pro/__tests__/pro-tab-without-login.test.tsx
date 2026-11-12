import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import React from 'react';
import type { Email } from '@/lib/jmap/types';

/**
 * A Pro message tab kept from a version that wrote no login into it. Its id
 * names another message in every login, so the tab is the only login's where
 * one login is signed in, and nobody's where several are: it then reads
 * nothing and says so, whichever login is active. Once it has a login it
 * keeps it. Harness of pro-email-tab-login-removed.test.tsx.
 */

vi.mock('@/components/email/email-viewer', () => ({
  EmailViewer: (props: Record<string, unknown>) => <div>{(props.email as Email | null)?.subject}</div>,
}));
vi.mock('@/components/error', () => ({
  ErrorBoundary: ({ children }: { children: React.ReactNode }) => React.createElement(React.Fragment, null, children),
  EmailViewerErrorFallback: () => null,
}));
vi.mock('next-intl', () => ({ useTranslations: (ns?: string) => (key: string) => (ns ? `${ns}.${key}` : key), useLocale: () => 'en' }));

import { useAuthStore } from '@/stores/auth-store';
import { useAccountStore } from '@/stores/account-store';
import { useEmailStore } from '@/stores/email-store';
import { useProTabStore, type ProTab } from '@/stores/pro-tab-store';
import { ProEmailTabBody } from '../pro-email-tab-body';

const ID = 'eaaaaab';
const message = (subject: string) => ({
  id: ID, threadId: 't', subject, receivedAt: '2026-11-11T10:00:00Z', keywords: { $seen: true }, mailboxIds: { a: true },
  from: [{ email: 'sam@example.org' }], to: [{ email: 'me@example.org' }],
  bodyValues: {}, textBody: [], htmlBody: [], attachments: [], size: 10,
}) as unknown as Email;
const entry = (username: string, isDefault: boolean) => ({
  label: username, serverUrl: 'https://mail.example.org', username, authMode: 'basic' as const,
  rememberMe: false, displayName: username, email: username, lastLoginAt: 0,
  isConnected: true, hasError: false, isDefault,
});
const client = (account: string, subject: string) => ({
  getAccountId: () => account, getUsername: () => `${account}@example.org`, getServerUrl: () => 'https://mail.example.org',
  getEmail: vi.fn(async () => message(subject)), getThreadEmails: vi.fn(async () => []), getThread: vi.fn(async () => null),
  getIdentities: vi.fn(async () => []), getMailboxes: vi.fn(async () => []),
  moveToTrash: vi.fn(async () => {}), toggleStar: vi.fn(async () => {}), markAsRead: vi.fn(async () => {}),
});
const keptTab = (): ProTab => ({
  id: 't1', kind: 'email', labelKey: '', title: 'A note', closeable: true, paneId: 'main',
  emailData: { accountId: '', emailId: ID, mailboxId: null, title: 'A note' },
});
const tabData = () => useProTabStore.getState().tabs.find((tab) => tab.id === 't1')!.emailData!;
const settle = () => act(async () => { await new Promise((resolve) => setTimeout(resolve, 30)); });

const original = {
  auth: useAuthStore.getState(), email: useEmailStore.getState(), accounts: useAccountStore.getState(), tabs: useProTabStore.getState().tabs,
};

describe('a Pro message tab that names no login', () => {
  let a: string;
  let b: string;
  let clientA: ReturnType<typeof client>;
  let clientB: ReturnType<typeof client>;
  let connected: Map<string, ReturnType<typeof client>>;

  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status: 200 })));
    useAccountStore.setState({ accounts: [], activeAccountId: null, defaultAccountId: null });
    a = useAccountStore.getState().addAccount(entry('a@example.org', true));
    useAccountStore.getState().setActiveAccount(a);
    clientA = client('ee', 'A note');
    clientB = client('ef', 'B payroll');
    connected = new Map([[a, clientA]]);
    const lookup = (id: string) => connected.get(id) as never;
    useAuthStore.setState({ isAuthenticated: true, activeAccountId: a, client: clientA as never, getClientForAccount: lookup } as never);
    useProTabStore.setState({ tabs: [keptTab()] });
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    useAuthStore.setState(original.auth);
    useEmailStore.setState(original.email);
    useAccountStore.setState(original.accounts);
    useProTabStore.setState({ tabs: original.tabs });
  });

  const signInB = (active: boolean) => {
    b = useAccountStore.getState().addAccount(entry('b@example.org', false));
    connected.set(b, clientB);
    if (active) {
      useAccountStore.getState().setActiveAccount(b);
      useAuthStore.setState((state) => ({ activeAccountId: b, client: clientB as never, connectedAccountsRevision: (state.connectedAccountsRevision ?? 0) + 1 }) as never);
    }
  };

  it('with one login signed in opens that login\'s message, and the tab names the login from then on', async () => {
    render(<ProEmailTabBody tabId="t1" data={tabData()} />);
    await waitFor(() => expect(screen.getByText('A note')).toBeTruthy());
    expect(clientA.getEmail).toHaveBeenCalledWith(ID, 'ee');
    await waitFor(() => expect(tabData().clientAccountId).toBe(a));
  });

  it('stays the first login\'s message when a second login signs in and becomes the active one', async () => {
    render(<ProEmailTabBody tabId="t1" data={tabData()} />);
    await waitFor(() => expect(screen.getByText('A note')).toBeTruthy());

    act(() => signInB(true));
    await settle();

    expect(clientB.getEmail).not.toHaveBeenCalled();
    expect(screen.queryByText('B payroll')).toBeNull();
    expect(screen.getByText('A note')).toBeTruthy();
  });

  it('with two logins signed in opens nothing through either, and says so', async () => {
    signInB(false);
    render(<ProEmailTabBody tabId="t1" data={tabData()} />);
    await settle();

    expect(screen.getByText('account_routing.tab_names_no_account')).toBeTruthy();
    expect(clientA.getEmail).not.toHaveBeenCalled();
    expect(clientB.getEmail).not.toHaveBeenCalled();
    expect(tabData().clientAccountId).toBeUndefined();
  });

  it('with two logins signed in still opens nothing when the other login becomes the active one', async () => {
    signInB(false);
    render(<ProEmailTabBody tabId="t1" data={tabData()} />);
    await settle();

    act(() => {
      useAccountStore.getState().setActiveAccount(b);
      useAuthStore.setState((state) => ({ activeAccountId: b, client: clientB as never, connectedAccountsRevision: (state.connectedAccountsRevision ?? 0) + 1 }) as never);
    });
    await settle();

    expect(screen.getByText('account_routing.tab_names_no_account')).toBeTruthy();
    expect(clientA.getEmail).not.toHaveBeenCalled();
    expect(clientB.getEmail).not.toHaveBeenCalled();
  });
});

describe('naming the login of a tab', () => {
  afterEach(() => useProTabStore.setState({ tabs: original.tabs }));

  it('fills in a message tab and a folder tab that name none, and leaves named ones alone', () => {
    const folder = (id: string, accountId: string | null): ProTab => ({
      id, kind: 'folder', labelKey: '', title: 'Inbox', closeable: true, paneId: 'main',
      folderData: { accountId, mailboxId: 'a', title: 'Inbox' },
    });
    const named = keptTab();
    named.id = 't2';
    named.emailData = { ...named.emailData!, clientAccountId: 'login-b' };
    useProTabStore.setState({ tabs: [keptTab(), named, folder('f1', null), folder('f2', 'login-b')] });

    const { nameTabLogin } = useProTabStore.getState();
    for (const id of ['t1', 't2', 'f1', 'f2', 'missing']) nameTabLogin(id, 'login-a');

    const tabs = useProTabStore.getState().tabs;
    expect(tabs.find((tab) => tab.id === 't1')?.emailData?.clientAccountId).toBe('login-a');
    expect(tabs.find((tab) => tab.id === 't2')?.emailData?.clientAccountId).toBe('login-b');
    expect(tabs.find((tab) => tab.id === 'f1')?.folderData?.accountId).toBe('login-a');
    expect(tabs.find((tab) => tab.id === 'f2')?.folderData?.accountId).toBe('login-b');
  });
});
