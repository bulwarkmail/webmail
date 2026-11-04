import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { ContactCard } from '@/lib/jmap/types';
import { ContactImportDialog } from '../contact-import-dialog';

// pim-p2-15 (2026-11-04): a CSV with the same address on two rows imported both,
// and the import ended in a dialog page that only had Close.

const CSV = [
  'First Name,Last Name,E-mail Address',
  'Anna,Schmidt,anna@example.org',
  'Bob,Meyer,bob@example.org',
  'Anna,Schmidt,ANNA@example.org',
  '',
].join('\r\n');

const file = () => new File([CSV], 'contacts-export.csv', { type: 'text/csv' });

describe('ContactImportDialog, pass 2', () => {
  it('marks the second row with the same address as a duplicate, and imports the rest', async () => {
    const onImport = vi.fn(async (cards: ContactCard[]) => cards.length);
    render(<ContactImportDialog existingContacts={[]} onImport={onImport} onClose={vi.fn()} initialFile={file()} />);
    fireEvent.click(await screen.findByRole('button', { name: 'continue' }));
    expect(await screen.findByText('Bob Meyer')).toBeInTheDocument();
    expect(screen.getAllByText('import.duplicate')).toHaveLength(1);
    fireEvent.click(screen.getByRole('button', { name: 'import.import_button' }));
    await waitFor(() => expect(onImport).toHaveBeenCalled());
    const cards = onImport.mock.calls[0][0] as ContactCard[];
    expect(cards.map((c) => Object.values(c.emails ?? {})[0]?.address)).toEqual(['anna@example.org', 'bob@example.org']);
  });

  it('closes when done and leaves the word to the caller', async () => {
    const onClose = vi.fn();
    const onImported = vi.fn();
    render(
      <ContactImportDialog existingContacts={[]} onImport={async (cards) => cards.length} onClose={onClose} onImported={onImported} initialFile={file()} />,
    );
    fireEvent.click(await screen.findByRole('button', { name: 'continue' }));
    await screen.findByText('Bob Meyer');
    fireEvent.click(screen.getByRole('button', { name: 'import.import_button' }));
    await waitFor(() => expect(onImported).toHaveBeenCalledWith(2, undefined));
    expect(onClose).toHaveBeenCalled();
    expect(screen.queryByText('import.success')).toBeNull();
  });
});
