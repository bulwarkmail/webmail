import { describe, it, expect, beforeEach, vi } from 'vitest';
import { useEmailStore } from '../email-store';
import type { Mailbox } from '@/lib/jmap/types';
import { UNIFIED_MAILBOX_IDS } from '@/lib/jmap/types';

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
    createMailbox: vi.fn().mockResolvedValue(makeMailbox({ id: 'mb-new' })),
    updateMailbox: vi.fn().mockResolvedValue(undefined),
    deleteMailbox: vi.fn().mockResolvedValue(undefined),
    getAllMailboxes: vi.fn().mockResolvedValue([]),
    ...overrides,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any;
}

describe('email-store folder management', () => {
  const inbox = makeMailbox({ id: 'inbox-1', name: 'Inbox', role: 'inbox' });
  const sent = makeMailbox({ id: 'sent-1', name: 'Sent', role: 'sent' });
  const trash = makeMailbox({ id: 'trash-1', name: 'Trash', role: 'trash' });
  const custom = makeMailbox({ id: 'custom-1', name: 'My Folder' });

  beforeEach(() => {
    useEmailStore.setState({
      mailboxes: [inbox, sent, trash, custom],
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

      expect(client.createMailbox).toHaveBeenCalledWith('New Folder', undefined);
      expect(client.getAllMailboxes).toHaveBeenCalled();
    });

    it('should call client.createMailbox with parentId', async () => {
      const client = makeMockClient({
        getAllMailboxes: vi.fn().mockResolvedValue(useEmailStore.getState().mailboxes),
      });

      await useEmailStore.getState().createMailbox(client, 'Sub Folder', 'inbox-1');

      expect(client.createMailbox).toHaveBeenCalledWith('Sub Folder', 'inbox-1');
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

      expect(client.updateMailbox).toHaveBeenCalledWith('custom-1', { name: 'Renamed' });
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

      expect(client.deleteMailbox).toHaveBeenCalledWith('custom-1');
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

      expect(client.updateMailbox).toHaveBeenCalledWith('custom-1', { role: 'archive' });
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
      expect(client.updateMailbox).toHaveBeenCalledWith('trash-1', { role: null });
      // Then set trash role on custom-1
      expect(client.updateMailbox).toHaveBeenCalledWith('custom-1', { role: 'trash' });
    });

    it('should clear role from a mailbox when role is null', async () => {
      const newMailboxes = useEmailStore.getState().mailboxes.map(mb =>
        mb.id === 'trash-1' ? { ...mb, role: undefined } : mb
      );
      const client = makeMockClient({
        getAllMailboxes: vi.fn().mockResolvedValue(newMailboxes),
      });

      await useEmailStore.getState().setMailboxRole(client, 'trash-1', null);

      expect(client.updateMailbox).toHaveBeenCalledWith('trash-1', { role: null });
    });

    it('should not clear role from same mailbox when re-assigning same role', async () => {
      const client = makeMockClient({
        getAllMailboxes: vi.fn().mockResolvedValue(useEmailStore.getState().mailboxes),
      });

      await useEmailStore.getState().setMailboxRole(client, 'trash-1', 'trash');

      // Should only call once (to set the role), not twice (no need to clear from same mailbox)
      expect(client.updateMailbox).toHaveBeenCalledTimes(1);
      expect(client.updateMailbox).toHaveBeenCalledWith('trash-1', { role: 'trash' });
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
      expect(client.updateMailbox).toHaveBeenCalledWith('trash-1', { role: null });
      expect(client.updateMailbox).toHaveBeenCalledWith('trash-2', { role: null });
      // Then set trash role on custom-1
      expect(client.updateMailbox).toHaveBeenCalledWith('custom-1', { role: 'trash' });
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

  // Regression: a background fetchMailboxes (e.g. push-driven after deleting
  // drafts in "All Drafts") must not reset a virtual unified/cross-view selection
  // to the inbox, which would jump the user out of the view they're in.
  describe('fetchMailboxes selection preservation', () => {
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
