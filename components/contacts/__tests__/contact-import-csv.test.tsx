import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { AddressBook, ContactCard } from '@/lib/jmap/types';
import { ContactImportDialog } from '../contact-import-dialog';

// pim-11: a CSV from Outlook or Google goes through a column step, then the
// usual preview with the duplicate check, into the address book chosen.

const OUTLOOK_DE = [
  '"Vorname";"Nachname";"Firma";"E-Mail-Adresse";"E-Mail-Typ";"Mobiltelefon";"Privat"',
  '"Jürgen";"Beispiel";"Muster GmbH";"juergen@example.de";"SMTP";"+49 170 1111111";"Aus"',
  '"Ada";"Lovelace";"";"ada@example.org";"SMTP";"";"Aus"',
  '',
].join('\r\n');

/** German Outlook's bytes: Windows-1252, so "ü" is one byte. */
function cp1252File(text: string, name = 'kontakte.csv'): File {
  const bytes = Uint8Array.from([...text].map((ch) => ch.charCodeAt(0)));
  return new File([bytes], name, { type: 'text/csv' });
}

const books = [
  { id: 'b-personal', name: 'Personal', isDefault: true },
  { id: 'b-work', name: 'Work' },
] as AddressBook[];

const existing: ContactCard[] = [{ id: 'x', addressBookIds: {}, emails: { e: { address: 'ada@example.org' } } }];

describe('ContactImportDialog with a CSV file', () => {
  it('asks for the columns, then previews the cards and imports them into the book chosen', async () => {
    const onImport = vi.fn(async (cards: ContactCard[]) => cards.length);
    render(
      <ContactImportDialog
        existingContacts={existing}
        onImport={onImport}
        onClose={vi.fn()}
        initialFile={cp1252File(OUTLOOK_DE)}
        addressBooks={books}
        defaultAddressBookId="b-work"
      />,
    );

    const table = await screen.findByTestId('csv-columns');
    // Each column with an example and a field: known ones matched, the rest left out.
    expect(within(table).getByText('Jürgen')).toBeInTheDocument();
    expect(within(table).getByRole('combobox', { name: 'Vorname' })).toHaveValue('name.given');
    expect(within(table).getByRole('combobox', { name: 'E-Mail-Adresse' })).toHaveValue('email');
    expect(within(table).getByRole('combobox', { name: 'E-Mail-Typ' })).toHaveValue('skip');
    expect(within(table).getByRole('combobox', { name: 'Privat' })).toHaveValue('skip');
    // The user leaves out the company.
    fireEvent.change(within(table).getByRole('combobox', { name: 'Firma' }), { target: { value: 'skip' } });
    fireEvent.click(screen.getByRole('button', { name: 'continue' }));

    expect(await screen.findByText('Jürgen Beispiel')).toBeInTheDocument();
    // The existing address is marked as a duplicate and not ticked.
    expect(screen.getByText('import.duplicate')).toBeInTheDocument();
    expect(screen.getByRole('combobox')).toHaveValue('b-work');
    fireEvent.change(screen.getByRole('combobox'), { target: { value: 'b-personal' } });
    fireEvent.click(screen.getByRole('button', { name: 'import.import_button' }));

    await waitFor(() => expect(onImport).toHaveBeenCalled());
    const [cards, bookId] = onImport.mock.calls[0] as unknown as [ContactCard[], string];
    expect(bookId).toBe('b-personal');
    expect(cards).toHaveLength(1);
    expect(cards[0].name?.components).toEqual([{ kind: 'given', value: 'Jürgen' }, { kind: 'surname', value: 'Beispiel' }]);
    expect(Object.values(cards[0].phones ?? {})).toEqual([{ number: '+49 170 1111111', features: { mobile: true } }]);
    expect(cards[0].organizations).toBeUndefined();
  });

  it('goes back from the preview to the columns', async () => {
    render(<ContactImportDialog existingContacts={[]} onImport={vi.fn()} onClose={vi.fn()} initialFile={cp1252File(OUTLOOK_DE)} />);
    await screen.findByTestId('csv-columns');
    fireEvent.click(screen.getByRole('button', { name: 'continue' }));
    await screen.findByText('Ada Lovelace');
    fireEvent.click(screen.getByRole('button', { name: 'back' }));
    expect(await screen.findByTestId('csv-columns')).toBeInTheDocument();
  });

  it('cannot continue with every column left out', async () => {
    render(<ContactImportDialog existingContacts={[]} onImport={vi.fn()} onClose={vi.fn()} initialFile={cp1252File('Foo,Bar\r\n1,2\r\n')} />);
    await screen.findByTestId('csv-columns');
    expect(screen.getByRole('button', { name: 'continue' })).toBeDisabled();
    expect(screen.getByText('no_columns')).toBeInTheDocument();
  });

  it('takes .csv in the file picker', () => {
    const { container } = render(<ContactImportDialog existingContacts={[]} onImport={vi.fn()} onClose={vi.fn()} />);
    expect(container.ownerDocument.querySelector('input[type="file"]')?.getAttribute('accept')).toContain('.csv');
  });
});
