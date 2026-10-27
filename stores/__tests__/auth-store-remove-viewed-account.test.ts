import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useAuthStore } from '../auth-store';
import { useAccountStore } from '../account-store';
import { useEmailStore } from '../email-store';
import { useSettingsStore } from '../settings-store';
import { emailKeyFor } from '@/lib/thread-utils';
import type { Email, Mailbox } from '@/lib/jmap/types';
import type { IJMAPClient } from '@/lib/jmap/client-interface';

// Two logins on servers that number folders and messages alike: the Inbox is
// `a` and the Deleted Items `b` in both, and both hold a message `eaaaaab`.
const entry = (username: string, isDefault: boolean) => ({
  label: username, serverUrl: 'https://mail.example.org', username, authMode: 'basic' as const,
  rememberMe: false, displayName: username, email: username, lastLoginAt: 0,
  isConnected: true, hasError: false, isDefault,
});
const folders = (accountId: string): Mailbox[] => [
  { id: 'a', name: 'Inbox', role: 'inbox', accountId },
  { id: 'b', name: 'Deleted Items', role: 'trash', accountId },
].map((m) => ({
  ...m, sortOrder: 0, totalEmails: 1, unreadEmails: 0, totalThreads: 1, unreadThreads: 0,
  myRights: { mayReadItems: true, mayAddItems: true, mayRemoveItems: true }, isSubscribed: true, isShared: false,
}) as Mailbox);
const message = (stamps: Partial<Email> = {}) => ({
  id: 'eaaaaab', threadId: 't', receivedAt: '2026-10-26T10:00:00Z', keywords: {}, mailboxIds: { a: true }, ...stamps,
}) as Email;

const initialEmail = useEmailStore.getState();

describe('removing a login that is not the active one', () => {
  let active: IJMAPClient;
  let a: string;
  let b: string;
  let fetchEmails: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status: 200 })));
    active = {
      batchMoveEmails: vi.fn().mockResolvedValue(undefined),
      batchDeleteEmails: vi.fn().mockResolvedValue(undefined),
      getAccountId: () => 'br',
    } as unknown as IJMAPClient;
    useAccountStore.setState({ accounts: [], activeAccountId: null, defaultAccountId: null });
    a = useAccountStore.getState().addAccount(entry('a@example.org', true));
    b = useAccountStore.getState().addAccount(entry('b@example.org', false));
    useAccountStore.getState().setActiveAccount(a);
    // b's client is gone once it is removed.
    useAuthStore.setState({
      isAuthenticated: true, activeAccountId: a, client: active,
      getClientForAccount: (id: string) => (id === a ? active : undefined),
    } as never);
    useSettingsStore.setState({ deleteAction: 'trash' } as never);
    fetchEmails = vi.fn().mockResolvedValue(undefined);
    useEmailStore.setState({ fetchEmails } as never);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    useEmailStore.setState(initialEmail);
  });

  it('leaves its folder open in the Pro sidebar, so deleting the rows shown deletes nothing in the active login', async () => {
    const row = message();
    useEmailStore.setState({
      viewingAccountId: b, selectedMailbox: 'a', isUnifiedView: false, selectedKeyword: null, searchQuery: '',
      mailboxes: folders('br'), accountMailboxes: { [b]: folders('bs') },
      emails: [row], selectedEmail: row, selectedEmailKeys: new Set([emailKeyFor(row)]),
    });

    useAuthStore.getState().removeAccount(b);
    await useEmailStore.getState().batchDelete(active);
    await useEmailStore.getState().batchDelete(active, true);

    expect(active.batchMoveEmails).not.toHaveBeenCalled();
    expect(active.batchDeleteEmails).not.toHaveBeenCalled();
    const state = useEmailStore.getState();
    expect(state.viewingAccountId).toBeNull();
    expect(state.emails).toEqual([]);
    expect(state.selectedEmail).toBeNull();
    expect(fetchEmails).toHaveBeenCalledWith(active, 'a');
  });

  it('drops its rows from a list that mixes accounts, keeping the active login\'s namesake', () => {
    const own = message({ sourceClientAccountId: a, sourceAccountId: 'br' });
    const gone = message({ sourceClientAccountId: b, sourceAccountId: 'bs' });
    useEmailStore.setState({
      viewingAccountId: null, isUnifiedView: true, selectedMailbox: '__unified_inbox__',
      emails: [own, gone], selectedEmail: gone, selectedEmailKeys: new Set([emailKeyFor(own), emailKeyFor(gone)]),
    });

    useAuthStore.getState().removeAccount(b);

    const state = useEmailStore.getState();
    expect(state.emails).toEqual([own]);
    expect(state.selectedEmail).toBeNull();
    expect([...state.selectedEmailKeys]).toEqual([emailKeyFor(own)]);
    expect(fetchEmails).not.toHaveBeenCalled();
  });
});
