import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useEmailStore } from '../email-store';
import { useAuthStore } from '../auth-store';
import type { IJMAPClient } from '@/lib/jmap/client-interface';
import type { Mailbox } from '@/lib/jmap/types';

// mail-p2-8: a send in its Undo window keeps what Sent and Scheduled counted
// before it, so the sidebar can show those counts until the message goes.

function mailbox(id: string, role: string, totalEmails: number): Mailbox {
  return { id, name: role, role, sortOrder: 0, totalEmails, unreadEmails: 0, totalThreads: totalEmails, unreadThreads: 0, isSubscribed: true } as Mailbox;
}

describe('the counts before a held send', () => {
  let client: IJMAPClient;

  beforeEach(() => {
    vi.restoreAllMocks();
    client = {
      getAccountId: () => 'acc-1',
      pruneEmailSubmissions: vi.fn().mockResolvedValue(0),
      sendEmail: vi.fn().mockResolvedValue({ scheduled: true, emailId: 'sent-1', emailSubmissionId: 'sub-1', sendAt: new Date(Date.now() + 5000).toISOString() }),
      getAllMailboxesWithState: vi.fn().mockResolvedValue({ mailboxes: [mailbox('mb-sent', 'sent', 52)], states: { 'acc-1': 'm2' } }),
    } as unknown as IJMAPClient;
    useAuthStore.setState({ client });
    useEmailStore.setState({
      emails: [], mailboxes: [mailbox('mb-sent', 'sent', 51)], mailboxSyncStates: { 'acc-1': 'm1' },
      selectedMailbox: 'mb-sent', pendingUndoSend: null, scheduledTotal: 2,
    });
  });

  it('records Sent and Scheduled as they were', async () => {
    await useEmailStore.getState().sendEmail(client, ['bob@example.net'], 'Subject', 'body');
    expect(useEmailStore.getState().pendingUndoSend?.countsBefore).toEqual({ sent: 51, scheduled: 2 });
  });

  it("records no Sent count for another login's send", async () => {
    const otherLogin = { ...client } as unknown as IJMAPClient;
    await useEmailStore.getState().sendEmail(otherLogin, ['bob@example.net'], 'Subject', 'body');
    expect(useEmailStore.getState().pendingUndoSend?.countsBefore).toEqual({ sent: undefined, scheduled: 2 });
  });
});
