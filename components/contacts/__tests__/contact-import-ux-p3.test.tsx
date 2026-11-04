import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { AddressBook, ContactCard } from '@/lib/jmap/types';
import { ContactImportDialog } from '../contact-import-dialog';

// pim-p3-15: "Import into" offered the hidden Trusted Senders book, and a file
// whose every row was already in Contacts had nothing to do but Cancel.

const CSV = [
  'First Name,Last Name,E-mail Address,Mobile Phone',
  'Anna,Schmidt,anna@example.org,+49 170 1234567',
  '',
].join('\r\n');
const file = () => new File([CSV], 'contacts-export.csv', { type: 'text/csv' });

const anna: ContactCard = {
  id: 'c-anna',
  addressBookIds: { b1: true },
  name: { components: [{ kind: 'given', value: 'Anna' }, { kind: 'surname', value: 'Schmidt' }], isOrdered: true },
  emails: { e0: { address: 'anna@example.org' } },
};

const books = [
  { id: 'b1', name: 'Personal', isDefault: true },
  { id: 'b2', name: 'Work' },
  { id: 'b3', name: 'Trusted Senders' },
] as unknown as AddressBook[];

describe('ContactImportDialog, pass 3 (pim-p3-15)', () => {
  it('leaves the Trusted Senders book out of "Import into"', async () => {
    render(<ContactImportDialog existingContacts={[]} onImport={async (c) => c.length} onClose={vi.fn()} initialFile={file()} addressBooks={books} />);
    fireEvent.click(await screen.findByRole('button', { name: 'continue' }));
    await screen.findByText('Anna Schmidt');
    const options = screen.getAllByRole('option').map((o) => o.textContent);
    expect(options).toEqual(expect.arrayContaining(['Personal', 'Work']));
    expect(options).not.toContain('Trusted Senders');
  });

  it('offers to update the contact a row matches instead of skipping it', async () => {
    const onImport = vi.fn(async (cards: ContactCard[]) => cards.length);
    const onUpdateExisting = vi.fn(async (pairs: Array<{ existingId: string; card: ContactCard }>) => pairs.length);
    const onImported = vi.fn();
    render(
      <ContactImportDialog
        existingContacts={[anna]} onImport={onImport} onClose={vi.fn()} initialFile={file()}
        onImported={onImported} onUpdateExisting={onUpdateExisting}
      />,
    );
    fireEvent.click(await screen.findByRole('button', { name: 'continue' }));
    await screen.findByText('Anna Schmidt');
    // Every row is a duplicate: nothing is ticked yet.
    expect(screen.getByRole('button', { name: 'import.import_button' })).toBeDisabled();

    fireEvent.click(screen.getByRole('radio', { name: 'dupes_update' }));
    expect(screen.getByText('dupes_updates')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'import.import_button' }));
    await waitFor(() => expect(onImported).toHaveBeenCalledWith(1, undefined));
    expect(onImport).not.toHaveBeenCalled();
    expect(onUpdateExisting).toHaveBeenCalledWith([expect.objectContaining({ existingId: 'c-anna' })]);
    const card = onUpdateExisting.mock.calls[0][0][0].card;
    expect(Object.values(card.phones ?? {})[0]?.number).toBe('+49 170 1234567');
  });
});
