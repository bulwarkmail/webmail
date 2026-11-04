import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { Mailbox } from '@/lib/jmap/types';

// Usability test 2026-11-04, mail-14: the Trash folder's menu was headed
// "Deleted Items", the server's name, while the sidebar says Trash.

vi.mock('@/components/email/rules-menu', () => ({ FolderRulesSubMenu: () => null }));

const { MailboxContextMenu } = await import('../mailbox-context-menu');

const box = (id: string, name: string, role: string | null, parentId: string | null = null) =>
  ({ id, name, role, parentId, sortOrder: 1, totalEmails: 2, unreadEmails: 0, myRights: {} }) as unknown as Mailbox;

function open(mailbox: Mailbox, mailboxes: Mailbox[]) {
  render(
    <MailboxContextMenu
      target={{ kind: 'mailbox', mailbox, hasChildren: false }}
      position={{ x: 0, y: 0 }}
      isOpen
      onClose={vi.fn()}
      menuRef={{ current: null }}
      mailboxes={mailboxes}
    />,
  );
}

describe('MailboxContextMenu header', () => {
  it('names a system folder the way the sidebar does', () => {
    const trash = box('trash', 'Deleted Items', 'trash');
    open(trash, [trash]);
    expect(screen.getByTitle('mailboxes.trash')).toBeTruthy();
    expect(screen.queryByText('Deleted Items')).toBeNull();
  });

  it('keeps the path of a folder of your own', () => {
    const parent = box('p', 'Projects', null);
    const child = box('c', 'Alpha', null, 'p');
    open(child, [parent, child]);
    expect(screen.getByTitle('Projects › Alpha')).toBeTruthy();
  });
});
