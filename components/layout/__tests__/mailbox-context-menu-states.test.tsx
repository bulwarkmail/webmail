import { render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Mailbox } from '@/lib/jmap/types';

// A folder menu greys out what can't work: nothing to mark read, or no connection
// for what needs the server.

vi.mock('@/components/email/rules-menu', () => ({ FolderRulesSubMenu: () => null }));
vi.mock('@/lib/offline/availability', () => ({ offlineAllowed: () => true }));

const { MailboxContextMenu, unreadInTree } = await import('../mailbox-context-menu');
const { useOfflineStore } = await import('@/lib/offline/state');
const { useAuthStore } = await import('@/stores/auth-store');

const box = (id: string, unread: number, parentId: string | null = null) =>
  ({ id, name: id, parentId, sortOrder: 1, totalEmails: 5, unreadEmails: unread, myRights: {} }) as unknown as Mailbox;

function renderMenu(mailbox: Mailbox, mailboxes: Mailbox[], hasChildren = false) {
  render(
    <MailboxContextMenu
      target={{ kind: 'mailbox', mailbox, hasChildren }}
      position={{ x: 0, y: 0 }}
      isOpen
      onClose={vi.fn()}
      menuRef={{ current: null }}
      mailboxes={mailboxes}
      onMarkFolderRead={vi.fn()}
      onMarkFolderTreeRead={vi.fn()}
      onCreateSubfolder={vi.fn()}
      onRenameFolder={vi.fn()}
      onDeleteFolder={vi.fn()}
      onEmptyFolder={vi.fn()}
      onImportEmail={vi.fn()}
      onRefresh={vi.fn()}
    />,
  );
}

const item = (name: string) => screen.getByRole('menuitem', { name }) as HTMLButtonElement;

describe('folder menu states', () => {
  afterEach(() => {
    useOfflineStore.setState({ browserOffline: false, downServers: [], enabled: [] });
  });

  it('greys out Mark folder as read when nothing in it is unread', () => {
    const read = box('read', 0);
    renderMenu(read, [read]);
    expect(item('mark_folder_read').disabled).toBe(true);
  });

  it('keeps it for a folder with unread mail, and the tree entry for unread mail below', () => {
    const parent = box('parent', 0);
    const child = box('child', 3, 'parent');
    renderMenu(parent, [parent, child], true);
    expect(item('mark_folder_read').disabled).toBe(true);
    expect(item('mark_folder_tree_read').disabled).toBe(false);
    expect(unreadInTree(parent, [parent, child])).toBe(3);
  });

  it('offline, greys out what needs the server and says why', () => {
    useOfflineStore.setState({ browserOffline: true });
    const folder = box('f', 2);
    renderMenu(folder, [folder]);
    expect(screen.getByText('offline_header')).toBeInTheDocument();
    for (const name of ['new_subfolder', 'rename', 'menu_import', 'refresh', 'delete_folder']) {
      expect(item(name).disabled).toBe(true);
    }
    // No mail kept on this device: marking read would fail too.
    expect(item('mark_folder_read').disabled).toBe(true);
  });

  it('offline with the mail kept on this device, marking read still works', () => {
    useAuthStore.setState({ activeAccountId: 'acc' } as never);
    useOfflineStore.setState({ browserOffline: true, enabled: ['acc'] });
    const folder = box('f', 2);
    renderMenu(folder, [folder]);
    expect(item('mark_folder_read').disabled).toBe(false);
    expect(item('rename').disabled).toBe(true);
  });
});
