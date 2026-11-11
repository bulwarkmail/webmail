import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import React from 'react';

/**
 * A Pro folder tab of login B while login A is active. Login B is signed
 * out: the tab shows nothing of B's folder any more, and does not list A's
 * folder with the same id in its place.
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

const entry = (username: string, isDefault: boolean) => ({
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

describe('a Pro folder tab of a login that is signed out', () => {
  let b: string;
  let active: ReturnType<typeof client>;
  let connected: Map<string, ReturnType<typeof client>>;

  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status: 200 })));
    useAccountStore.setState({ accounts: [], activeAccountId: null, defaultAccountId: null });
    const a = useAccountStore.getState().addAccount(entry('a@example.org', true));
    b = useAccountStore.getState().addAccount(entry('b@example.org', false));
    useAccountStore.getState().setActiveAccount(a);
    active = client('ee', 'A private note');
    connected = new Map([[a, active], [b, client('ef', 'B payroll')]]);
    // One lookup for the whole test, as the store's own: only the table behind it changes.
    const lookup = (id: string) => connected.get(id) as never;
    useAuthStore.setState({ isAuthenticated: true, activeAccountId: a, client: active as never, getClientForAccount: lookup } as never);
    useEmailStore.setState({ mailboxes: [inbox('ee')], accountMailboxes: { [b]: [inbox('ef')] } } as never);
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    useAuthStore.setState(original.auth);
    useEmailStore.setState(original.email);
    useAccountStore.setState(original.accounts);
  });

  it('shows nothing of its folder once the login is gone', async () => {
    render(<ProFolderTabBody tabId="tab-1" data={{ accountId: b, mailboxId: 'a', title: 'Inbox' }} />);
    await waitFor(() => expect(screen.getByText('B payroll')).toBeTruthy());

    act(() => {
      connected.delete(b);
      useAuthStore.getState().removeAccount(b);
    });

    expect(screen.queryByText('B payroll')).toBeNull();
    expect(screen.getByText('not_connected')).toBeTruthy();
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 30)); });
    expect(active.getEmails).not.toHaveBeenCalled();
    expect(screen.queryByText('A private note')).toBeNull();
  });
});
