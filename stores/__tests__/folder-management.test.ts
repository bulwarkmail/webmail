import { describe, it, expect, beforeEach, vi } from 'vitest';
import { useEmailStore } from '../email-store';
import { useAuthStore } from '../auth-store';
import type { Mailbox } from '@/lib/jmap/types';
import type { IJMAPClient } from '@/lib/jmap/client-interface';
import { UNIFIED_MAILBOX_IDS } from '@/lib/jmap/types';
import { emailHooks } from '@/lib/plugin-hooks';

function makeMailbox(overrides: Partial<Mailbox> = {}): Mailbox {
  return {
    id: overrides.id ?? 'mb-1',
    name: overrides.name ?? 'Test Folder',
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

function makeMockClient(overrides: Record<string, unknown> = {}) {
  return {
    getAccountId: vi.fn().mockReturnValue('account-a'),
    getServerUrl: vi.fn().mockReturnValue('https://mail.example.test'),
    createMailbox: vi.fn().mockResolvedValue(makeMailbox({ id: 'mb-new' })),
    updateMailbox: vi.fn().mockResolvedValue(undefined),
    deleteMailbox: vi.fn().mockResolvedValue(undefined),
    getAllMailboxes: vi.fn().mockResolvedValue([]),
    ...overrides,
  } as unknown as IJMAPClient;
}

describe('email-store folder management', () => {
  const inbox = makeMailbox({ id: 'inbox-1', name: 'Inbox', role: 'inbox' });
  const sent = makeMailbox({ id: 'sent-1', name: 'Sent', role: 'sent' });
  const trash = makeMailbox({ id: 'trash-1', name: 'Trash', role: 'trash' });
  const custom = makeMailbox({ id: 'custom-1', name: 'My Folder' });

  beforeEach(() => {
    useAuthStore.setState({
      activeAccountId: 'account-a',
      getClientForAccount: () => undefined,
      getAllConnectedClients: () => new Map(),
    } as never);
    useEmailStore.setState({
      mailboxes: [inbox, sent, trash, custom],
      accountMailboxes: {},
      viewingAccountId: null,
      selectedMailbox: 'inbox-1',
      error: null,
    });
  });

  describe('createMailbox', () => {
    it('should call client.createMailbox and refresh mailboxes', async () => {
      const newMailboxes = [
        ...useEmailStore.getState().mailboxes,
        makeMailbox({ id: 'mb-new', name: 'New Folder' }),
      ];
      const client = makeMockClient({
        getAllMailboxes: vi.fn().mockResolvedValue(newMailboxes),
      });

      await useEmailStore.getState().createMailbox(client, 'New Folder');

      expect(client.createMailbox).toHaveBeenCalledWith('New Folder', undefined, undefined);
      expect(client.getAllMailboxes).toHaveBeenCalled();
    });

    it('should call client.createMailbox with parentId', async () => {
      const client = makeMockClient({
        getAllMailboxes: vi.fn().mockResolvedValue(useEmailStore.getState().mailboxes),
      });

      await useEmailStore.getState().createMailbox(client, 'Sub Folder', 'inbox-1');

      expect(client.createMailbox).toHaveBeenCalledWith('Sub Folder', 'inbox-1', undefined);
    });

    it('should set error on failure', async () => {
      const client = makeMockClient({
        createMailbox: vi.fn().mockRejectedValue(new Error('Server error')),
      });

      await expect(
        useEmailStore.getState().createMailbox(client, 'Fail')
      ).rejects.toThrow();

      expect(useEmailStore.getState().error).toBe('Server error');
    });
  });

  describe('renameMailbox', () => {
    it('should update mailbox name locally', async () => {
      const client = makeMockClient();

      await useEmailStore.getState().renameMailbox(client, 'custom-1', 'Renamed');

      expect(client.updateMailbox).toHaveBeenCalledWith('custom-1', { name: 'Renamed' }, undefined);
      const mb = useEmailStore.getState().mailboxes.find(m => m.id === 'custom-1');
      expect(mb?.name).toBe('Renamed');
    });

    it('should not change other mailboxes', async () => {
      const client = makeMockClient();

      await useEmailStore.getState().renameMailbox(client, 'custom-1', 'Renamed');

      const inboxMb = useEmailStore.getState().mailboxes.find(m => m.id === 'inbox-1');
      expect(inboxMb?.name).toBe('Inbox');
    });

    it('should set error on failure', async () => {
      const client = makeMockClient({
        updateMailbox: vi.fn().mockRejectedValue(new Error('Rename failed')),
      });

      await expect(
        useEmailStore.getState().renameMailbox(client, 'custom-1', 'Fail')
      ).rejects.toThrow();

      expect(useEmailStore.getState().error).toBe('Rename failed');
    });
  });

  describe('deleteMailbox', () => {
    it('should remove mailbox from state', async () => {
      const client = makeMockClient();

      await useEmailStore.getState().deleteMailbox(client, 'custom-1');

      expect(client.deleteMailbox).toHaveBeenCalledWith('custom-1', undefined);
      const mb = useEmailStore.getState().mailboxes.find(m => m.id === 'custom-1');
      expect(mb).toBeUndefined();
      expect(useEmailStore.getState().mailboxes).toHaveLength(3);
    });

    it('should switch to inbox when deleting selected mailbox', async () => {
      useEmailStore.setState({ selectedMailbox: 'custom-1' });
      const client = makeMockClient();

      await useEmailStore.getState().deleteMailbox(client, 'custom-1');

      expect(useEmailStore.getState().selectedMailbox).toBe('inbox-1');
    });

    it('should keep current selection when deleting non-selected mailbox', async () => {
      const client = makeMockClient();

      await useEmailStore.getState().deleteMailbox(client, 'custom-1');

      expect(useEmailStore.getState().selectedMailbox).toBe('inbox-1');
    });

    it('should set error on failure', async () => {
      const client = makeMockClient({
        deleteMailbox: vi.fn().mockRejectedValue(new Error('Delete failed')),
      });

      await expect(
        useEmailStore.getState().deleteMailbox(client, 'custom-1')
      ).rejects.toThrow();

      expect(useEmailStore.getState().error).toBe('Delete failed');
      // Mailbox should still exist
      expect(useEmailStore.getState().mailboxes).toHaveLength(4);
    });
  });

  describe('setMailboxRole', () => {
    it('should assign a role to a mailbox', async () => {
      const newMailboxes = useEmailStore.getState().mailboxes.map(mb =>
        mb.id === 'custom-1' ? { ...mb, role: 'archive' } : mb
      );
      const client = makeMockClient({
        getAllMailboxes: vi.fn().mockResolvedValue(newMailboxes),
      });

      await useEmailStore.getState().setMailboxRole(client, 'custom-1', 'archive');

      expect(client.updateMailbox).toHaveBeenCalledWith('custom-1', { role: 'archive' }, undefined);
    });

    it('should clear existing role from another mailbox when reassigning', async () => {
      const newMailboxes = useEmailStore.getState().mailboxes.map(mb => {
        if (mb.id === 'custom-1') return { ...mb, role: 'trash' };
        if (mb.id === 'trash-1') return { ...mb, role: undefined };
        return mb;
      });
      const client = makeMockClient({
        getAllMailboxes: vi.fn().mockResolvedValue(newMailboxes),
      });

      await useEmailStore.getState().setMailboxRole(client, 'custom-1', 'trash');

      // Should first clear trash role from trash-1
      expect(client.updateMailbox).toHaveBeenCalledWith('trash-1', { role: null }, undefined);
      // Then set trash role on custom-1
      expect(client.updateMailbox).toHaveBeenCalledWith('custom-1', { role: 'trash' }, undefined);
    });

    it('should clear role from a mailbox when role is null', async () => {
      const newMailboxes = useEmailStore.getState().mailboxes.map(mb =>
        mb.id === 'trash-1' ? { ...mb, role: undefined } : mb
      );
      const client = makeMockClient({
        getAllMailboxes: vi.fn().mockResolvedValue(newMailboxes),
      });

      await useEmailStore.getState().setMailboxRole(client, 'trash-1', null);

      expect(client.updateMailbox).toHaveBeenCalledWith('trash-1', { role: null }, undefined);
    });

    it('should not clear role from same mailbox when re-assigning same role', async () => {
      const client = makeMockClient({
        getAllMailboxes: vi.fn().mockResolvedValue(useEmailStore.getState().mailboxes),
      });

      await useEmailStore.getState().setMailboxRole(client, 'trash-1', 'trash');

      // Should only call once (to set the role), not twice (no need to clear from same mailbox)
      expect(client.updateMailbox).toHaveBeenCalledTimes(1);
      expect(client.updateMailbox).toHaveBeenCalledWith('trash-1', { role: 'trash' }, undefined);
    });

    it('should clear role from ALL mailboxes with that role when reassigning', async () => {
      // Simulate server anomaly: two mailboxes with role "trash"
      const extraTrash = makeMailbox({ id: 'trash-2', name: 'Deleted Items', role: 'trash' });
      useEmailStore.setState({
        mailboxes: [inbox, sent, trash, custom, extraTrash],
      });

      const newMailboxes = [inbox, sent, custom,
        makeMailbox({ id: 'trash-1', name: 'Trash', role: undefined }),
        makeMailbox({ id: 'trash-2', name: 'Deleted Items', role: undefined }),
      ];
      // custom-1 gets the trash role
      newMailboxes[2] = { ...newMailboxes[2], role: 'trash' };

      const client = makeMockClient({
        getAllMailboxes: vi.fn().mockResolvedValue(newMailboxes),
      });

      await useEmailStore.getState().setMailboxRole(client, 'custom-1', 'trash');

      // Should clear trash role from BOTH trash-1 and trash-2
      expect(client.updateMailbox).toHaveBeenCalledWith('trash-1', { role: null }, undefined);
      expect(client.updateMailbox).toHaveBeenCalledWith('trash-2', { role: null }, undefined);
      // Then set trash role on custom-1
      expect(client.updateMailbox).toHaveBeenCalledWith('custom-1', { role: 'trash' }, undefined);
      expect(client.updateMailbox).toHaveBeenCalledTimes(3);
    });

    it('should set error on failure', async () => {
      const client = makeMockClient({
        updateMailbox: vi.fn().mockRejectedValue(new Error('Role update failed')),
      });

      await expect(
        useEmailStore.getState().setMailboxRole(client, 'custom-1', 'archive')
      ).rejects.toThrow();

      expect(useEmailStore.getState().error).toBe('Role update failed');
    });
  });

  describe('shared/group mailbox routing', () => {
    const sharedFolder = makeMailbox({
      id: 'owner-x:shared-1',
      originalId: 'shared-1',
      name: 'Shared Folder',
      accountId: 'owner-x',
      isShared: true,
    });
    const sharedArchive = makeMailbox({
      id: 'owner-x:archive-x',
      originalId: 'archive-x',
      name: 'Shared Archive',
      role: 'archive',
      accountId: 'owner-x',
      isShared: true,
    });

    beforeEach(() => {
      useEmailStore.setState({
        mailboxes: [inbox, sent, trash, custom, sharedFolder, sharedArchive],
        selectedMailbox: sharedFolder.id,
      });
    });

    it('creates a subfolder with the owner accountId and bare parent id', async () => {
      const client = makeMockClient();

      await useEmailStore.getState().createMailbox(client, 'Shared Child', sharedFolder.id);

      expect(client.createMailbox).toHaveBeenCalledWith('Shared Child', 'shared-1', 'owner-x');
    });

    it('keeps root creation in the personal Folders account while a shared folder is selected', async () => {
      const client = makeMockClient();

      await useEmailStore.getState().createMailbox(client, 'Personal Root');

      expect(client.createMailbox).toHaveBeenCalledWith('Personal Root', undefined, undefined);
    });

    it('creates a shared root folder only when the caller explicitly targets its account', async () => {
      const client = makeMockClient();

      await useEmailStore.getState().createMailbox(client, 'Shared Root', undefined, 'owner-x');

      expect(client.createMailbox).toHaveBeenCalledWith('Shared Root', undefined, 'owner-x');
    });

    it('renames a shared folder through its owner account and preserves the namespaced store id', async () => {
      const client = makeMockClient();

      await useEmailStore.getState().renameMailbox(client, sharedFolder.id, 'Renamed Shared');

      expect(client.updateMailbox).toHaveBeenCalledWith('shared-1', { name: 'Renamed Shared' }, 'owner-x');
      expect(useEmailStore.getState().mailboxes.find((mb) => mb.id === sharedFolder.id)?.name)
        .toBe('Renamed Shared');
    });

    it('deletes a shared folder through its owner account and removes the namespaced store entry', async () => {
      const client = makeMockClient();
      useEmailStore.setState({ selectedMailbox: inbox.id });

      await useEmailStore.getState().deleteMailbox(client, sharedFolder.id);

      expect(client.deleteMailbox).toHaveBeenCalledWith('shared-1', 'owner-x');
      expect(useEmailStore.getState().mailboxes.some((mb) => mb.id === sharedFolder.id)).toBe(false);
    });

    it('reassigns a shared role only within the shared owner account', async () => {
      const ownArchive = makeMailbox({ id: 'archive-a', name: 'Personal Archive', role: 'archive' });
      useEmailStore.setState({
        mailboxes: [inbox, sent, trash, custom, ownArchive, sharedFolder, sharedArchive],
      });
      const client = makeMockClient();

      await useEmailStore.getState().setMailboxRole(client, sharedFolder.id, 'archive');

      expect(client.updateMailbox).toHaveBeenCalledWith('archive-x', { role: null }, 'owner-x');
      expect(client.updateMailbox).toHaveBeenCalledWith('shared-1', { role: 'archive' }, 'owner-x');
      expect(client.updateMailbox).not.toHaveBeenCalledWith('archive-a', { role: null }, undefined);
    });

    it('keeps role reassignment scoped when the owner has a directly connected client', async () => {
      const ownArchive = makeMailbox({ id: 'archive-a', name: 'Personal Archive', role: 'archive' });
      useEmailStore.setState({
        mailboxes: [inbox, sent, trash, custom, ownArchive, sharedFolder, sharedArchive],
      });
      const activeClient = makeMockClient();
      const ownerClient = makeMockClient({
        getAccountId: vi.fn().mockReturnValue('owner-x'),
      });
      useAuthStore.setState({
        getAllConnectedClients: () => new Map([['owner-login', ownerClient]]),
      } as never);

      await useEmailStore.getState().setMailboxRole(activeClient, sharedFolder.id, 'archive');

      expect(ownerClient.updateMailbox).toHaveBeenCalledWith('archive-x', { role: null }, undefined);
      expect(ownerClient.updateMailbox).toHaveBeenCalledWith('shared-1', { role: 'archive' }, undefined);
      expect(activeClient.updateMailbox).not.toHaveBeenCalled();
    });

    it('ignores a same-accountId client from a different server', async () => {
      const activeClient = makeMockClient();
      // Same opaque JMAP account id, different server: a collision, not the owner.
      const foreignClient = makeMockClient({
        getAccountId: vi.fn().mockReturnValue('owner-x'),
        getServerUrl: vi.fn().mockReturnValue('https://other.example.test'),
      });
      useAuthStore.setState({
        getAllConnectedClients: () => new Map([['other-login', foreignClient]]),
      } as never);

      await useEmailStore.getState().renameMailbox(activeClient, sharedFolder.id, 'Renamed Shared');

      expect(foreignClient.updateMailbox).not.toHaveBeenCalled();
      expect(activeClient.updateMailbox).toHaveBeenCalledWith('shared-1', { name: 'Renamed Shared' }, 'owner-x');
    });

    it('recovers the owner and bare id from a namespaced id that is no longer in the store', async () => {
      // A concurrent refresh dropped the shared account while the rename prompt
      // was open: the store id is all we have left.
      useEmailStore.setState({ mailboxes: [inbox, sent, trash, custom] });
      const client = makeMockClient();

      await useEmailStore.getState().renameMailbox(client, 'owner-x:shared-1', 'Renamed Shared');

      expect(client.updateMailbox).toHaveBeenCalledWith('shared-1', { name: 'Renamed Shared' }, 'owner-x');
    });

    it('does not clear a personal role when the shared mailbox object is missing', async () => {
      const ownArchive = makeMailbox({ id: 'archive-a', name: 'Personal Archive', role: 'archive' });
      useEmailStore.setState({ mailboxes: [inbox, sent, trash, custom, ownArchive] });
      const client = makeMockClient();

      await useEmailStore.getState().setMailboxRole(client, 'owner-x:shared-1', 'archive');

      expect(client.updateMailbox).not.toHaveBeenCalledWith('archive-a', { role: null }, undefined);
      expect(client.updateMailbox).toHaveBeenCalledWith('shared-1', { role: 'archive' }, 'owner-x');
    });

    it('reorders shared folders with bare ids inside the owner account', async () => {
      const sharedSibling = makeMailbox({
        id: 'owner-x:shared-2',
        originalId: 'shared-2',
        name: 'Shared Sibling',
        accountId: 'owner-x',
        isShared: true,
      });
      useEmailStore.setState({
        mailboxes: [inbox, sent, trash, custom, sharedFolder, sharedSibling],
      });
      const client = makeMockClient();

      await useEmailStore.getState().reorderMailboxes(client, [sharedSibling.id, sharedFolder.id]);

      expect(client.updateMailbox).toHaveBeenNthCalledWith(1, 'shared-2', { sortOrder: 1 }, 'owner-x');
      expect(client.updateMailbox).toHaveBeenNthCalledWith(2, 'shared-1', { sortOrder: 2 }, 'owner-x');
    });
  });

  // Regression: a background fetchMailboxes (e.g. push-driven after deleting
  // drafts in "All Drafts") must not reset a virtual unified/cross-view selection
  // to the inbox, which would jump the user out of the view they're in.
  describe('fetchMailboxes selection preservation', () => {
    it('publishes the refreshed mailbox list to extensions', async () => {
      const observer = vi.fn();
      const disposable = emailHooks.onMailboxesRefresh.register('mailbox-refresh-test', observer);
      const refreshed = [inbox, sent, trash, custom];
      const client = makeMockClient({
        getAllMailboxes: vi.fn().mockResolvedValue(refreshed),
      });

      try {
        await useEmailStore.getState().fetchMailboxes(client);
        expect(observer).toHaveBeenCalledWith(refreshed);
      } finally {
        disposable.dispose();
      }
    });

    it('keeps a unified-view selection (e.g. All Drafts) on background refresh', async () => {
      useEmailStore.setState({
        mailboxes: [inbox, sent, trash, custom],
        selectedMailbox: UNIFIED_MAILBOX_IDS.drafts,
        isUnifiedView: true,
      });
      // Fresh list (not initial load) that does NOT contain the virtual id.
      const client = makeMockClient({
        getAllMailboxes: vi.fn().mockResolvedValue([inbox, sent, trash, custom]),
      });

      await useEmailStore.getState().fetchMailboxes(client);

      expect(useEmailStore.getState().selectedMailbox).toBe(UNIFIED_MAILBOX_IDS.drafts);
    });

    it('still falls back to inbox when a real selection no longer exists', async () => {
      useEmailStore.setState({
        mailboxes: [inbox, sent, trash, custom],
        selectedMailbox: 'custom-1',
        isUnifiedView: false,
      });
      // custom-1 is gone from the refreshed list.
      const client = makeMockClient({
        getAllMailboxes: vi.fn().mockResolvedValue([inbox, sent, trash]),
      });

      await useEmailStore.getState().fetchMailboxes(client);

      expect(useEmailStore.getState().selectedMailbox).toBe('inbox-1');
    });
  });
});
