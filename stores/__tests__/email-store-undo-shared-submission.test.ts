import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useEmailStore } from '../email-store';
import type { Mailbox, ScheduledEmail } from '@/lib/jmap/types';
import type { IJMAPClient } from '@/lib/jmap/client-interface';

// A message sent or scheduled from a group identity lives in the group's
// account. Undo and "Edit" restored it to Drafts, fetched and deleted it
// through the login's primary account, so they acted on whatever primary
// message had the same id - or on nothing, leaving the unsent mail in Sent.

function mailbox(id: string, role: string, overrides: Partial<Mailbox> = {}): Mailbox {
  return { id, name: id, role, isShared: false, ...overrides } as Mailbox;
}

const PRIMARY = 'acc-me';
const GROUP = 'acc-team';

function makeClient(): IJMAPClient {
  return {
    getAccountId: () => PRIMARY,
    cancelEmailSubmission: vi.fn().mockResolvedValue(undefined),
    restoreEmailToDraft: vi.fn().mockResolvedValue(undefined),
    getEmail: vi.fn().mockResolvedValue({ id: 'e1' }),
    deleteEmail: vi.fn().mockResolvedValue(undefined),
    getMailboxes: vi.fn(async (accountId?: string) =>
      accountId === GROUP
        ? [mailbox('team-drafts', 'drafts'), mailbox('team-sent', 'sent')]
        : [mailbox('my-drafts', 'drafts'), mailbox('my-sent', 'sent')]),
    getScheduledEmails: vi.fn().mockResolvedValue({ emails: [], hasMore: false, total: 0, totalByAccount: {}, nextPosition: 0 }),
  } as unknown as IJMAPClient;
}

describe('undo and edit of a group-identity submission', () => {
  beforeEach(() => {
    useEmailStore.setState({
      mailboxes: [mailbox('my-drafts', 'drafts'), mailbox('my-sent', 'sent')],
      scheduledEmails: [],
      pendingUndoSend: null,
    });
  });

  it('undo restores, and re-reads, the message in the group account', async () => {
    const client = makeClient();
    useEmailStore.setState({ refreshScheduledMetadata: vi.fn().mockResolvedValue(undefined) });

    await useEmailStore.getState().cancelUndoSend(client, {
      submissionId: 's1', emailId: 'e1', identityId: 'team-identity', submissionAccountId: GROUP,
    } as never);

    expect(client.cancelEmailSubmission).toHaveBeenCalledWith('s1', GROUP);
    expect(client.restoreEmailToDraft).toHaveBeenCalledWith('e1', 'team-drafts', 'team-sent', GROUP);
    expect(client.getEmail).toHaveBeenCalledWith('e1', GROUP);
  });

  it('edit of a scheduled message restores it in the group account', async () => {
    const client = makeClient();
    useEmailStore.setState({ fetchScheduledEmails: vi.fn().mockResolvedValue(undefined) });

    await useEmailStore.getState().cancelScheduledEmailForEdit(client, {
      id: 'e1', emailSubmissionId: 's1', scheduledAccountId: GROUP,
    } as ScheduledEmail);

    expect(client.restoreEmailToDraft).toHaveBeenCalledWith('e1', 'team-drafts', 'team-sent', GROUP);
    expect(client.getEmail).toHaveBeenCalledWith('e1', GROUP);
  });

  it('cancelling a scheduled message deletes it in the group account', async () => {
    const client = makeClient();
    useEmailStore.setState({
      fetchScheduledEmails: vi.fn().mockResolvedValue(undefined),
      scheduledEmails: [{ id: 'e1', emailSubmissionId: 's1', scheduledAccountId: GROUP } as ScheduledEmail],
    });

    await useEmailStore.getState().cancelScheduledEmail(client, 's1', 'e1');

    expect(client.deleteEmail).toHaveBeenCalledWith('e1', GROUP);
  });

  it("keeps using the store's own Drafts for the login account", async () => {
    const client = makeClient();
    useEmailStore.setState({ refreshScheduledMetadata: vi.fn().mockResolvedValue(undefined) });

    await useEmailStore.getState().cancelUndoSend(client, {
      submissionId: 's1', emailId: 'e1', identityId: 'me', submissionAccountId: PRIMARY,
    } as never);

    expect(client.restoreEmailToDraft).toHaveBeenCalledWith('e1', 'my-drafts', 'my-sent', PRIMARY);
    expect(client.getMailboxes).not.toHaveBeenCalled();
  });
});

// Submission and email ids repeat across accounts: live, the member's own
// scheduled mail and the group's were both submission "f" of "maaaaad".
describe('scheduled mail of two accounts with the same ids', () => {
  // Collected before any test replaces them in the store.
  const { refreshScheduledMetadata, fetchScheduledEmails } = useEmailStore.getState();
  const own = { id: 'maaaaad', subject: 'own', emailSubmissionId: 'f', scheduledAccountId: PRIMARY, scheduledSendAt: '2099-01-01T10:00:00Z', scheduledUndoStatus: 'pending' } as ScheduledEmail;
  const team = { ...own, subject: 'team', scheduledAccountId: GROUP, scheduledSendAt: '2099-01-01T11:00:00Z' } as ScheduledEmail;

  beforeEach(() => {
    useEmailStore.setState({ refreshScheduledMetadata, fetchScheduledEmails, scheduledEmails: [own, team], pendingUndoSend: null, isScheduledView: true });
  });

  it('reschedules the row it was asked for, in its account', async () => {
    const client = makeClient();
    (client as unknown as { rescheduleEmailSubmission: unknown }).rescheduleEmailSubmission = vi.fn().mockResolvedValue({ scheduled: true, emailSubmissionId: 'g' });
    (client.getScheduledEmails as ReturnType<typeof vi.fn>).mockResolvedValue({ emails: [own, team], hasMore: false, total: 2, nextPosition: 2 });

    await useEmailStore.getState().rescheduleScheduledEmail(client, 'f', 'maaaaad', 'b', '2099-01-02T10:00:00Z', GROUP);

    expect(client.rescheduleEmailSubmission).toHaveBeenCalledWith('f', 'maaaaad', 'b', '2099-01-02T10:00:00Z', GROUP);
  });

  it('lists both when they come on different pages', async () => {
    const client = makeClient();
    (client as unknown as { pruneEmailSubmissions: unknown }).pruneEmailSubmissions = vi.fn().mockResolvedValue(undefined);
    (client.getScheduledEmails as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce({ emails: [own], hasMore: true, total: 2, nextPosition: 1 })
      .mockResolvedValueOnce({ emails: [team], hasMore: false, total: 2, nextPosition: 2 });

    await useEmailStore.getState().refreshScheduledMetadata(client);

    expect(useEmailStore.getState().scheduledEmails.map((email) => email.subject)).toEqual(['own', 'team']);
  });

  it('loads the next page of the other account', async () => {
    const client = makeClient();
    useEmailStore.setState({ scheduledEmails: [own], scheduledHasMore: true, scheduledNextPosition: 1, isLoadingScheduled: false });
    (client.getScheduledEmails as ReturnType<typeof vi.fn>).mockResolvedValueOnce({ emails: [team], hasMore: false, total: 2, nextPosition: 2 });

    await useEmailStore.getState().loadMoreScheduledEmails(client);

    expect(useEmailStore.getState().scheduledEmails.map((email) => email.subject)).toEqual(['own', 'team']);
  });
});
