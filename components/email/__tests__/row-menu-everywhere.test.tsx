import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Email, Mailbox } from '@/lib/jmap/types';

vi.mock('@/components/plugins/plugin-slot', () => ({ PluginSlot: () => null }));
vi.mock('@/hooks/use-copy-link', () => ({ useCopyLink: () => vi.fn() }));
// Rules needs a Sieve account; its entry stands in here.
vi.mock('../rules-menu', () => ({
  RulesContextSubMenu: () => <div role="menuitem" data-testid="ctx-rules"><span data-menu-label="">rules.title</span></div>,
}));

import { EmailContextMenu } from '../email-context-menu';

// The message's right-click menu is short everywhere: the browser and the desktop app
// show the same HTML menu (the desktop app had a native copy, without icons and with
// Chromium's key names), and the rarely used entries are under More actions. A
// selection gets the same structure without what needs one message.

const email = {
  id: 'e1', blobId: 'b1', threadId: 't1', mailboxIds: { inbox: true }, keywords: { $seen: true },
  from: [{ name: 'Alice', email: 'alice@example.com' }], subject: 'Hello', receivedAt: '2026-01-01T00:00:00Z',
  hasAttachment: false, size: 100,
} as unknown as Email;
const other = { ...email, id: 'e2', keywords: {} } as unknown as Email;

const mailboxes = [
  { id: 'inbox', name: 'Inbox', role: 'inbox', parentId: null, myRights: { mayAddItems: true } },
  { id: 'work', name: 'Work', role: null, parentId: null, myRights: { mayAddItems: true } },
] as unknown as Mailbox[];

type MenuProps = React.ComponentProps<typeof EmailContextMenu>;

function renderMenu(props: Partial<MenuProps> = {}) {
  return render(
    <EmailContextMenu
      rowMenu
      email={email}
      position={{ x: 10, y: 10 }}
      isOpen
      onClose={vi.fn()}
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
      onOpenInWindow={vi.fn()}
      onExport={vi.fn()}
      onPrint={vi.fn()}
      onViewSource={vi.fn()}
      onBatchArchive={vi.fn()}
      onBatchDelete={vi.fn()}
      onBatchMarkAsRead={vi.fn()}
      onBatchSetStarred={vi.fn()}
      onBatchToggleTag={vi.fn()}
      onBatchMoveToMailbox={vi.fn()}
      onBatchMarkAsSpam={vi.fn()}
      onBatchForwardAsAttachment={vi.fn()}
      {...props}
    />,
  );
}

/** The labels of a menu's own rows, not those of its submenus. */
function labels(menu: HTMLElement): string[] {
  return Array.from(menu.querySelectorAll<HTMLElement>('[role="menuitem"]'))
    .filter((row) => row.parentElement?.closest('[role="menu"]') === menu)
    .map((row) => row.querySelector('[data-menu-label]')?.textContent ?? '');
}

const ROW_TOP = ['reply', 'reply_all', 'forward', 'archive', 'delete', 'move_to', 'mark_unread', 'star', 'tag', 'mark_as_spam', 'open_in_window', 'more_actions'];

afterEach(() => {
  window.bulwarkDesktop = undefined;
  localStorage.clear();
});

describe("a message row's right-click menu", () => {
  it('has the short list at the top in the browser', () => {
    renderMenu();
    expect(labels(screen.getAllByRole('menu')[0])).toEqual(ROW_TOP);
  });

  it('is the same HTML menu in the desktop app, on screen, with no native copy', async () => {
    const popup = vi.fn(async () => null);
    window.bulwarkDesktop = { version: 1, platform: 'win32', menu: { setState: () => {}, popup } } as never;
    renderMenu();
    const menu = screen.getAllByRole('menu')[0];
    await waitFor(() => expect(menu.style.visibility).toBe('visible'));
    expect(labels(menu)).toEqual(ROW_TOP);
    // Icons on the rows, as in the browser.
    expect(within(menu).getByTestId('ctx-delete').querySelector('svg')).not.toBeNull();
    expect(popup).not.toHaveBeenCalled();
  });

  it('keeps the rest under More actions, in the order asked for', () => {
    renderMenu();
    fireEvent.click(screen.getByTestId('ctx-more'));
    expect(labels(screen.getByRole('menu', { name: 'more_actions' }))).toEqual([
      'forward_as_attachment', 'copy_message', 'copy_conversation', 'rules.title', 'pin', 'export_email', 'print', 'view_source',
    ]);
  });
});

describe("a selection's right-click menu", () => {
  const selection = { isMultiSelect: true, selectedCount: 2, batchEmails: [email, other] };

  it('has the same structure, without what needs one message', () => {
    renderMenu(selection);
    const top = labels(screen.getAllByRole('menu')[0]);
    expect(top).toEqual(['archive', 'delete', 'move_to', 'mark_read', 'mark_unread', 'star', 'tag', 'mark_as_spam', 'more_actions']);
    for (const single of ['reply', 'reply_all', 'forward', 'open_in_window']) expect(top).not.toContain(single);
    fireEvent.click(screen.getByTestId('ctx-more'));
    expect(labels(screen.getByRole('menu', { name: 'more_actions' }))).toEqual(['forward_as_attachments', 'rules.title']);
  });

  it('stars the whole selection', () => {
    const onBatchSetStarred = vi.fn();
    renderMenu({ ...selection, onBatchSetStarred });
    fireEvent.click(screen.getByTestId('ctx-star'));
    expect(onBatchSetStarred).toHaveBeenCalledWith(true);
  });

  it('only More actions, for the selection view\'s button', () => {
    renderMenu({ ...selection, section: 'more' });
    expect(labels(screen.getAllByRole('menu')[0])).toEqual(['forward_as_attachments', 'rules.title']);
  });
});
