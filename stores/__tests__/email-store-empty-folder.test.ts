import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useEmailStore } from '../email-store';
import { useAuthStore } from '@/stores/auth-store';
import { clearAllStores } from '@/lib/account-state-manager';
import { IncompleteDeleteError } from '@/lib/jmap/delete-error';
import { useSettingsStore } from '@/stores/settings-store';
import type { Email, Mailbox } from '@/lib/jmap/types';
import type { IJMAPClient } from '@/lib/jmap/client-interface';

// "Empty folder" on an ordinary folder used to destroy every email in it. It
// now moves them to the trash like any other delete; only Trash and Junk (and
// users who chose permanent deletion) still destroy.

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

function makeClient() {
  return {
    emptyMailbox: vi.fn().mockResolvedValue(0),
    moveMailboxContents: vi.fn().mockResolvedValue(0),
  } as unknown as IJMAPClient;
}

const counts = (mailboxId: string) => {
  const mb = useEmailStore.getState().mailboxes.find(m => m.id === mailboxId)!;
  return { total: mb.totalEmails, unread: mb.unreadEmails };
};

describe('emptyMailbox', () => {
  let client: IJMAPClient;

  beforeEach(() => {
    client = makeClient();
    useSettingsStore.setState({ deleteAction: 'trash', permanentlyDeleteJunk: false } as never);
    useEmailStore.setState({
      isUnifiedView: false,
      unifiedRole: null,
      viewingAccountId: null,
      selectedMailbox: 'news',
      selectedEmail: null,
      emails: [],
      mailboxes: [
        makeMailbox({ id: 'inbox', role: 'inbox' }),
        makeMailbox({ id: 'news', name: 'Newsletters', totalEmails: 12, unreadEmails: 5, totalThreads: 10, unreadThreads: 4 }),
        makeMailbox({ id: 'trash', name: 'Deleted Items', role: 'trash', totalEmails: 3, unreadEmails: 1, totalThreads: 3, unreadThreads: 1 }),
        makeMailbox({ id: 'junk', name: 'Junk', role: 'junk', totalEmails: 4 }),
        makeMailbox({ id: 'owner-x:x-lists', originalId: 'x-lists', name: 'Lists', isShared: true, accountId: 'owner-x', totalEmails: 2 }),
        makeMailbox({ id: 'owner-x:x-trash', originalId: 'x-trash', name: 'Trash', role: 'trash', isShared: true, accountId: 'owner-x' }),
      ],
    });
  });

  it('moves an ordinary folder into the trash instead of destroying it', async () => {
    await useEmailStore.getState().emptyMailbox(client, 'news');

    expect(client.moveMailboxContents).toHaveBeenCalledWith('news', 'trash', undefined, false);
    expect(client.emptyMailbox).not.toHaveBeenCalled();
    expect(counts('news')).toEqual({ total: 0, unread: 0 });
    expect(counts('trash')).toEqual({ total: 15, unread: 6 });
  });

  it('marks the mail read on the way when the user deletes with "trash and read"', async () => {
    useSettingsStore.setState({ deleteAction: 'trash-and-read' } as never);

    await useEmailStore.getState().emptyMailbox(client, 'news');

    expect(client.moveMailboxContents).toHaveBeenCalledWith('news', 'trash', undefined, true);
    expect(counts('trash')).toEqual({ total: 15, unread: 1 });
  });

  it('moves a shared folder into the owner account trash', async () => {
    await useEmailStore.getState().emptyMailbox(client, 'owner-x:x-lists');

    expect(client.moveMailboxContents).toHaveBeenCalledWith('x-lists', 'x-trash', 'owner-x', false);
  });

  it.each(['trash', 'junk'])('still permanently empties %s', async (mailboxId) => {
    await useEmailStore.getState().emptyMailbox(client, mailboxId);

    expect(client.emptyMailbox).toHaveBeenCalledWith(mailboxId, undefined);
    expect(client.moveMailboxContents).not.toHaveBeenCalled();
  });

  it('refreshes shared Trash counts after navigating to another folder in the same account', async () => {
    const auth = useAuthStore.getState();
    const trash = makeMailbox({
      id: 'owner-x:x-trash', originalId: 'x-trash', role: 'trash', isShared: true, accountId: 'owner-x',
      totalEmails: 3, unreadEmails: 2, totalThreads: 3, unreadThreads: 2,
    });
    const opened = makeMailbox({ id: 'owner-x:x-lists', originalId: 'x-lists', isShared: true, accountId: 'owner-x' });
    const reader: Email = {
      id: 'opened-message', threadId: 'opened-thread', mailboxIds: { [opened.id]: true }, keywords: {},
      receivedAt: '2026-11-18T08:00:00Z', size: 1, hasAttachment: false,
    };
    const rows = [reader];
    const authoritativeCounts = { totalEmails: 1, unreadEmails: 1, totalThreads: 1, unreadThreads: 1 };
    const getMailboxes = vi.fn().mockResolvedValue([{ ...trash, id: 'x-trash', ...authoritativeCounts }]);
    const destroy = Promise.withResolvers<number>();
    const partial = new IncompleteDeleteError({
      destroyedIds: ['destroyed-message'], notDestroyed: { 'refused-message': { type: 'forbidden' } },
      unknownIds: [], unattemptedIds: [],
    }, new Error('Trash refused one message'));
    Object.assign(client, { getMailboxes });
    vi.mocked(client.emptyMailbox).mockReturnValueOnce(destroy.promise);

    useAuthStore.setState({ client, activeAccountId: 'a' });
    useEmailStore.setState({ selectedMailbox: trash.id, mailboxes: [trash, opened] });
    const completion = useEmailStore.getState().emptyMailbox(client, trash.id);
    try {
      expect(client.emptyMailbox).toHaveBeenCalledExactlyOnceWith('x-trash', 'owner-x');
      useEmailStore.getState().selectMailbox(opened.id);
      useEmailStore.setState({ emails: rows, selectedEmail: reader });

      const rejected = expect(completion).rejects.toBe(partial);
      destroy.reject(partial);
      await rejected;

      const state = useEmailStore.getState();
      expect(state.selectedMailbox).toBe(opened.id);
      expect(state.emails).toBe(rows);
      expect(state.selectedEmail).toBe(reader);
      expect(state.mailboxes).toEqual([{ ...trash, ...authoritativeCounts }, opened]);
      expect(getMailboxes).toHaveBeenCalledExactlyOnceWith('owner-x');
    } finally {
      destroy.resolve(0);
      useAuthStore.setState(auth, true);
    }
  });

  it('keeps the new account’s list load intact when a partial Empty Trash finishes', async () => {
    const auth = useAuthStore.getState();
    const counters = Promise.withResolvers<Mailbox[]>();
    const countersStarted = Promise.withResolvers<void>();
    const page = Promise.withResolvers<Awaited<ReturnType<IJMAPClient['getEmails']>>>();
    const getMailboxes = vi.fn(() => {
      countersStarted.resolve();
      return counters.promise;
    });
    const getEmails = vi.fn(() => page.promise);
    const clientB = { getEmails } as unknown as IJMAPClient;
    const row = (id: string): Email => ({
      id, threadId: id, mailboxIds: { trash: true }, subject: id, keywords: {},
      receivedAt: '2026-11-18T08:00:00Z', size: 1, hasAttachment: false,
    });
    const deleted = row('a-deleted');
    const refused = row('a-refused');
    const bRow = row('b-message');
    const trashA = makeMailbox({ id: 'trash', role: 'trash', accountId: 'a', totalEmails: 2, unreadEmails: 2 });
    const trashB = makeMailbox({
      id: 'trash', role: 'trash', accountId: 'b', totalEmails: 8, unreadEmails: 3, totalThreads: 7, unreadThreads: 2,
    });
    const partial = new IncompleteDeleteError({
      destroyedIds: [deleted.id], notDestroyed: { [refused.id]: { type: 'forbidden' } },
      unknownIds: [], unattemptedIds: [],
    }, new Error('A refused one message'));

    Object.assign(client, { getMailboxes });
    vi.mocked(client.emptyMailbox).mockRejectedValueOnce(partial);
    useAuthStore.setState({ client, activeAccountId: 'a' });
    useEmailStore.setState({ selectedMailbox: 'trash', mailboxes: [trashA], emails: [deleted, refused], selectedEmail: refused });
    const completing = useEmailStore.getState().emptyMailbox(client, 'trash').catch((error: unknown) => error);
    let loadingB: Promise<void> | undefined;
    try {
      await countersStarted.promise;
      expect(getMailboxes).toHaveBeenCalledExactlyOnceWith(undefined);
      expect(useEmailStore.getState().emails).toEqual([refused]);

      clearAllStores();
      useAuthStore.setState({ client: clientB, activeAccountId: 'b' });
      useEmailStore.setState({ selectedMailbox: 'trash', mailboxes: [trashB], emails: [bRow], selectedEmail: bRow });
      loadingB = useEmailStore.getState().fetchEmails(clientB, 'trash');
      expect(getEmails).toHaveBeenCalledTimes(1);
      expect(useEmailStore.getState().isLoading).toBe(true);

      counters.resolve([{ ...trashA, totalEmails: 1, unreadEmails: 1 }]);
      expect(await completing).toBe(partial);
      expect(useEmailStore.getState()).toMatchObject({
        isLoading: true, error: null, emails: [bRow], selectedEmail: bRow, mailboxes: [trashB],
      });
    } finally {
      counters.resolve([]);
      page.resolve({ emails: [bRow], total: 1, hasMore: false, threadCounts: {} });
      await loadingB;
      useAuthStore.setState(auth, true);
    }
  });

  it('destroys when the user chose permanent deletion', async () => {
    useSettingsStore.setState({ deleteAction: 'permanent' } as never);

    await useEmailStore.getState().emptyMailbox(client, 'news');

    expect(client.emptyMailbox).toHaveBeenCalledWith('news', undefined);
    expect(client.moveMailboxContents).not.toHaveBeenCalled();
  });

  it('refuses rather than destroying when the account has no trash', async () => {
    useEmailStore.setState({
      mailboxes: useEmailStore.getState().mailboxes.filter(mb => mb.id !== 'trash'),
    });

    await expect(useEmailStore.getState().emptyMailbox(client, 'news')).rejects.toThrow(/Trash/);
    expect(client.emptyMailbox).not.toHaveBeenCalled();
    expect(client.moveMailboxContents).not.toHaveBeenCalled();
    expect(counts('news')).toEqual({ total: 12, unread: 5 });
  });
});
