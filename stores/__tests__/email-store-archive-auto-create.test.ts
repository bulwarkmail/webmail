import { describe, expect, it, vi } from 'vitest';
import { ensureArchiveMailbox, ArchiveMailboxNotFoundError } from '../email-store';
import type { Mailbox } from '@/lib/jmap/types';
import type { IJMAPClient } from '@/lib/jmap/client-interface';

// A fresh Stalwart account has no archive-role mailbox, so Archive used to
// stop at the not-found toast. The folder is now created on first use, in the
// account the action targets. (#578)

function makeMailbox(overrides: Partial<Mailbox> = {}): Mailbox {
  return {
    id: 'inbox',
    name: 'Inbox',
    sortOrder: 0,
    totalEmails: 0,
    unreadEmails: 0,
    totalThreads: 0,
    unreadThreads: 0,
    isSubscribed: true,
    myRights: {
      mayReadItems: true, mayAddItems: true, mayRemoveItems: true, maySetSeen: true,
      maySetKeywords: true, mayCreateChild: true, mayRename: true, mayDelete: true, maySubmit: true,
    },
    ...overrides,
  };
}

const ownInbox = makeMailbox({ id: 'a-inbox', role: 'inbox' });
const ownArchive = makeMailbox({ id: 'a-archive', name: 'Archive', role: 'archive' });
const sharedInbox = makeMailbox({
  id: 'owner-x:x-inbox', originalId: 'x-inbox', role: 'inbox', isShared: true, accountId: 'owner-x',
});
const sharedArchive = makeMailbox({
  id: 'owner-x:x-archive', originalId: 'x-archive', name: 'Archive', role: 'archive', isShared: true, accountId: 'owner-x',
});

function makeClient(): IJMAPClient & { createMailbox: ReturnType<typeof vi.fn> } {
  return { createMailbox: vi.fn(async () => ownArchive) } as unknown as IJMAPClient & { createMailbox: ReturnType<typeof vi.fn> };
}

describe('ensureArchiveMailbox', () => {
  it('uses an existing owner Archive when top-level creation is prohibited', async () => {
    const client = { ...makeClient(), getAccountCapability: vi.fn(() => ({ mayCreateTopLevelMailbox: false })) };
    const refresh = vi.fn();

    const archive = await ensureArchiveMailbox({
      client, mailboxes: [ownArchive, sharedInbox, sharedArchive],
      selectedMailboxId: sharedInbox.id, refresh,
    });

    expect(archive).toBe(sharedArchive);
    expect(client.createMailbox).not.toHaveBeenCalled();
    expect(refresh).not.toHaveBeenCalled();
  });

  it.each(['selected owner', 'explicit owner'] as const)('does not create a missing Archive for a prohibited %s', async scope => {
    const client = {
      ...makeClient(),
      getAccountCapability: vi.fn((_capability: string, owner?: string) => ({
        mayCreateTopLevelMailbox: owner !== 'owner-x',
      })),
    };
    const refresh = vi.fn(async () => [ownArchive, sharedInbox, sharedArchive]);

    await expect(ensureArchiveMailbox({
      client, mailboxes: [ownArchive, sharedInbox],
      selectedMailboxId: scope === 'selected owner' ? sharedInbox.id : ownInbox.id,
      accountId: scope === 'explicit owner' ? 'owner-x' : undefined, refresh,
    })).rejects.toBeInstanceOf(ArchiveMailboxNotFoundError);

    expect(client.getAccountCapability).toHaveBeenCalledWith('urn:ietf:params:jmap:mail', 'owner-x');
    expect(client.createMailbox).not.toHaveBeenCalled();
    expect(refresh).not.toHaveBeenCalled();
  });

  it.each([
    { capability: { mayCreateTopLevelMailbox: true }, label: 'allowed creation' },
    { capability: {}, label: 'absent flag' },
    { capability: undefined, label: 'absent mail capability' },
  ])('preserves Archive creation with $label', async ({ capability }) => {
    const client = { ...makeClient(), getAccountCapability: vi.fn(() => capability) };
    const refresh = vi.fn(async () => [ownArchive, sharedInbox, sharedArchive]);

    const archive = await ensureArchiveMailbox({
      client, mailboxes: [ownArchive, sharedInbox], selectedMailboxId: sharedInbox.id, refresh,
    });

    expect(archive).toBe(sharedArchive);
    expect(client.getAccountCapability).toHaveBeenCalledWith('urn:ietf:params:jmap:mail', 'owner-x');
    expect(client.createMailbox).toHaveBeenCalledWith('Archive', undefined, 'owner-x', { role: 'archive' });
    expect(refresh).toHaveBeenCalledOnce();
  });

  it('checks the client’s primary account when the archive owner is implicit', async () => {
    const client = { ...makeClient(), getAccountCapability: vi.fn(() => ({ mayCreateTopLevelMailbox: false })) };
    const refresh = vi.fn(async () => [ownInbox, ownArchive]);

    await expect(ensureArchiveMailbox({
      client, mailboxes: [ownInbox], selectedMailboxId: ownInbox.id, refresh,
    })).rejects.toBeInstanceOf(ArchiveMailboxNotFoundError);

    expect(client.getAccountCapability).toHaveBeenCalledWith('urn:ietf:params:jmap:mail', undefined);
    expect(client.createMailbox).not.toHaveBeenCalled();
    expect(refresh).not.toHaveBeenCalled();
  });

  it('returns the existing archive folder without creating one', async () => {
    const client = makeClient();
    const refresh = vi.fn();
    const result = await ensureArchiveMailbox({
      client, mailboxes: [ownInbox, ownArchive], selectedMailboxId: 'a-inbox', refresh,
    });
    expect(result).toBe(ownArchive);
    expect(client.createMailbox).not.toHaveBeenCalled();
    expect(refresh).not.toHaveBeenCalled();
  });

  it('creates an archive-role folder in the own account and returns it from the refreshed list', async () => {
    const client = makeClient();
    const refresh = vi.fn(async () => [ownInbox, ownArchive]);
    const result = await ensureArchiveMailbox({
      client, mailboxes: [ownInbox], selectedMailboxId: 'a-inbox', refresh,
    });
    expect(client.createMailbox).toHaveBeenCalledWith('Archive', undefined, undefined, { role: 'archive' });
    expect(refresh).toHaveBeenCalledTimes(1);
    expect(result).toBe(ownArchive);
  });

  it('creates the folder in the selected shared folder\'s owner account', async () => {
    const client = makeClient();
    const refresh = vi.fn(async () => [ownInbox, ownArchive, sharedInbox, sharedArchive]);
    const result = await ensureArchiveMailbox({
      client, mailboxes: [ownInbox, ownArchive, sharedInbox], selectedMailboxId: 'owner-x:x-inbox', refresh,
    });
    expect(client.createMailbox).toHaveBeenCalledWith('Archive', undefined, 'owner-x', { role: 'archive' });
    // The store's namespaced object, not the bare one Mailbox/set returned.
    expect(result).toBe(sharedArchive);
  });

  it('pins the account in unified view', async () => {
    const client = makeClient();
    const refresh = vi.fn(async () => [ownInbox, ownArchive, sharedInbox, sharedArchive]);
    await ensureArchiveMailbox({
      client, mailboxes: [ownInbox, ownArchive, sharedInbox], selectedMailboxId: 'unified-inbox', accountId: 'owner-x', refresh,
    });
    expect(client.createMailbox).toHaveBeenCalledWith('Archive', undefined, 'owner-x', { role: 'archive' });
  });

  it('still reports not-found when the created folder does not come back', async () => {
    const client = makeClient();
    const refresh = vi.fn(async () => [ownInbox]);
    await expect(ensureArchiveMailbox({
      client, mailboxes: [ownInbox], selectedMailboxId: 'a-inbox', refresh,
    })).rejects.toBeInstanceOf(ArchiveMailboxNotFoundError);
  });

  it('surfaces a server refusal instead of swallowing it', async () => {
    const client = makeClient();
    client.createMailbox.mockRejectedValueOnce(new Error('Failed to create mailbox: forbidden'));
    await expect(ensureArchiveMailbox({
      client, mailboxes: [ownInbox], selectedMailboxId: 'a-inbox', refresh: vi.fn(),
    })).rejects.toThrow('forbidden');
  });
});
