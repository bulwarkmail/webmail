import { render, screen, within } from '@testing-library/react';
import { fireEvent } from '@testing-library/dom';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { DirectoryPickerDialog } from '../directory-picker-dialog';
import { useContactStore, type DirectoryEntry, type DirectoryStatus } from '@/stores/contact-store';
import type { IJMAPClient } from '@/lib/jmap/client-interface';
import type { ContactCard } from '@/lib/jmap/types';

// next-intl is mocked globally in vitest.setup (t returns the key).

const client = { supportsPrincipals: () => true, getPrincipals: vi.fn() } as unknown as IJMAPClient;

function people(n: number): DirectoryEntry[] {
  return Array.from({ length: n }, (_, i) => {
    const num = String(i).padStart(3, '0');
    return { id: `p${num}`, name: `Person ${num}`, email: `person${num}@example.org`, type: 'individual' as const };
  });
}

function setDirectory(entries: DirectoryEntry[], status: DirectoryStatus) {
  useContactStore.setState({ directoryPrincipals: entries, directoryStatus: status, directoryLoaded: status === 'ready' });
}

function rows() {
  return within(screen.getByRole('list')).queryAllByRole('listitem');
}

describe('DirectoryPickerDialog', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // No contacts of the user's own: the picker opens on the directory.
    useContactStore.setState({ contacts: [] });
  });

  it('lists the directory before any search, one page at a time', () => {
    setDirectory(people(60), 'ready');
    render(<DirectoryPickerDialog client={client} onClose={vi.fn()} onAdd={vi.fn()} />);
    expect(rows()).toHaveLength(50);
    fireEvent.click(screen.getByLabelText('next_page'));
    expect(rows()).toHaveLength(10);
    expect(rows()[0]).toHaveTextContent('Person 050');
  });

  it('searches by name and address', () => {
    setDirectory([
      { name: 'Ana Silva', email: 'ana@example.org' },
      { name: 'Finance Department', email: 'finance@example.org', type: 'group' },
      { name: 'Marcos Souza', email: 'marcos@example.org' },
    ], 'ready');
    render(<DirectoryPickerDialog client={client} onClose={vi.fn()} onAdd={vi.fn()} />);
    fireEvent.change(screen.getByPlaceholderText('search_placeholder'), { target: { value: 'finance@' } });
    expect(rows()).toHaveLength(1);
    expect(rows()[0]).toHaveTextContent('Finance Department');
    fireEvent.change(screen.getByPlaceholderText('search_placeholder'), { target: { value: 'souza' } });
    expect(rows()[0]).toHaveTextContent('Marcos Souza');
  });

  it('adds the checked entries to the chosen field and closes', () => {
    setDirectory([
      { name: 'Marcos Souza', email: 'marcos@example.org' },
      { name: 'Ana Silva', email: 'ana@example.org' },
      { name: 'Finance Department', email: 'finance@example.org' },
    ], 'ready');
    const onAdd = vi.fn();
    const onClose = vi.fn();
    render(<DirectoryPickerDialog client={client} onClose={onClose} onAdd={onAdd} />);
    // Rows are sorted by name: Ana, Finance, Marcos. Clicking a row toggles it.
    fireEvent.click(rows()[0]);
    fireEvent.click(rows()[2]);
    expect(screen.getByText('add_cc')).not.toBeDisabled();
    fireEvent.click(screen.getByText('add_cc'));
    expect(onAdd).toHaveBeenCalledWith('cc', [
      expect.objectContaining({ email: 'marcos@example.org' }),
      expect.objectContaining({ email: 'ana@example.org' }),
    ]);
    expect(onAdd.mock.calls[0][1]).toHaveLength(2);
    expect(onClose).toHaveBeenCalled();
  });

  it('keeps the add buttons disabled until something is checked', () => {
    setDirectory(people(3), 'ready');
    render(<DirectoryPickerDialog client={client} onClose={vi.fn()} onAdd={vi.fn()} />);
    expect(screen.getByText('add_to')).toBeDisabled();
  });

  it.each([
    ['forbidden', 'forbidden_title'],
    ['error', 'error_title'],
    ['ready', 'empty_title'],
    ['unavailable', 'unavailable_title'],
  ] as const)('tells a %s directory apart from the others', (status, text) => {
    setDirectory([], status);
    render(<DirectoryPickerDialog client={client} onClose={vi.fn()} onAdd={vi.fn()} />);
    expect(screen.getByText(text)).toBeInTheDocument();
    for (const other of ['forbidden_title', 'error_title', 'empty_title', 'unavailable_title'].filter((t) => t !== text)) {
      expect(screen.queryByText(other)).not.toBeInTheDocument();
    }
  });

  it('keeps showing the last list when a refresh fails', () => {
    setDirectory(people(2), 'error');
    render(<DirectoryPickerDialog client={client} onClose={vi.fn()} onAdd={vi.fn()} />);
    expect(rows()).toHaveLength(2);
    expect(screen.getByRole('alert')).toHaveTextContent('refresh_failed');
  });

  // Stalwart 1.0 with directory queries off: the listing holds the principals
  // the user knows (their own, their groups), and nothing failed.
  it('says the directory is not browsable when it lists only the principals the user knows', () => {
    setDirectory(people(1), 'forbidden');
    render(<DirectoryPickerDialog client={client} onClose={vi.fn()} onAdd={vi.fn()} />);
    expect(rows()).toHaveLength(1);
    expect(screen.getByRole('status')).toHaveTextContent('forbidden_hint');
    expect(screen.queryByText('refresh_failed')).not.toBeInTheDocument();
  });
});

// compose-17: the picker listed only the server's directory, not the
// contacts the To field's suggestions offer.
describe('DirectoryPickerDialog with contacts', () => {
  function contact(id: string, name: string, ...emails: string[]): ContactCard {
    return {
      id, addressBookIds: { book: true },
      name: { full: name },
      emails: Object.fromEntries(emails.map((address, i) => [`e${i}`, { address }])),
    } as unknown as ContactCard;
  }

  beforeEach(() => {
    vi.clearAllMocks();
    setDirectory([{ name: 'Server Account', email: 'server@example.org' }], 'ready');
    useContactStore.setState({
      contacts: [
        contact('c1', 'Zoe Fischer', 'zoe@example.com', 'zoe.f@work.example'),
        contact('c2', 'Anna Becker', 'anna@example.com'),
        { id: 'g1', kind: 'group', name: { full: 'Team' } } as unknown as ContactCard,
      ],
    });
  });

  it('opens on the contacts, one row per address, without groups', () => {
    render(<DirectoryPickerDialog client={client} onClose={vi.fn()} onAdd={vi.fn()} />);

    expect(screen.getByRole('tab', { name: 'tab_contacts' })).toHaveAttribute('aria-selected', 'true');
    expect(rows().map((r) => r.textContent)).toEqual([
      expect.stringContaining('anna@example.com'),
      expect.stringContaining('zoe.f@work.example'),
      expect.stringContaining('zoe@example.com'),
    ]);
    expect(screen.queryByText('Server Account')).not.toBeInTheDocument();
  });

  it('searches the contacts', () => {
    render(<DirectoryPickerDialog client={client} onClose={vi.fn()} onAdd={vi.fn()} />);
    fireEvent.change(screen.getByPlaceholderText('search_placeholder'), { target: { value: 'anna' } });
    expect(rows()).toHaveLength(1);
    fireEvent.change(screen.getByPlaceholderText('search_placeholder'), { target: { value: 'nobody' } });
    expect(screen.getByText('contacts_no_match')).toBeInTheDocument();
  });

  it('adds what was checked on both tabs', () => {
    const onAdd = vi.fn();
    render(<DirectoryPickerDialog client={client} onClose={vi.fn()} onAdd={onAdd} />);
    fireEvent.click(rows()[0]);
    fireEvent.click(screen.getByRole('tab', { name: 'tab_directory' }));
    fireEvent.click(rows()[0]);
    fireEvent.click(screen.getByText('add_to'));

    expect(onAdd).toHaveBeenCalledWith('to', [
      expect.objectContaining({ name: 'Anna Becker', email: 'anna@example.com' }),
      expect.objectContaining({ email: 'server@example.org' }),
    ]);
  });

  it('shows the contacts alone where the server has no directory', () => {
    const noDirectory = { supportsPrincipals: () => false } as unknown as IJMAPClient;
    render(<DirectoryPickerDialog client={noDirectory} onClose={vi.fn()} onAdd={vi.fn()} />);
    expect(screen.queryByRole('tab')).not.toBeInTheDocument();
    expect(rows()).toHaveLength(3);
  });
});

