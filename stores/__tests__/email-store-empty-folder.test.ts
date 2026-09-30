import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useEmailStore } from '../email-store';
import { useSettingsStore } from '@/stores/settings-store';
import type { Mailbox } from '@/lib/jmap/types';
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
