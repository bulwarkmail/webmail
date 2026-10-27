import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useEmailStore } from '../email-store';
import { useAuthStore } from '../auth-store';
import type { Email, ScheduledEmail } from '@/lib/jmap/types';
import type { IJMAPClient } from '@/lib/jmap/client-interface';

const scheduled = {
  id: 'email-1', threadId: 'thread-1', subject: 'Scheduled', receivedAt: '2026-10-26T10:00:00Z',
  keywords: {}, mailboxIds: { sent: true }, sourceClientAccountId: 'login-a', sourceAccountId: 'account-1',
  scheduledSendAt: '2099-01-01T10:00:00Z', emailSubmissionId: 'sub-old', scheduledIdentityId: 'identity-1',
  scheduledUndoStatus: 'pending', scheduledAccountId: 'account-1', isScheduled: true,
} as unknown as ScheduledEmail;

function makeClient(): IJMAPClient {
  return {
    getAccountId: () => 'account-1',
    pruneEmailSubmissions: vi.fn().mockResolvedValue(undefined),
    getScheduledEmails: vi.fn().mockResolvedValue({ emails: [], hasMore: false, total: 0, nextPosition: 0 }),
    rescheduleEmailSubmission: vi.fn().mockResolvedValue({ emailId: 'email-1', scheduled: true, emailSubmissionId: 'sub-new' }),
  } as unknown as IJMAPClient;
}

describe('authoritative scheduled metadata refresh', () => {
  let client: IJMAPClient;
  beforeEach(() => {
    client = makeClient();
    useAuthStore.setState({
      activeAccountId: 'login-a', client: client as never,
      getClientForAccount: (id: string) => id === 'login-a' ? client as never : undefined,
      getAllConnectedClients: () => new Map([['login-a', client]]) as never,
    } as never);
    useEmailStore.setState({
      selectedMailbox: 'sent', isScheduledView: false, isUnifiedView: false, viewingAccountId: null,
      mailboxes: [{ id: 'sent', role: 'sent', accountId: 'account-1' }], accountMailboxes: {},
      emails: [{ ...scheduled }], selectedEmail: { ...scheduled }, scheduledEmails: [scheduled],
      scheduledSubmissionByEmailId: new Map(), pendingUndoSend: null,
      threadEmailsCache: new Map([['thread-1', [{ ...scheduled }]]]),
    } as never);
  });

  it('removes completed scheduling controls from the viewer, list and cached thread', async () => {
    await useEmailStore.getState().refreshScheduledMetadata(client);
    const state = useEmailStore.getState();
    const rows = [state.selectedEmail, state.emails[0], state.threadEmailsCache.get('thread-1')![0]];
    for (const row of rows) {
      expect(row?.isScheduled).toBeFalsy();
      expect(row?.emailSubmissionId).toBeUndefined();
    }
  });

  it('keeps a different login with colliding ids unchanged', async () => {
    const otherClient = makeClient();
    const other = { ...scheduled, sourceClientAccountId: 'login-b' } as Email;
    useAuthStore.setState({ getClientForAccount: (id: string) => (id === 'login-b' ? otherClient : client) as never } as never);
    useEmailStore.setState({ emails: [other], selectedEmail: other });
    await useEmailStore.getState().refreshScheduledMetadata(client);
    expect(useEmailStore.getState().selectedEmail).toMatchObject({ emailSubmissionId: 'sub-old', isScheduled: true });
  });

  it('does not restore stale pending flags after a replacement has already left the queue', async () => {
    await useEmailStore.getState().rescheduleScheduledEmail(client, 'sub-old', 'email-1', 'identity-1', '2099-01-01T11:00:00Z', 'account-1');
    expect(useEmailStore.getState().selectedEmail?.isScheduled).toBeFalsy();
    expect(useEmailStore.getState().selectedEmail?.emailSubmissionId).toBeUndefined();
  });
});
