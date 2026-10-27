import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useEmailStore } from '../email-store';
import { useAuthStore } from '../auth-store';
import { useSettingsStore } from '@/stores/settings-store';
import { emailKeyFor } from '@/lib/thread-utils';
import type { Email, Mailbox } from '@/lib/jmap/types';
import type { IJMAPClient } from '@/lib/jmap/client-interface';

// Batch spam / not-spam must route each message through its own account, like
// the single-message actions. The batch used the active client and the
// selected folder's account for everything: in a unified "All Junk" view other
// accounts' messages went to the wrong inbox, and with no folder selected
// (tag/unified views) mark-as-spam returned early while the caller showed a
// success toast.

function makeMailbox(overrides: Partial<Mailbox> = {}): Mailbox {
  return {
    id: 'inbox',
    name: 'Inbox',
    sortOrder: 0,
    totalEmails: 0,
    unreadEmails: 0,
    totalThreads: 0,
    unreadThreads: 0,
    myRights: {
      mayReadItems: true,
      mayAddItems: true,
      mayRemoveItems: true,
      maySetSeen: true,
      maySetKeywords: true,
      mayCreateChild: true,
      mayRename: true,
      mayDelete: true,
      maySubmit: true,
    },
    isSubscribed: true,
    isShared: false,
    ...overrides,
  };
}

function makeEmail(overrides: Partial<Email> = {}): Email {
  return {
    id: 'email-1',
    threadId: 'thread-1',
    subject: 'Hi',
    receivedAt: new Date().toISOString(),
    keywords: { $seen: true },
    mailboxIds: {},
    ...overrides,
  } as Email;
}

function makeClient() {
  return {
    markAsSpam: vi.fn().mockResolvedValue(undefined),
    undoSpam: vi.fn().mockResolvedValue(undefined),
  } as unknown as IJMAPClient;
}

describe('batch spam actions route per account', () => {
  let clientA: IJMAPClient;
  let clientB: IJMAPClient;

  const emailA = makeEmail({ id: 'same-id', sourceClientAccountId: 'account-a', sourceAccountId: 'account-a', mailboxIds: { 'a-junk': true } });
  const emailB = makeEmail({ id: 'same-id', sourceClientAccountId: 'account-b', sourceAccountId: 'account-b', mailboxIds: { 'b-junk': true }, keywords: {} });
  const emailB2 = makeEmail({ id: 'b-2', sourceClientAccountId: 'account-b', sourceAccountId: 'account-b', mailboxIds: { 'b-junk': true } });

  beforeEach(() => {
    clientA = makeClient();
    clientB = makeClient();
    useAuthStore.setState({
      activeAccountId: 'account-a',
      getClientForAccount: (id: string) =>
        (id === 'account-a' ? clientA : id === 'account-b' ? clientB : undefined) as never,
    } as never);
    useSettingsStore.setState({ deleteAction: 'trash' } as never);

    const aMailboxes = [
      makeMailbox({ id: 'a-inbox', role: 'inbox', accountId: 'account-a' }),
      makeMailbox({ id: 'a-junk', name: 'Junk', role: 'junk', totalEmails: 1, accountId: 'account-a' }),
    ];
    useEmailStore.setState({
      isUnifiedView: true,
      unifiedRole: 'junk',
      viewingAccountId: null,
      selectedMailbox: '',
      selectedKeyword: null,
      mailboxes: aMailboxes,
      accountMailboxes: {
        'account-a': aMailboxes,
        'account-b': [
          makeMailbox({ id: 'b-inbox', role: 'inbox', accountId: 'account-b' }),
          makeMailbox({ id: 'b-junk', name: 'Junk', role: 'junk', totalEmails: 2, unreadEmails: 1, accountId: 'account-b' }),
        ],
      },
      emails: [emailA, emailB, emailB2],
      threadEmailsCache: new Map(),
      selectedEmail: null,
      selectedEmailKeys: new Set([emailKeyFor(emailA), emailKeyFor(emailB)]),
      spamUndoCache: new Map(),
    } as never);
  });

  it('sends not-spam for each message to its own account and inbox', async () => {
    await useEmailStore.getState().batchUndoSpam(clientA, ['same-id']);

    expect(clientA.undoSpam).toHaveBeenCalledTimes(1);
    expect(clientA.undoSpam).toHaveBeenCalledWith('same-id', 'a-inbox', 'account-a');
    expect(clientB.undoSpam).toHaveBeenCalledTimes(1);
    expect(clientB.undoSpam).toHaveBeenCalledWith('same-id', 'b-inbox', 'account-b');

    const state = useEmailStore.getState();
    // Only the selected messages leave the list, not an unselected one.
    expect(state.emails.map(e => emailKeyFor(e))).toEqual([emailKeyFor(emailB2)]);
    const bList = state.accountMailboxes['account-b'];
    expect(bList.find(m => m.id === 'b-junk')).toMatchObject({ totalEmails: 1, unreadEmails: 0 });
    expect(bList.find(m => m.id === 'b-inbox')).toMatchObject({ totalEmails: 1, unreadEmails: 1 });
  });

  it('marks as spam with no folder selected instead of returning early', async () => {
    useEmailStore.setState({ unifiedRole: 'inbox' } as never);

    await useEmailStore.getState().batchMarkAsSpam(clientA, ['same-id']);

    expect(clientA.markAsSpam).toHaveBeenCalledWith('same-id', 'account-a', false);
    expect(clientB.markAsSpam).toHaveBeenCalledWith('same-id', 'account-b', false);
  });

  it('throws when one account fails and keeps that message listed', async () => {
    (clientB.undoSpam as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('notUpdated'));

    await expect(useEmailStore.getState().batchUndoSpam(clientA, ['same-id'])).rejects.toThrow('notUpdated');

    const keys = useEmailStore.getState().emails.map(e => emailKeyFor(e));
    expect(keys).toEqual([emailKeyFor(emailB), emailKeyFor(emailB2)]);
  });

  it('throws when none of the ids are found', async () => {
    useEmailStore.setState({ selectedEmailKeys: new Set() } as never);
    await expect(useEmailStore.getState().batchMarkAsSpam(clientA, ['missing'])).rejects.toThrow(/not found/i);
    expect(clientA.markAsSpam).not.toHaveBeenCalled();
  });
});

describe('markAsSpam without a known source folder', () => {
  it('still moves the message instead of reporting success for nothing', async () => {
    const client = makeClient();
    useAuthStore.setState({
      activeAccountId: 'account-a',
      getClientForAccount: () => client as never,
    } as never);
    useSettingsStore.setState({ deleteAction: 'trash' } as never);
    useEmailStore.setState({
      isUnifiedView: false,
      unifiedRole: null,
      viewingAccountId: null,
      selectedKeyword: null,
      selectedMailbox: 'gone',
      mailboxes: [makeMailbox({ id: 'a-junk', role: 'junk' })],
      accountMailboxes: {},
      emails: [makeEmail({ id: 'e1' })],
      selectedEmail: null,
      spamUndoCache: new Map(),
    } as never);

    await useEmailStore.getState().markAsSpam(client, 'e1');

    expect(client.markAsSpam).toHaveBeenCalledWith('e1', undefined, false);
    expect(useEmailStore.getState().spamUndoCache.has('e1')).toBe(false);
  });
});
