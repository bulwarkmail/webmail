import { act, render, screen, within } from '@testing-library/react';
import { fireEvent } from '@testing-library/dom';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ContactsSidebar } from '../contacts-sidebar';
import type { AddressBook, ContactCard } from '@/lib/jmap/types';

// next-intl + next/navigation are mocked globally in vitest.setup (t returns the key).
vi.mock('@/stores/account-store', () => {
  const state = { accounts: [], activeAccountId: null };
  const hook = (sel?: (s: typeof state) => unknown) =>
    typeof sel === 'function' ? sel(state) : state;
  hook.getState = () => state;
  return { useAccountStore: hook };
});

const group = {
  id: 'g1',
  kind: 'group',
  name: { full: 'Team' },
  members: { '1': true },
} as unknown as ContactCard;

function renderSidebar(onComposeGroup = vi.fn()) {
  render(
    <ContactsSidebar
      groups={[group]}
      individuals={[]}
      addressBooks={[]}
      activeCategory="all"
      onSelectCategory={vi.fn()}
      onCreateGroup={vi.fn()}
      onCreateContact={vi.fn()}
      onEditGroup={vi.fn()}
      onDeleteGroup={vi.fn()}
      onComposeGroup={onComposeGroup}
    />,
  );
  return onComposeGroup;
}

// First in the file: React warns about an unknown DOM prop only once per run.
describe('ContactsSidebar — row props', () => {
  it('keeps the long-press state off the row element', () => {
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      renderSidebar();
      const unknownProp = errors.mock.calls.some((args) => args.some((a) => String(a).includes('isPressed')));
      expect(unknownProp).toBe(false);
    } finally {
      errors.mockRestore();
    }
  });
});

describe('ContactsSidebar — compose to group', () => {
  beforeEach(() => vi.clearAllMocks());

  it('shows a "Send email to group" submenu in the group context menu', () => {
    renderSidebar();
    fireEvent.contextMenu(screen.getByText('Team'));
    expect(screen.getByText('groups.send_email')).toBeInTheDocument();
    // and the existing Edit/Delete entries still render, Delete named as in the group's own ⋮
    expect(screen.getByText('groups.edit')).toBeInTheDocument();
    expect(screen.getByText('groups.delete')).toBeInTheDocument();
  });

  it('calls onComposeGroup(groupId, field) when a To/Cc/Bcc item is clicked', () => {
    const onComposeGroup = renderSidebar();
    fireEvent.contextMenu(screen.getByText('Team'));

    // Open the submenu (hover) then click "Cc".
    const trigger = screen.getByText('groups.send_email').closest('.relative')!;
    fireEvent.mouseOver(trigger);
    fireEvent.mouseEnter(trigger);

    fireEvent.click(screen.getByText('groups.send_email_cc'));
    expect(onComposeGroup).toHaveBeenCalledWith('g1', 'cc');
  });
});

const books: AddressBook[] = [
  { id: 'ab-1', name: 'Personal', isDefault: true },
  { id: 'ab-2', name: 'Work' },
  { id: 'ab-3', name: 'Team', isShared: true, accountId: 'account-2', accountName: 'Team account' },
];

function renderBooksSidebar(onSetDefaultAddressBook = vi.fn()) {
  render(
    <ContactsSidebar
      groups={[]}
      individuals={[]}
      addressBooks={books}
      activeCategory="all"
      onSelectCategory={vi.fn()}
      onCreateGroup={vi.fn()}
      onCreateContact={vi.fn()}
      onSetDefaultAddressBook={onSetDefaultAddressBook}
    />,
  );
  return onSetDefaultAddressBook;
}

describe('ContactsSidebar - set default address book', () => {
  beforeEach(() => vi.clearAllMocks());

  it('offers "Set as default" for an owned, non-default book', () => {
    const onSetDefaultAddressBook = renderBooksSidebar();
    fireEvent.contextMenu(screen.getByText('Work'));

    fireEvent.click(screen.getByText('address_books.set_default'));
    expect(onSetDefaultAddressBook).toHaveBeenCalledWith(expect.objectContaining({ id: 'ab-2' }));
  });

  it('hides it for the book that is already the default', () => {
    renderBooksSidebar();
    fireEvent.contextMenu(screen.getByText('Personal'));

    expect(screen.queryByText('address_books.set_default')).not.toBeInTheDocument();
  });

  it('hides it for a book shared from another account', () => {
    renderBooksSidebar();
    fireEvent.contextMenu(screen.getByText('Team'));

    expect(screen.queryByText('address_books.set_default')).not.toBeInTheDocument();
  });
});

describe('ContactsSidebar — row menus without a right-click', () => {
  const carol = {
    id: 'c1',
    addressBookIds: {},
    name: { full: 'Carol' },
    keywords: { Friends: true },
  } as unknown as ContactCard;

  function renderRows(onDeleteKeyword = vi.fn(), onRenameKeyword = vi.fn()) {
    render(
      <ContactsSidebar
        groups={[group]}
        individuals={[carol]}
        addressBooks={[]}
        activeCategory="all"
        onSelectCategory={vi.fn()}
        onCreateGroup={vi.fn()}
        onCreateContact={vi.fn()}
        onEditGroup={vi.fn()}
        onDeleteGroup={vi.fn()}
        onRenameKeyword={onRenameKeyword}
        onDeleteKeyword={onDeleteKeyword}
      />,
    );
    return { onDeleteKeyword, onRenameKeyword };
  }

  it('opens a category menu from its ⋮, with Delete category', () => {
    const { onDeleteKeyword } = renderRows();
    const row = screen.getByText('Friends').closest('div')!;
    fireEvent.click(within(row).getByRole('button', { name: 'row_actions' }));
    expect(screen.getByText('rename_category')).toBeInTheDocument();
    fireEvent.click(screen.getByText('delete_category'));
    expect(onDeleteKeyword).toHaveBeenCalledWith('Friends');
  });

  it('opens a group menu on long-press', () => {
    vi.useFakeTimers();
    try {
      renderRows();
      const row = screen.getByText('Team').closest('div')!;
      const touchStart = new Event('touchstart', { bubbles: true });
      Object.defineProperty(touchStart, 'touches', { value: [{ clientX: 5, clientY: 5 }] });
      act(() => { row.dispatchEvent(touchStart); });
      act(() => { vi.advanceTimersByTime(600); });
      expect(screen.getByText('groups.edit')).toBeInTheDocument();
    } finally {
      vi.useRealTimers();
    }
  });
});

// iOS writes an empty CATEGORIES: line, which the server keeps as "": true.
describe('ContactsSidebar — blank categories', () => {
  it('lists no blank category and counts such a card as uncategorized', () => {
    const blankOnly = { id: 'b1', addressBookIds: {}, name: { full: 'Ann' }, keywords: { '': true } } as unknown as ContactCard;
    const withFriends = { id: 'b2', addressBookIds: {}, name: { full: 'Ben' }, keywords: { ' ': true, Friends: true } } as unknown as ContactCard;
    render(
      <ContactsSidebar
        groups={[]}
        individuals={[blankOnly, withFriends]}
        addressBooks={[]}
        activeCategory="all"
        onSelectCategory={vi.fn()}
        onCreateGroup={vi.fn()}
        onCreateContact={vi.fn()}
        onEditGroup={vi.fn()}
        onDeleteGroup={vi.fn()}
      />,
    );
    const noCategory = screen.getByText('no_category').closest('button')!;
    expect(noCategory).toHaveTextContent('1');
    // The section holds its header, "No category" and one row per category.
    const section = noCategory.parentElement!;
    expect(section.children).toHaveLength(3);
    expect(within(section).getByText('Friends')).toBeInTheDocument();
  });
});
