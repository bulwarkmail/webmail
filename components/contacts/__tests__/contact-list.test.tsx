import { render, screen, fireEvent, act } from '@testing-library/react';
import { describe, it, expect, vi, afterEach } from 'vitest';
import { ContactList } from '../contact-list';
import { exportContacts } from '../contact-export';
import { useSettingsStore } from '@/stores/settings-store';
import { useAuthStore } from '@/stores/auth-store';
import type { BlobBatch } from '@/lib/jmap/client-interface';
import type { ContactCard } from '@/lib/jmap/types';

function makeContact(overrides: Partial<ContactCard> & { id: string }): ContactCard {
  return {
    addressBookIds: {},
    ...overrides,
  };
}

const alice = makeContact({
  id: '1',
  name: { components: [{ kind: 'given', value: 'Alice' }, { kind: 'surname', value: 'Smith' }], isOrdered: true },
  emails: { e0: { address: 'alice@example.com' } },
});

const bob = makeContact({
  id: '2',
  name: { components: [{ kind: 'given', value: 'Bob' }, { kind: 'surname', value: 'Jones' }], isOrdered: true },
  emails: { e0: { address: 'bob@example.com' } },
});

const _group = makeContact({
  id: '3',
  kind: 'group',
  name: { components: [{ kind: 'given', value: 'Team' }], isOrdered: true },
  members: { '1': true },
});

const defaultProps = {
  contacts: [alice, bob],
  selectedContactId: null,
  searchQuery: '',
  onSearchChange: vi.fn(),
  onSelectContact: vi.fn(),
  onCreateNew: vi.fn(),
  selectedContactIds: new Set<string>(),
  onToggleSelection: vi.fn(),
  onSelectRangeContacts: vi.fn(),
  onSelectAll: vi.fn(),
  onClearSelection: vi.fn(),
  onBulkDelete: vi.fn(),
  onBulkAddToGroup: vi.fn(),
  onBulkExport: vi.fn(),
  onEditContact: vi.fn(),
  onDeleteContact: vi.fn(),
  onAddContactToGroup: vi.fn(),
};

describe('ContactList', () => {
  it('renders contact names', () => {
    render(<ContactList {...defaultProps} />);
    expect(screen.getByText('Alice Smith')).toBeInTheDocument();
    expect(screen.getByText('Bob Jones')).toBeInTheDocument();
  });

  it('filters contacts by search query', () => {
    render(<ContactList {...defaultProps} searchQuery="alice" />);
    expect(screen.getByText('Alice Smith')).toBeInTheDocument();
    expect(screen.queryByText('Bob Jones')).not.toBeInTheDocument();
  });

  it('shows empty state when no contacts match', () => {
    render(<ContactList {...defaultProps} contacts={[]} />);
    expect(screen.getByText('empty_state_title')).toBeInTheDocument();
  });

  it('shows placeholders instead of the empty state while contacts are loading', () => {
    render(<ContactList {...defaultProps} contacts={[]} isLoading />);
    expect(screen.queryByText('empty_state_title')).toBeNull();
    expect(screen.getByTestId('contact-list-skeleton')).toBeInTheDocument();
  });

  it('draws the loading rows at the list density, as the page skeleton does', () => {
    const avatars = () => [...screen.getByTestId('contact-list-skeleton').querySelectorAll('.rounded-full')];
    act(() => { useSettingsStore.setState({ density: 'extra-compact', groupContactsByLetter: false }); });
    const { unmount } = render(<ContactList {...defaultProps} contacts={[]} isLoading />);
    expect(avatars().length).toBeGreaterThan(0);
    expect(avatars().every((el) => el.classList.contains('hidden'))).toBe(true);
    unmount();

    act(() => { useSettingsStore.setState({ density: 'regular', groupContactsByLetter: true }); });
    render(<ContactList {...defaultProps} contacts={[]} isLoading />);
    expect(avatars().some((el) => el.classList.contains('hidden'))).toBe(false);
  });

  it('puts a banner at the top of the scrolling list, so its arrival moves nothing on screen', () => {
    const { rerender } = render(<ContactList {...defaultProps} contacts={[]} isLoading />);
    const scroller = screen.getByRole('listbox').parentElement!;
    rerender(<ContactList {...defaultProps} banner={<button type="button">Possible duplicates (1)</button>} />);
    // The same scroll area as with the loading rows, and the banner inside it.
    expect(screen.getByRole('listbox').parentElement).toBe(scroller);
    expect(scroller.firstElementChild).toBe(screen.getByRole('button', { name: 'Possible duplicates (1)' }));
  });

  it('shows the contacts as soon as they are there, even while loading', () => {
    render(<ContactList {...defaultProps} isLoading />);
    expect(screen.queryByTestId('contact-list-skeleton')).toBeNull();
  });

  it('shows search empty state when search has no results', () => {
    render(<ContactList {...defaultProps} searchQuery="zzz" />);
    expect(screen.getByText('empty_search')).toBeInTheDocument();
  });

  it('shows bulk action bar when contacts are selected', () => {
    render(<ContactList {...defaultProps} selectedContactIds={new Set(['1'])} />);
    expect(screen.getByText('bulk.delete')).toBeInTheDocument();
    expect(screen.getByText('bulk.export')).toBeInTheDocument();
  });

  it('shows the bulk export as busy and takes no click while a vCard export runs', async () => {
    // On Stalwart 1.0 the export first fetches every photo.
    let deliver!: (batch: BlobBatch) => void;
    useAuthStore.setState({
      client: {
        getContactsAccountId: () => 'a',
        getBlobsAsBase64: () => new Promise<BlobBatch>((resolve) => { deliver = resolve; }),
      } as never,
    });
    vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:vcf');
    vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {});
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});
    const onBulkExport = vi.fn();
    try {
      render(<ContactList {...defaultProps} onBulkExport={onBulkExport} selectedContactIds={new Set(['1'])} />);
      let running!: Promise<boolean>;
      act(() => { running = exportContacts([{ ...alice, media: { photo: { kind: 'photo', blobId: 'dbcX' } } }]); });

      const busy = screen.getByText('export.exporting').closest('button')!;
      expect(busy).toBeDisabled();
      fireEvent.click(busy);
      expect(onBulkExport).not.toHaveBeenCalled();

      await act(async () => {
        deliver({ data: new Map([['dbcX', '/9j/']]), failed: [] });
        await running;
      });
      expect(screen.getByText('bulk.export').closest('button')).not.toBeDisabled();
    } finally {
      useAuthStore.setState({ client: null });
      vi.restoreAllMocks();
    }
  });

  it.each([
    ['1.0', { kind: 'photo' as const, blobId: 'dbcX', mediaType: 'image/jpeg' }],
    ['0.16', { kind: 'photo' as const, uri: 'data:image/jpeg;base64,/9j/', mediaType: 'image/jpeg' }],
  ])('counts a Stalwart %s photo for the "has photo" filter', (_version, photo) => {
    const carla = makeContact({
      id: '5',
      name: { components: [{ kind: 'given', value: 'Carla' }, { kind: 'surname', value: 'Diaz' }], isOrdered: true },
      media: { photo },
    });
    render(<ContactList {...defaultProps} contacts={[alice, carla]} />);

    fireEvent.click(screen.getByLabelText('filters.toggle'));
    fireEvent.click(screen.getByText('filters.has_photo'));

    expect(screen.getByText('Carla Diaz')).toBeInTheDocument();
    expect(screen.queryByText('Alice Smith')).not.toBeInTheDocument();
  });

  describe('sort order (#963)', () => {
    const carol = makeContact({
      id: '4',
      name: { components: [{ kind: 'given', value: 'Carol' }, { kind: 'surname', value: 'Smith' }], isOrdered: true },
    });
    const family = [alice, bob, carol];
    const NAME = /^(Alice Smith|Bob Jones|Carol Smith)$/;
    const renderedNames = () => screen.getAllByText(NAME).map((el) => el.textContent);

    afterEach(() => {
      useSettingsStore.setState({ sortContactsByLastName: false, groupContactsByLetter: true });
    });

    it('sorts by display name by default', () => {
      render(<ContactList {...defaultProps} contacts={family} />);
      expect(renderedNames()).toEqual(['Alice Smith', 'Bob Jones', 'Carol Smith']);
      expect(screen.getByText('A')).toBeInTheDocument();
      expect(screen.getByText('B')).toBeInTheDocument();
      expect(screen.getByText('C')).toBeInTheDocument();
    });

    it('groups family members together when sorting by last name', () => {
      useSettingsStore.setState({ sortContactsByLastName: true });
      render(<ContactList {...defaultProps} contacts={family} />);
      expect(renderedNames()).toEqual(['Bob Jones', 'Alice Smith', 'Carol Smith']);
      // Letter headers follow the surname, not the given name.
      expect(screen.getByText('J')).toBeInTheDocument();
      expect(screen.getByText('S')).toBeInTheDocument();
      expect(screen.queryByText('A')).not.toBeInTheDocument();
    });

    it('still matches the search query against the display name', () => {
      useSettingsStore.setState({ sortContactsByLastName: true });
      render(<ContactList {...defaultProps} contacts={family} searchQuery="alice" />);
      expect(renderedNames()).toEqual(['Alice Smith']);
    });
  });


  it("writes to a contact from the right-click menu in the app's composer, not through mailto:", () => {
    const onComposeContact = vi.fn();
    const href = window.location.href;
    render(<ContactList {...defaultProps} onComposeContact={onComposeContact} />);
    fireEvent.contextMenu(screen.getByText('Alice Smith'));
    fireEvent.click(screen.getByText('context_menu.send_email'));
    expect(onComposeContact).toHaveBeenCalledWith(alice);
    expect(window.location.href).toBe(href);
  });

  it("moves a contact to another address book from its right-click menu, and the selection from the bulk bar", () => {
    const onMoveContacts = vi.fn();
    const { unmount } = render(<ContactList {...defaultProps} onMoveContacts={onMoveContacts} />);
    fireEvent.contextMenu(screen.getByText('Alice Smith'));
    fireEvent.click(screen.getByText('address_books.move_to'));
    expect(onMoveContacts).toHaveBeenCalledWith(['1']);
    unmount();

    render(<ContactList {...defaultProps} onMoveContacts={onMoveContacts} selectedContactIds={new Set(['1', '2'])} />);
    fireEvent.click(screen.getByRole('button', { name: /address_books.move_to/ }));
    expect(onMoveContacts).toHaveBeenLastCalledWith(['1', '2']);
  });

  it("moves through the list with the arrow keys and opens the contact, like Mail and Files", () => {
    const onSelectContact = vi.fn();
    render(<ContactList {...defaultProps} onSelectContact={onSelectContact} />);
    const rows = screen.getAllByRole('option');
    expect(rows[0]).toHaveAttribute('tabindex', '0');
    expect(rows[1]).toHaveAttribute('tabindex', '-1');
    rows[0].focus();
    fireEvent.keyDown(rows[0], { key: 'ArrowDown' });
    expect(onSelectContact).toHaveBeenLastCalledWith('2');
    expect(document.activeElement).toBe(screen.getAllByRole('option')[1]);
  });

  it("selects all with Ctrl+A, deletes with Delete, clears with Escape, and searches with /", () => {
    const onSelectAll = vi.fn();
    const onBulkDelete = vi.fn();
    const onClearSelection = vi.fn();
    const { rerender } = render(<ContactList {...defaultProps} onSelectAll={onSelectAll} onBulkDelete={onBulkDelete} onClearSelection={onClearSelection} />);
    const row = screen.getAllByRole('option')[0];
    fireEvent.keyDown(row, { key: 'a', code: 'KeyA', ctrlKey: true });
    expect(onSelectAll).toHaveBeenCalledWith(['1', '2']);

    rerender(<ContactList {...defaultProps} selectedContactIds={new Set(['1'])} onSelectAll={onSelectAll} onBulkDelete={onBulkDelete} onClearSelection={onClearSelection} />);
    fireEvent.keyDown(screen.getAllByRole('option')[0], { key: 'Delete' });
    expect(onBulkDelete).toHaveBeenCalled();
    fireEvent.keyDown(screen.getAllByRole('option')[0], { key: 'Escape' });
    expect(onClearSelection).toHaveBeenCalled();

    fireEvent.keyDown(document.body, { key: '/' });
    expect(document.activeElement).toBe(screen.getByPlaceholderText('search_placeholder'));
  });

  it("opens a contact's menu on long-press, with Select to start selecting", () => {
    vi.useFakeTimers();
    try {
      const onToggleSelection = vi.fn();
      render(<ContactList {...defaultProps} onToggleSelection={onToggleSelection} />);
      const row = screen.getAllByRole('option')[0];
      const touchStart = new Event('touchstart', { bubbles: true });
      Object.defineProperty(touchStart, 'touches', { value: [{ clientX: 5, clientY: 5 }] });
      act(() => { row.dispatchEvent(touchStart); });
      act(() => { vi.advanceTimersByTime(600); });
      fireEvent.click(screen.getByText('filters.select'));
      expect(onToggleSelection).toHaveBeenCalledWith('1');
    } finally {
      vi.useRealTimers();
    }
  });
});
