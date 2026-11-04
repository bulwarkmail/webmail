import { render, screen, fireEvent } from '@testing-library/react';
import { beforeEach, describe, it, expect, vi } from 'vitest';
import type { Email, Mailbox } from '@/lib/jmap/types';
import { useEmailStore } from '@/stores/email-store';
import { DEFAULT_SEARCH_FILTERS } from '@/lib/jmap/search-utils';

vi.mock('@/components/plugins/plugin-slot', () => ({ PluginSlot: () => null }));
vi.mock('../rules-menu', () => ({ RulesContextSubMenu: () => null }));
vi.mock('@/hooks/use-copy-link', () => ({ useCopyLink: () => vi.fn() }));

const { EmailContextMenu } = await import('../email-context-menu');

// A search across folders keeps the open folder selected. Its hits from other
// folders can be moved into that folder (#1452); a message already in it can't.

function mailbox(id: string, extra: Partial<Mailbox> = {}): Mailbox {
  return {
    id, name: id, role: undefined, parentId: undefined, totalEmails: 0, unreadEmails: 0,
    myRights: { mayAddItems: true }, ...extra,
  } as unknown as Mailbox;
}

const mailboxes = [mailbox('inbox', { role: 'inbox', name: 'Inbox' }), mailbox('work', { name: 'Work' })];
const inWork = { id: 'e1', keywords: { $seen: true }, mailboxIds: { work: true } } as unknown as Email;
const inInbox = { id: 'e2', keywords: { $seen: true }, mailboxIds: { inbox: true } } as unknown as Email;

beforeEach(() => {
  useEmailStore.setState({
    mailboxes,
    accountMailboxes: {},
    viewingAccountId: null,
    selectedMailbox: 'inbox',
    selectedKeyword: null,
    isUnifiedView: false,
    crossView: null,
    isScheduledView: false,
    searchQuery: 'invoice',
    searchFilters: DEFAULT_SEARCH_FILTERS,
    searchMailboxId: '',
  });
});

function openMoveMenu(props: Partial<React.ComponentProps<typeof EmailContextMenu>>) {
  const result = render(
    <EmailContextMenu
      email={inWork}
      position={{ x: 0, y: 0 }}
      isOpen
      onClose={() => {}}
      menuRef={{ current: null }}
      mailboxes={mailboxes}
      selectedMailbox="inbox"
      onMoveToMailbox={vi.fn()}
      {...props}
    />,
  );
  fireEvent.mouseEnter(screen.getByTestId('ctx-move-to').parentElement!);
  return result;
}

describe('Move to the open folder from search results', () => {
  it('offers the open folder for a hit from another folder, and moves it there', () => {
    const onMoveToMailbox = vi.fn();
    openMoveMenu({ onMoveToMailbox });
    fireEvent.click(screen.getByTestId('move-to:inbox'));
    expect(onMoveToMailbox).toHaveBeenCalledWith('inbox');
  });

  it('shows the open folder greyed for a message already in it', () => {
    openMoveMenu({ email: inInbox });
    // Shown, as in the sidebar, but it can't be picked.
    expect(screen.getByTestId('move-to:inbox')).toBeDisabled();
    expect(screen.getByTestId('move-to:work')).not.toBeDisabled();
  });

  it('offers it for a selection when one of the messages is elsewhere', () => {
    const onBatchMoveToMailbox = vi.fn();
    openMoveMenu({ isMultiSelect: true, selectedCount: 2, batchEmails: [inInbox, inWork], onBatchMoveToMailbox });
    fireEvent.click(screen.getByTestId('move-to:inbox'));
    expect(onBatchMoveToMailbox).toHaveBeenCalledWith('inbox');
  });
});
