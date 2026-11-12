import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { setClientForTests, useAuthStore } from '../auth-store';
import { useAccountStore } from '../account-store';
import { useEmailStore } from '../email-store';
import type { Email, Mailbox } from '@/lib/jmap/types';
import type { JMAPClient } from '@/lib/jmap/client';

// After a start without the server, login B runs on a device-only client and
// its folder is open in the Pro sidebar. Back online, the device-only clients
// are swapped for real ones, and B's does not come back. B's folder and rows
// leave the list: A's Inbox has the same folder and message ids.
const entry = (username: string, isDefault: boolean) => ({
  label: username, serverUrl: 'https://mail.example.org', username, authMode: 'basic' as const,
  rememberMe: false, displayName: username, email: username, lastLoginAt: 0,
  isConnected: true, hasError: false, isDefault,
});
const inbox = (accountId: string) => ({
  id: 'a', name: 'Inbox', role: 'inbox', accountId, sortOrder: 0, totalEmails: 1, unreadEmails: 0,
  totalThreads: 1, unreadThreads: 0, isSubscribed: true, isShared: false,
}) as Mailbox;
const message = (stamps: Partial<Email> = {}) => ({
  id: 'eaaaaab', threadId: 't', receivedAt: '2026-11-11T10:00:00Z', keywords: {}, mailboxIds: { a: true }, ...stamps,
}) as Email;

const initial = { auth: useAuthStore.getState(), email: useEmailStore.getState(), accounts: useAccountStore.getState() };

describe('a login whose client does not come back after a start without the server', () => {
  let a: string;
  let b: string;
  let active: { getAccountId: () => string; isOfflineOnly: () => boolean };
  let fetchEmails: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    useAccountStore.setState({ accounts: [], activeAccountId: null, defaultAccountId: null });
    a = useAccountStore.getState().addAccount(entry('a@example.org', true));
    b = useAccountStore.getState().addAccount(entry('b@example.org', false));
    useAccountStore.getState().setActiveAccount(a);
    active = { getAccountId: () => 'ee', isOfflineOnly: () => false };
    setClientForTests(b, { getAccountId: () => 'ef', isOfflineOnly: () => true } as unknown as JMAPClient);
    // The real connect finds nothing for B.
    useAuthStore.setState({ isAuthenticated: true, activeAccountId: a, client: active as never, checkAuth: vi.fn(async () => {}) } as never);
    fetchEmails = vi.fn().mockResolvedValue(undefined);
    const row = message();
    useEmailStore.setState({
      viewingAccountId: b, selectedMailbox: 'a', isUnifiedView: false, mailboxes: [inbox('ee')], accountMailboxes: { [b]: [inbox('ef')] },
      emails: [row], selectedEmail: row, fetchEmails,
    } as never);
  });

  afterEach(() => {
    useAuthStore.setState(initial.auth);
    useEmailStore.setState(initial.email);
    useAccountStore.setState(initial.accounts);
  });

  it('closes its folder and message, for the active login\'s Inbox', async () => {
    const swapped = await useAuthStore.getState().reconnectOfflineClients();

    expect(swapped).toBe(false);
    const state = useEmailStore.getState();
    expect(state.viewingAccountId).toBeNull();
    expect(state.emails).toEqual([]);
    expect(state.selectedEmail).toBeNull();
    expect(fetchEmails).toHaveBeenCalledWith(active, 'a');
  });

  it('drops its rows from a list that mixes accounts', async () => {
    const own = message({ sourceClientAccountId: a, sourceAccountId: 'ee' });
    const gone = message({ sourceClientAccountId: b, sourceAccountId: 'ef' });
    useEmailStore.setState({ viewingAccountId: null, isUnifiedView: true, selectedMailbox: '__unified_inbox__', emails: [own, gone], selectedEmail: gone } as never);

    await useAuthStore.getState().reconnectOfflineClients();

    expect(useEmailStore.getState().emails).toEqual([own]);
    expect(useEmailStore.getState().selectedEmail).toBeNull();
  });
});
