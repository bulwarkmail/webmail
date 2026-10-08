import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useEmailStore } from '../email-store';
import type { Mailbox } from '@/lib/jmap/types';
import type { IJMAPClient } from '@/lib/jmap/client-interface';

// #1173: moving many folders under one parent is a single batched update,
// not one request per folder, and refused folders are reported back.

function makeMailbox(overrides: Partial<Mailbox> = {}): Mailbox {
  return {
    id: 'mb',
    name: 'Folder',
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

describe('moveMailboxes', () => {
  let client: IJMAPClient;
  let updateMailboxes: ReturnType<typeof vi.fn>;
  let fetchMailboxes: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    updateMailboxes = vi.fn().mockResolvedValue({});
    fetchMailboxes = vi.fn().mockResolvedValue(undefined);
    client = { updateMailboxes, updateMailbox: vi.fn() } as unknown as IJMAPClient;
    useEmailStore.setState({
      isUnifiedView: false,
      unifiedRole: null,
      viewingAccountId: null,
      fetchMailboxes,
      mailboxes: [
        makeMailbox({ id: 'inbox', name: 'Inbox', role: 'inbox' }),
        makeMailbox({ id: 'old', name: 'Old mailbox' }),
        makeMailbox({ id: 'a', name: 'A' }),
        makeMailbox({ id: 'b', name: 'B' }),
        makeMailbox({ id: 'c', name: 'C', parentId: 'inbox' }),
      ],
    } as never);
  });

  it('reparents every folder in one call and re-syncs', async () => {
    const failed = await useEmailStore.getState().moveMailboxes(client, ['a', 'b', 'c'], 'old');

    expect(failed).toEqual([]);
    expect(updateMailboxes).toHaveBeenCalledTimes(1);
    expect(updateMailboxes).toHaveBeenCalledWith(
      { a: { parentId: 'old' }, b: { parentId: 'old' }, c: { parentId: 'old' } },
      undefined,
    );
    expect(client.updateMailbox).not.toHaveBeenCalled();
    expect(fetchMailboxes).toHaveBeenCalledWith(client);
  });

  it('moves folders to the top level with a null parent', async () => {
    await useEmailStore.getState().moveMailboxes(client, ['c'], null);

    expect(updateMailboxes).toHaveBeenCalledWith({ c: { parentId: null } }, undefined);
  });

  it('applies the new parent before the server answers', async () => {
    let resolve!: (v: Record<string, string>) => void;
    updateMailboxes.mockReturnValue(new Promise(r => { resolve = r; }));

    const pending = useEmailStore.getState().moveMailboxes(client, ['a', 'b'], 'old');
    const parents = () => useEmailStore.getState().mailboxes
      .filter(mb => ['a', 'b'].includes(mb.id))
      .map(mb => mb.parentId);
    expect(parents()).toEqual(['old', 'old']);

    resolve({});
    await pending;
  });

  it('returns the folders the server refused', async () => {
    updateMailboxes.mockResolvedValue({ b: 'invalidProperties' });

    const failed = await useEmailStore.getState().moveMailboxes(client, ['a', 'b'], 'old');

    expect(failed).toEqual(['b']);
    expect(fetchMailboxes).toHaveBeenCalled();
  });

  it('re-syncs and rethrows when the request fails', async () => {
    updateMailboxes.mockRejectedValue(new Error('network down'));

    await expect(useEmailStore.getState().moveMailboxes(client, ['a'], 'old')).rejects.toThrow('network down');
    expect(fetchMailboxes).toHaveBeenCalled();
  });
});
