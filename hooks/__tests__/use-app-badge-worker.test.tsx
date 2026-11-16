import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import { useAppBadgeWorkerState } from '../use-app-badge-worker';
import { useAuthStore } from '@/stores/auth-store';
import { useAccountStore } from '@/stores/account-store';
import { useEmailStore } from '@/stores/email-store';
import { useSettingsStore } from '@/stores/settings-store';
import type { Mailbox } from '@/lib/jmap/types';

// #1516: the page leaves the badge's number, and each login's share in it,
// where the service worker reads it on push (public/sw.js appBadgeFromPush).

const inbox = (unread: number) => [{ id: 'inbox', role: 'inbox', isShared: false, unreadEmails: unread } as Mailbox];
const client = (accountId: string) => ({ getAccountId: () => accountId });

let written: unknown[] = [];
const initialAuth = useAuthStore.getState();
const initialAccounts = useAccountStore.getState();
const initialEmail = useEmailStore.getState();

beforeEach(() => {
  written = [];
  vi.stubGlobal('caches', {
    open: async () => ({ put: async (_key: string, res: Response) => { written.push(JSON.parse(await res.text())); } }),
  });
  const others: Record<string, unknown> = { 'login-b': client('B'), 'login-c': client('C') };
  useAuthStore.setState({
    username: 'me@example.org', activeAccountId: 'login-a', client: client('A'),
    getClientForAccount: ((id: string) => others[id]) as never,
  } as never);
  useAccountStore.setState({
    accounts: [
      { id: 'login-a', username: 'me@example.org', isConnected: true },
      { id: 'login-b', username: 'other@example.net', isConnected: true },
    ] as never,
  });
  useEmailStore.setState({ mailboxes: inbox(2), accountMailboxes: { 'login-b': inbox(3) } });
  useSettingsStore.setState({ unreadBadgeAllAccounts: true });
});
afterEach(() => {
  vi.unstubAllGlobals();
  useAuthStore.setState(initialAuth, true);
  useAccountStore.setState(initialAccounts, true);
  useEmailStore.setState(initialEmail, true);
});

describe('useAppBadgeWorkerState', () => {
  it('leaves the total with every counted login\'s own account and share', async () => {
    renderHook(() => useAppBadgeWorkerState(5, true));
    await waitFor(() => expect(written).toHaveLength(1));
    expect(written[0]).toEqual({
      enabled: true,
      total: 5,
      logins: { 'me@example.org': { accountId: 'A', unread: 2 }, 'other@example.net': { accountId: 'B', unread: 3 } },
    });
  });

  it('leaves out the other logins while only the open one is counted', async () => {
    useSettingsStore.setState({ unreadBadgeAllAccounts: false });
    renderHook(() => useAppBadgeWorkerState(2, true));
    await waitFor(() => expect(written).toHaveLength(1));
    expect(written[0]).toEqual({ enabled: true, total: 2, logins: { 'me@example.org': { accountId: 'A', unread: 2 } } });
  });

  it('leaves out a user name two logins share, since a push names its login by it', async () => {
    useAccountStore.setState({
      accounts: [
        { id: 'login-a', username: 'me@example.org', isConnected: true },
        { id: 'login-b', username: 'other@example.net', isConnected: true },
        { id: 'login-c', username: 'other@example.net', isConnected: true },
      ] as never,
    });
    renderHook(() => useAppBadgeWorkerState(5, true));
    await waitFor(() => expect(written).toHaveLength(1));
    expect((written[0] as { logins: Record<string, unknown> }).logins).toEqual({ 'me@example.org': { accountId: 'A', unread: 2 } });
  });

  it('says so when the badge setting is off', async () => {
    renderHook(() => useAppBadgeWorkerState(5, false));
    await waitFor(() => expect(written).toHaveLength(1));
    expect(written[0]).toMatchObject({ enabled: false });
  });
});
