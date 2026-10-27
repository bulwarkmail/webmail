import { beforeEach, describe, expect, it, vi } from 'vitest';
import { emailLinkSource, useEmailStore } from '../email-store';
import { useAuthStore } from '../auth-store';
import type { Email, Mailbox } from '@/lib/jmap/types';
import type { IJMAPClient } from '@/lib/jmap/client-interface';

// Email ids repeat across accounts (Stalwart numbers each account's mail the
// same way). A message link only named the id, so a link to a shared or group
// account's message opened the own message with that id (#1351).

const row = (id: string, mailboxId: string): Email => ({
  id, threadId: `t-${id}`, mailboxIds: { [mailboxId]: true }, keywords: {}, subject: `Subject ${id}`,
  receivedAt: '2026-10-01T00:00:00Z', from: [], to: [], preview: '', size: 1, hasAttachment: false,
} as Email);

const mailbox = (id: string, extra: Partial<Mailbox> = {}): Mailbox => ({
  id, originalId: id, name: id, role: null, accountId: 'own', totalEmails: 1, unreadEmails: 0,
  totalThreads: 1, unreadThreads: 0, sortOrder: 0, isSubscribed: true, myRights: {}, ...extra,
} as unknown as Mailbox);

const OWN_INBOX = mailbox('inbox', { role: 'inbox' });
const GROUP_INBOX = mailbox('grp:inbox', { originalId: 'inbox', role: 'inbox', accountId: 'grp', isShared: true });

function client() {
  return {
    getAccountId: () => 'own',
    getEmail: vi.fn(async (id: string, accountId?: string) => row(id, accountId ? `${accountId}:inbox` : 'inbox')),
  } as unknown as IJMAPClient & { getEmail: ReturnType<typeof vi.fn> };
}

describe('message links and the account that owns the message', () => {
  let c: ReturnType<typeof client>;
  beforeEach(() => {
    c = client();
    useAuthStore.setState({ client: c, activeAccountId: 'alice@example.org' } as never);
    useEmailStore.setState({
      mailboxes: [OWN_INBOX, GROUP_INBOX],
      accountMailboxes: {},
      viewingAccountId: null,
      selectedMailbox: 'inbox',
      selectedEmail: null,
      emails: [row('e1', 'inbox')],
      searchQuery: '',
    });
  });

  it('fetches a linked message from the account the link names, not the own row with its id', async () => {
    const email = await useEmailStore.getState().fetchEmailContent(c, 'e1', 'grp');
    expect(c.getEmail).toHaveBeenCalledWith('e1', 'grp');
    expect(email?.mailboxIds).toEqual({ 'grp:inbox': true });
  });

  it('fetches from the listed row\'s account without an owner', async () => {
    await useEmailStore.getState().fetchEmailContent(c, 'e1');
    expect(c.getEmail).toHaveBeenCalledWith('e1', undefined);
  });

  it('names the owner of a row in a shared folder, and none for the own one', () => {
    expect(emailLinkSource(row('e1', 'inbox'))).toEqual({ ownerAccountId: null, loginId: null });
    useEmailStore.setState({ selectedMailbox: 'grp:inbox' });
    expect(emailLinkSource(row('e1', 'grp:inbox'))).toEqual({ ownerAccountId: 'grp', loginId: null });
  });

  it('names the account and login a stamped row of a merged view comes from', () => {
    const fromBob = { ...row('e1', 'inbox'), sourceClientAccountId: 'bob@example.org', sourceAccountId: 'b1' };
    const bobClient = { getAccountId: () => 'b1' };
    useAuthStore.setState({ getClientForAccount: (id: string) => (id === 'bob@example.org' ? bobClient : null) } as never);
    expect(emailLinkSource(fromBob)).toEqual({ ownerAccountId: null, loginId: 'bob@example.org' });
    expect(emailLinkSource({ ...fromBob, sourceAccountId: 'b-grp' })).toEqual({ ownerAccountId: 'b-grp', loginId: 'bob@example.org' });
  });
});
