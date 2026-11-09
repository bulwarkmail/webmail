import { cleanup, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { Mailbox } from '@/lib/jmap/types';

// Usability test 2026-11-04, mail-20 and pass 2 p2-14: Trash and Spam
// showed Rename and Delete folder greyed out, "Empty folder" instead of
// "Empty Trash", and Rules and Mute notifications; every folder, the Inbox
// included, offered "Empty folder".

vi.mock('@/components/email/rules-menu', () => ({ FolderRulesSubMenu: () => <div role="menuitem">rules</div> }));

const { MailboxContextMenu } = await import('../mailbox-context-menu');

const box = (id: string, role: string | null) =>
  ({ id, name: id, role, parentId: null, sortOrder: 1, totalEmails: 5, unreadEmails: 0, myRights: {} }) as unknown as Mailbox;

function labels(mailbox: Mailbox) {
  render(
    <MailboxContextMenu
      target={{ kind: 'mailbox', mailbox, hasChildren: false }}
      position={{ x: 0, y: 0 }}
      isOpen
      onClose={vi.fn()}
      menuRef={{ current: null }}
      mailboxes={[mailbox]}
      onMarkFolderRead={vi.fn()}
      onCreateSubfolder={vi.fn()}
      onRenameFolder={vi.fn()}
      onDeleteFolder={vi.fn()}
      onEmptyFolder={vi.fn()}
      onImportEmail={vi.fn()}
      onRefresh={vi.fn()}
      notifications={{
        isMailboxMuted: () => false,
        isAccountMuted: () => false,
        hasFolderSettings: () => false,
        setMailboxMuted: vi.fn(),
        setAccountMuted: vi.fn(),
        resetFolderSettings: vi.fn(),
      }}
    />,
  );
  return screen.getAllByRole('menuitem').map((item) => item.textContent);
}

describe('folder menu of Trash and Spam', () => {
  it('Trash: Empty Trash last, no rename, delete, rules or mute', () => {
    const items = labels(box('trash', 'trash'));
    expect(items[items.length - 1]).toBe('empty_trash');
    for (const gone of ['rename', 'delete_folder', 'rules', 'mute_notifications', 'empty_folder', 'empty_folder_generic']) {
      expect(items).not.toContain(gone);
    }
  });

  it('Spam: Empty Spam last, no rename, delete, rules or mute', () => {
    const items = labels(box('junk', 'junk'));
    expect(items[items.length - 1]).toBe('empty_spam');
    for (const gone of ['rename', 'delete_folder', 'rules', 'mute_notifications']) expect(items).not.toContain(gone);
  });

  it('Inbox: no Empty, no rename or delete, but rules and mute', () => {
    const items = labels(box('inbox', 'inbox'));
    for (const gone of ['empty_folder', 'empty_folder_generic', 'empty_trash', 'empty_spam', 'rename', 'delete_folder']) {
      expect(items).not.toContain(gone);
    }
    expect(items).toContain('rules');
    expect(items).toContain('mute_notifications');
  });

  it('a folder of your own: rename and delete, no Empty', () => {
    const items = labels(box('family', null));
    expect(items).toContain('rename');
    expect(items[items.length - 1]).toBe('delete_folder');
    for (const gone of ['empty_folder', 'empty_folder_generic', 'empty_trash', 'empty_spam']) expect(items).not.toContain(gone);
  });
});

// mail-p3-12: Sent offered Rules and Mute notifications, though nothing
// arrives there; Trash and Spam offered New subfolder… and Import mail….
describe('folder menus offer only what applies', () => {
  it('Sent and Drafts: no rules, no mute', () => {
    for (const role of ['sent', 'drafts']) {
      const items = labels(box(role, role));
      expect(items).not.toContain('rules');
      expect(items).not.toContain('mute_notifications');
      expect(items).toContain('new_subfolder');
      cleanup();
    }
  });

  it('Trash and Spam: no New subfolder, no Import', () => {
    for (const role of ['trash', 'junk']) {
      const items = labels(box(role, role));
      expect(items).not.toContain('new_subfolder');
      expect(items).not.toContain('menu_import');
      cleanup();
    }
  });

  it('a folder of your own keeps all of them', () => {
    const items = labels(box('family', null));
    for (const kept of ['new_subfolder', 'menu_import', 'rules', 'mute_notifications']) expect(items).toContain(kept);
  });
});
