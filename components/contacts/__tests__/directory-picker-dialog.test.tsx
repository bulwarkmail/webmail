import { render, screen, within } from '@testing-library/react';
import { fireEvent } from '@testing-library/dom';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { DirectoryPickerDialog } from '../directory-picker-dialog';
import { useContactStore, type DirectoryEntry, type DirectoryStatus } from '@/stores/contact-store';
import type { IJMAPClient } from '@/lib/jmap/client-interface';

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
  beforeEach(() => vi.clearAllMocks());

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
