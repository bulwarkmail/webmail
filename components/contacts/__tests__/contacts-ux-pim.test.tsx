import { fireEvent, render, screen, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { AddressBook, ContactCard } from '@/lib/jmap/types';

// Keys with their namespace, so a label read from ux_pim_contact can be told
// from the old one in contacts.form.
vi.mock('next-intl', () => ({
  useTranslations: (ns?: string) => (key: string) => (ns ? `${ns}.${key}` : key),
  useLocale: () => 'en',
  useFormatter: () => ({ dateTime: String, relativeTime: String, number: String }),
}));
vi.mock('@/stores/account-store', () => {
  const state = { accounts: [], activeAccountId: null };
  const hook = (sel?: (s: typeof state) => unknown) => (typeof sel === 'function' ? sel(state) : state);
  hook.getState = () => state;
  return { useAccountStore: hook };
});
vi.mock('@/components/contacts/contact-activity', () => ({ ContactActivity: () => null }));

import { ContactForm } from '../contact-form';
import { ContactDetail } from '../contact-detail';
import { ContactsSidebar } from '../contacts-sidebar';

const anna: ContactCard = {
  id: 'c1',
  addressBookIds: {},
  name: { components: [{ kind: 'given', value: 'Anna' }, { kind: 'surname', value: 'Example' }], isOrdered: true },
  emails: { e0: { address: 'anna@example.net', contexts: { private: true } } },
  phones: { p0: { number: '+49 30 1', features: { voice: true }, contexts: { private: true } } },
};

describe('pim-19: standard words read as people say them', () => {
  it('offers "Phone" and "Home" in the editor, storing voice and private as before', () => {
    render(<ContactForm contact={anna} onSave={vi.fn()} onCancel={vi.fn()} />);
    const phoneType = screen.getByDisplayValue('ux_pim_contact.phone_voice') as HTMLSelectElement;
    expect(phoneType.value).toBe('voice');
    expect(screen.getAllByDisplayValue('ux_pim_contact.context_private').map(s => (s as HTMLSelectElement).value)).toEqual(['private', 'private']);
    expect(screen.queryByText('contacts.form.phone_voice')).toBeNull();
    expect(screen.queryByText('contacts.form.context_private')).toBeNull();
  });

  it('labels a voice phone "Phone" and a private one "Home" on the contact page', () => {
    render(<ContactDetail contact={anna} onEdit={vi.fn()} onDelete={vi.fn()} />);
    expect(screen.getByText('ux_pim_contact.context_private · ux_pim_contact.phone_voice')).toBeInTheDocument();
  });
});

describe('pim-26: the contact editor keeps rare fields under "More fields"', () => {
  it('collapses Gender, Calendar, Online services and Personal info when none has a value', () => {
    render(<ContactForm contact={anna} onSave={vi.fn()} onCancel={vi.fn()} />);
    expect(screen.getByText('ux_pim_contact.more_fields')).toBeInTheDocument();
    expect(screen.queryByText('contacts.form.gender_sex')).toBeNull();
    expect(screen.queryByText('contacts.form.calendar_uri')).toBeNull();
    expect(screen.queryByText('contacts.form.add_online_service')).toBeNull();
    expect(screen.queryByText('contacts.form.add_personal_info')).toBeNull();
    fireEvent.click(screen.getByText('ux_pim_contact.more_fields'));
    expect(screen.getByText('contacts.form.gender_sex')).toBeInTheDocument();
    expect(screen.getByText('contacts.form.calendar_uri')).toBeInTheDocument();
    expect(screen.getByText('contacts.form.add_online_service')).toBeInTheDocument();
    expect(screen.getByText('contacts.form.add_personal_info')).toBeInTheDocument();
  });

  it('opens "More fields" when one of them has a value', () => {
    render(<ContactForm contact={{ ...anna, calendarUri: 'https://cal.example/anna' }} onSave={vi.fn()} onCancel={vi.fn()} />);
    expect(screen.getByDisplayValue('https://cal.example/anna')).toBeInTheDocument();
  });
});

function renderSidebar(addressBooks: AddressBook[]) {
  return render(
    <ContactsSidebar
      groups={[]}
      individuals={[]}
      addressBooks={addressBooks}
      activeCategory="all"
      onSelectCategory={vi.fn()}
      onCreateGroup={vi.fn()}
      onCreateContact={vi.fn()}
      onCreateAddressBook={vi.fn()}
      onImport={vi.fn()}
      onEditGroup={vi.fn()}
      onDeleteGroup={vi.fn()}
    />,
  );
}

describe('pim-22: the Contacts sidebar', () => {
  it("leaves out the app's own Trusted Senders book, which Settings manages", () => {
    const { unmount } = renderSidebar([
      { id: 'b1', name: 'Contacts', isDefault: true } as AddressBook,
      { id: 'b2', name: 'Trusted Senders', isDefault: false } as AddressBook,
    ]);
    expect(screen.getByText('Contacts')).toBeInTheDocument();
    expect(screen.queryByText('Trusted Senders')).toBeNull();
    unmount();
    // Someone else's book with that name is theirs, not the app's list.
    renderSidebar([
      { id: 'b1', name: 'Contacts', isDefault: true } as AddressBook,
      { id: 'b3', name: 'Trusted Senders', isShared: true, accountId: 'acc-b', accountName: 'b@example.org' } as AddressBook,
    ]);
    expect(screen.getByText('Trusted Senders')).toBeInTheDocument();
  });
});

describe('pim-26: the Contacts menus', () => {
  it('ends "Import contacts" and "New address book" in "…", as they open a dialog', () => {
    renderSidebar([{ id: 'b1', name: 'Contacts', isDefault: true } as AddressBook]);
    fireEvent.click(screen.getByRole('button', { name: 'contacts.new' }));
    const menu = screen.getByRole('menu');
    expect(within(menu).getByText('ux_pim_contact.import_menu')).toBeInTheDocument();
    expect(within(menu).getByText('ux_pim_contact.new_address_book_menu')).toBeInTheDocument();
  });
});
