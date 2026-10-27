import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useEmailStore } from '../email-store';
import { useAuthStore } from '../auth-store';
import type { Email, Mailbox, ScheduledEmail } from '@/lib/jmap/types';
import type { IJMAPClient } from '@/lib/jmap/client-interface';

// The scheduled badge and its Send now / Reschedule / Cancel buttons belong
// to the message the submission sends, in its own login and account. Email
// ids repeat across accounts: live on 0.16 and 1.0, a fresh login's scheduled
// message and the second message of its group's Inbox are both `iaaaaac`.

function mailbox(id: string, role: string, accountId: string, shared = false): Mailbox {
  return {
    id: shared ? `${accountId}:${id}` : id, originalId: id, name: role, role, accountId, isShared: shared,
    sortOrder: 0, totalEmails: 0, unreadEmails: 0, totalThreads: 0, unreadThreads: 0, isSubscribed: true,
  } as Mailbox;
}

const scheduled = {
  id: 'iaaaaac', threadId: 'c', subject: 'A scheduled one', receivedAt: '2026-10-26T10:00:00Z',
  keywords: {}, mailboxIds: { e: true },
  scheduledSendAt: '2026-11-02T13:12:47Z', emailSubmissionId: 'b', scheduledIdentityId: 'c',
  scheduledUndoStatus: 'pending', scheduledAccountId: 'cf', isScheduled: true,
} as unknown as ScheduledEmail;

function row(overrides: Partial<Email> = {}): Email {
  return { id: 'iaaaaac', threadId: 'c', subject: 'GRP two', receivedAt: '2026-10-26T10:00:00Z', keywords: {}, mailboxIds: { 'ce:a': true }, ...overrides } as Email;
}

describe('scheduled badges in folder lists', () => {
  let client: IJMAPClient;

  beforeEach(() => {
    client = {
      getAccountId: () => 'cf',
      pruneEmailSubmissions: vi.fn().mockResolvedValue(undefined),
      getScheduledEmails: vi.fn().mockResolvedValue({ emails: [scheduled], hasMore: false, total: 1, totalByAccount: { cf: 1 }, nextPosition: 1 }),
    } as unknown as IJMAPClient;
    useAuthStore.setState({
      activeAccountId: 'login-a', client: client as never,
      getClientForAccount: (id: string) => (id === 'login-a' ? client : undefined) as never,
      getAllConnectedClients: () => new Map([['login-a', client]]) as never,
    } as never);
    useEmailStore.setState({
      isScheduledView: false, isUnifiedView: false, viewingAccountId: null,
      mailboxes: [mailbox('a', 'inbox', 'cf'), mailbox('e', 'sent', 'cf'), mailbox('a', 'inbox', 'ce', true)],
      accountMailboxes: {}, searchQuery: '', searchMailboxId: '',
      scheduledEmails: [], scheduledSubmissionByEmailId: new Map(), pendingUndoSend: null,
    } as never);
  });

  it("leaves a group message with the id of the own scheduled message alone", async () => {
    useEmailStore.setState({ selectedMailbox: 'ce:a', emails: [row()] } as never);
    await useEmailStore.getState().refreshScheduledMetadata(client);
    expect(useEmailStore.getState().emails[0].isScheduled).toBeFalsy();
    expect(useEmailStore.getState().emails[0].emailSubmissionId).toBeUndefined();
  });

  it('marks the scheduled message itself in the own Sent folder', async () => {
    useEmailStore.setState({ selectedMailbox: 'e', emails: [row({ subject: 'A scheduled one', mailboxIds: { e: true } })] } as never);
    await useEmailStore.getState().refreshScheduledMetadata(client);
    expect(useEmailStore.getState().emails[0]).toMatchObject({ isScheduled: true, emailSubmissionId: 'b', scheduledAccountId: 'cf' });
  });

  it('tells the rows of a list that mixes accounts apart by their stamps', async () => {
    useEmailStore.setState({
      isUnifiedView: true, selectedMailbox: '',
      emails: [
        row({ sourceClientAccountId: 'login-a', sourceAccountId: 'ce' }),
        row({ sourceClientAccountId: 'login-b', sourceAccountId: 'cf' }),
        row({ subject: 'A scheduled one', sourceClientAccountId: 'login-a', sourceAccountId: 'cf' }),
      ],
    } as never);
    await useEmailStore.getState().refreshScheduledMetadata(client);
    expect(useEmailStore.getState().emails.map(e => !!e.isScheduled)).toEqual([false, false, true]);
  });

  it('opens a group row of a list that mixes accounts without the badge', async () => {
    const groupRow = row({ sourceClientAccountId: 'login-a', sourceAccountId: 'ce' });
    (client as unknown as { getEmail: unknown }).getEmail = vi.fn().mockResolvedValue(row());
    useEmailStore.setState({ isUnifiedView: true, selectedMailbox: '', emails: [groupRow], selectedEmail: groupRow } as never);
    await useEmailStore.getState().refreshScheduledMetadata(client);
    const opened = await useEmailStore.getState().fetchEmailContent(client, 'iaaaaac');
    expect(opened?.isScheduled).toBeFalsy();
    expect(client.getEmail).toHaveBeenCalledWith('iaaaaac', 'ce');
  });
});
