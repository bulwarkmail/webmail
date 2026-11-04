import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { ContactCard } from '@/lib/jmap/types';

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
