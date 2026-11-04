import { fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Email, Mailbox } from '@/lib/jmap/types';
import { rememberTrashOrigins } from '@/lib/trash-origin';

vi.mock('@/components/plugins/plugin-slot', () => ({ PluginSlot: () => null }));

import { EmailContextMenu } from '../email-context-menu';

// A row's right-click menu had 22 entries and was 640 px tall. It now has what
// people use from a row, as Outlook and Gmail have it, and the rest under
// "More actions". Spam's "Not spam" and Trash's "Restore" stay at the top.

const email = {
  id: 'e1',
  blobId: 'b1',
  threadId: 't1',
  mailboxIds: { inbox: true },
  keywords: { $seen: true },
  from: [{ name: 'Alice', email: 'alice@example.com' }],
  subject: 'Hello',
  receivedAt: '2026-01-01T00:00:00Z',
  hasAttachment: false,
  size: 100,
} as unknown as Email;

const mailboxes = [
  { id: 'inbox', name: 'Inbox', role: 'inbox', parentId: null, myRights: { mayAddItems: true } },
  { id: 'work', name: 'Work', role: null, parentId: null, myRights: { mayAddItems: true } },
  { id: 'junk', name: 'Spam', role: 'junk', parentId: null, myRights: { mayAddItems: true } },
  { id: 'trash', name: 'Trash', role: 'trash', parentId: null, myRights: { mayAddItems: true } },
] as unknown as Mailbox[];

type MenuProps = React.ComponentProps<typeof EmailContextMenu>;

function renderMenu(props: Partial<MenuProps> = {}) {
  const onClose = vi.fn();
  render(
    <EmailContextMenu
      rowMenu
      email={email}
      position={{ x: 10, y: 10 }}
      isOpen
      onClose={onClose}
      menuRef={{ current: null }}
      mailboxes={mailboxes}
      selectedMailbox="inbox"
      currentMailboxRole="inbox"
      onReply={vi.fn()}
      onReplyAll={vi.fn()}
      onForward={vi.fn()}
      onForwardAsAttachment={vi.fn()}
      onArchive={vi.fn()}
      onDelete={vi.fn()}
      onMarkAsRead={vi.fn()}
      onToggleStar={vi.fn()}
      onTogglePinned={vi.fn()}
      onSetTag={vi.fn()}
      onMoveToMailbox={vi.fn()}
      onMarkAsSpam={vi.fn()}
      onUndoSpam={vi.fn()}
      onOpenInWindow={vi.fn()}
      onExport={vi.fn()}
      onPrint={vi.fn()}
      onViewSource={vi.fn()}
      {...props}
    />,
  );
  return { onClose };
}

const topLevel = () => {
  const menu = screen.getAllByRole('menu')[0];
  return Array.from(menu.querySelectorAll<HTMLElement>(':scope > div > [role="menuitem"], :scope > div > div > [role="menuitem"]'))
    .map((row) => row.querySelector('[data-menu-label]')?.textContent ?? '');
};

afterEach(() => {
  localStorage.clear();
});

describe("a row's right-click menu", () => {
  it('has the usual few at the top and the rest under More actions', () => {
    renderMenu();
    const top = topLevel();
    expect(top).toEqual(expect.arrayContaining(['reply', 'reply_all', 'forward', 'archive', 'delete', 'move_to', 'mark_unread', 'star', 'tag', 'mark_as_spam', 'open_in_window', 'more_actions']));
    for (const label of ['forward_as_attachment', 'copy_message', 'pin', 'print', 'view_source', 'export_email', 'rules.title']) {
      expect(top).not.toContain(label);
    }
    fireEvent.click(screen.getByTestId('ctx-more'));
    const more = screen.getByRole('menu', { name: 'more_actions' });
    for (const id of ['ctx-print', 'ctx-view-source', 'ctx-export']) expect(within(more).getByTestId(id)).toBeTruthy();
    expect(within(more).getByText('forward_as_attachment')).toBeTruthy();
    expect(within(more).getByText('pin')).toBeTruthy();
  });

  it('shows Not spam at the top in Spam', () => {
    renderMenu({ selectedMailbox: 'junk', currentMailboxRole: 'junk', email: { ...email, mailboxIds: { junk: true } } as Email });
    expect(topLevel()).toContain('not_spam');
  });

  it('the reader\'s ⋮ keeps every entry at the top: it is the "more" already', () => {
    renderMenu({ rowMenu: false });
    expect(screen.queryByTestId('ctx-more')).toBeNull();
    expect(screen.getByTestId('ctx-print')).toBeTruthy();
  });
});

describe('Restore in Trash', () => {
  const trashed = { ...email, mailboxIds: { trash: true } } as Email;

  it('puts a message back in the folder it was deleted from', () => {
    rememberTrashOrigins([{ id: 'e1', mailboxIds: { work: true } }], mailboxes);
    const onMoveToMailbox = vi.fn();
    renderMenu({ email: trashed, selectedMailbox: 'trash', currentMailboxRole: 'trash', onMoveToMailbox });
    expect(topLevel()).toContain('restore');
    fireEvent.click(screen.getByTestId('ctx-restore'));
    expect(onMoveToMailbox).toHaveBeenCalledWith('work');
  });

  it('puts it in the Inbox when nothing says where it came from', () => {
    const onMoveToMailbox = vi.fn();
    renderMenu({ email: trashed, selectedMailbox: 'trash', currentMailboxRole: 'trash', onMoveToMailbox });
    fireEvent.click(screen.getByTestId('ctx-restore'));
    expect(onMoveToMailbox).toHaveBeenCalledWith('inbox');
  });

  // Pass 2, mail-9: Trash's Delete removes for good, so it says so, and
  // reporting spam from the bin makes no sense.
  it('says Delete forever and offers no Report spam', () => {
    renderMenu({ email: trashed, selectedMailbox: 'trash', currentMailboxRole: 'trash' });
    expect(screen.getByTestId('ctx-delete').textContent).toContain('delete_forever');
    expect(screen.queryByTestId('ctx-spam')).toBeNull();
    fireEvent.click(screen.getByTestId('ctx-more'));
    expect(screen.queryByTestId('ctx-spam')).toBeNull();
  });

  it('says Delete forever for a selection in Trash too', () => {
    renderMenu({
      email: trashed, selectedMailbox: 'trash', currentMailboxRole: 'trash', isMultiSelect: true, selectedCount: 2,
      batchEmails: [trashed, { ...trashed, id: 'e2' } as Email], onBatchDelete: vi.fn(), onBatchMarkAsSpam: vi.fn(),
    });
    expect(screen.getByTestId('ctx-delete').textContent).toContain('delete_forever');
    expect(screen.queryByTestId('ctx-spam')).toBeNull();
  });

  it('is in the selection menu too', () => {
    rememberTrashOrigins([{ id: 'e1', mailboxIds: { work: true } }, { id: 'e2', mailboxIds: { work: true } }], mailboxes);
    const onBatchMoveToMailbox = vi.fn();
    renderMenu({
      email: trashed, selectedMailbox: 'trash', currentMailboxRole: 'trash', isMultiSelect: true, selectedCount: 2,
      batchEmails: [trashed, { ...trashed, id: 'e2' } as Email], onBatchMoveToMailbox,
    });
    fireEvent.click(screen.getByTestId('ctx-restore'));
    expect(onBatchMoveToMailbox).toHaveBeenCalledWith('work');
  });
});

describe('Mark read and unread on a selection', () => {
  it('offers both when the selection has read and unread mail', () => {
    const onBatchMarkAsRead = vi.fn();
    renderMenu({
      isMultiSelect: true, selectedCount: 2, onBatchMarkAsRead,
      batchEmails: [email, { ...email, id: 'e2', keywords: {} } as Email],
    });
    expect(screen.getByTestId('ctx-mark-unread')).toBeTruthy();
    fireEvent.click(screen.getByTestId('ctx-mark-read'));
    expect(onBatchMarkAsRead).toHaveBeenCalledWith(true);
  });

  it('offers only Mark as unread when all are read', () => {
    renderMenu({ isMultiSelect: true, selectedCount: 2, onBatchMarkAsRead: vi.fn(), batchEmails: [email, { ...email, id: 'e2' } as Email] });
    expect(screen.queryByTestId('ctx-mark-read')).toBeNull();
    expect(screen.getByTestId('ctx-mark-unread')).toBeTruthy();
  });
});

