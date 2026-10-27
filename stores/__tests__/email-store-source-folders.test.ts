import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useEmailStore, resolveEmailActionContext } from '../email-store';
import { useAuthStore } from '../auth-store';
import { useSettingsStore } from '../settings-store';
import type { Email, Mailbox } from '@/lib/jmap/types';
import type { IJMAPClient } from '@/lib/jmap/client-interface';

// A single-message action on a stamped row takes role folders (Trash, Junk,
// Inbox) from that row's login and account. The list cached under the bare
// account id holds whichever login's list was fetched last, and another
// server numbers its accounts the same way: its "cf" is another account,
// whose Deleted Items has another id.

function mailbox(id: string, role: string | undefined, accountId: string, extra: Partial<Mailbox> = {}): Mailbox {
  return { id, originalId: id, name: id, role, accountId, isShared: false, sortOrder: 0, totalEmails: 1, unreadEmails: 0, totalThreads: 1, unreadThreads: 0, isSubscribed: true, ...extra } as Mailbox;
}

function makeClient(accountId: string) {
  return {
    getAccountId: () => accountId,
    moveToTrash: vi.fn().mockResolvedValue(undefined),
    markAsSpam: vi.fn().mockResolvedValue(undefined),
  } as unknown as IJMAPClient;
}

// Login B's message in its own account "cf", listed in a tag view of login A.
const row = {
  id: 'eaaaaab', threadId: 't', subject: 'B', receivedAt: '2026-10-26T10:00:00Z',
  keywords: { $seen: true }, mailboxIds: { a: true },
  sourceClientAccountId: 'login-b', sourceAccountId: 'cf',
} as unknown as Email;

describe('role folders of a stamped row', () => {
  let a: IJMAPClient;
  let b: IJMAPClient;

  beforeEach(() => {
    a = makeClient('cf');
    b = makeClient('cf');
    useAuthStore.setState({
      activeAccountId: 'login-a', client: a as never,
      getClientForAccount: (id: string) => (id === 'login-a' ? a : id === 'login-b' ? b : undefined) as never,
    } as never);
    useSettingsStore.setState({ deleteAction: 'trash', permanentlyDeleteJunk: false } as never);
    useEmailStore.setState({
      isUnifiedView: false, viewingAccountId: null, selectedMailbox: 'tag-red',
      mailboxes: [mailbox('a', 'inbox', 'cf'), mailbox('x9', 'trash', 'cf')],
      accountMailboxes: {
        // Login B's folders, as the sidebar loaded them.
        'login-b': [mailbox('a', 'inbox', 'cf'), mailbox('b', 'trash', 'cf'), mailbox('c', 'junk', 'cf')],
        // Under the bare id: another login's "cf", fetched last.
        cf: [mailbox('a', 'inbox', 'cf'), mailbox('x9', 'trash', 'cf'), mailbox('x8', 'junk', 'cf')],
      },
      emails: [row], selectedEmail: null, selectedEmailKeys: new Set(),
      threadEmailsCache: new Map(), expandedThreadIds: new Set(),
    } as never);
  });

  it('come from its own login, not from the list cached under the bare account id', () => {
    expect(resolveEmailActionContext(row, a).mailboxes.map(m => m.id)).toEqual(['a', 'b', 'c']);
  });

  it('come from the list cached for its login and account when there is one', () => {
    useEmailStore.setState(s => ({ accountMailboxes: { ...s.accountMailboxes, 'login-b|cf': [mailbox('b', 'trash', 'cf')] } }));
    expect(resolveEmailActionContext(row, a).mailboxes.map(m => m.id)).toEqual(['b']);
  });

  it('delete moves it to its own Deleted Items', async () => {
    await useEmailStore.getState().deleteEmail(a, 'eaaaaab', false, 'login-b/cf:eaaaaab');
    expect(b.moveToTrash).toHaveBeenCalledWith('eaaaaab', 'b', 'cf', false);
    expect(a.moveToTrash).not.toHaveBeenCalled();
  });
});
