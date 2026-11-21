import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import { describe, it, expect, vi } from 'vitest';
import { ContactForm } from '../contact-form';
import type { ContactCard } from '@/lib/jmap/types';
import { collectOrganizationNames, matchOrganizationNames } from '@/lib/contacts/organization-names';

// #1697: the person's Organization field offers the organization names the
// loaded cards use, so the same company isn't spelled three ways.

const person: ContactCard = {
  id: '1',
  addressBookIds: {},
  name: { components: [{ kind: 'given', value: 'Alice' }], isOrdered: true },
  organizations: { o0: { name: 'old name' } },
};
const names = ['COMPANY International', 'COMPANY LTD', 'COMPANY Polska S.A.', 'Other Corp', 'The Company Shop'];

const field = () => screen.getByRole('combobox', { name: 'organization' }) as HTMLInputElement;

describe('Organization suggestions in the contact form (#1697)', () => {
  it('offers matching names while typing and takes the one picked', async () => {
    const onSave = vi.fn().mockResolvedValue(undefined);
    render(<ContactForm contact={person} allOrganizations={names} onSave={onSave} onCancel={vi.fn()} />);

    fireEvent.change(field(), { target: { value: 'company' } });
    const options = within(screen.getByRole('listbox')).getAllByRole('option').map((o) => o.textContent);
    // Case-insensitive, names starting with it first, then anywhere in the name.
    expect(options).toEqual(['COMPANY International', 'COMPANY LTD', 'COMPANY Polska S.A.', 'The Company Shop']);

    fireEvent.click(within(screen.getByRole('listbox')).getByRole('option', { name: 'COMPANY LTD' }));
    expect(field().value).toBe('COMPANY LTD');
    expect(screen.queryByRole('listbox')).toBeNull();

    fireEvent.submit(screen.getByText('save').closest('form')!);
    await waitFor(() => expect(onSave).toHaveBeenCalled());
    const saved = onSave.mock.calls[0][0] as Partial<ContactCard>;
    expect(Object.values(saved.organizations ?? {})[0]?.name).toBe('COMPANY LTD');
    // Only the name: no link to an organization card is written.
    expect(saved.relatedTo).toBeUndefined();
  });

  it('picks with the arrow keys and Enter, and keeps a new name as typed', () => {
    render(<ContactForm contact={person} allOrganizations={names} onSave={vi.fn()} onCancel={vi.fn()} />);
    fireEvent.change(field(), { target: { value: 'pol' } });
    fireEvent.keyDown(field(), { key: 'ArrowDown' });
    expect(field().getAttribute('aria-activedescendant')).toBeTruthy();
    fireEvent.keyDown(field(), { key: 'Enter' });
    expect(field().value).toBe('COMPANY Polska S.A.');

    fireEvent.change(field(), { target: { value: 'Brand new GmbH' } });
    expect(screen.queryByRole('listbox')).toBeNull();
    expect(field().value).toBe('Brand new GmbH');
  });
});

describe('collectOrganizationNames', () => {
  it('takes persons\' organizations and organization cards, once each', () => {
    const cards = [
      { id: 'a', addressBookIds: {}, organizations: { o0: { name: 'Acme' } } },
      { id: 'b', addressBookIds: {}, organizations: { o0: { name: 'ACME' }, o1: { name: ' Zeta ' } } },
      { id: 'c', addressBookIds: {}, kind: 'org', name: { full: 'Beta Org' } },
      { id: 'd', addressBookIds: {}, kind: 'group', name: { full: 'Friends' } },
    ] as ContactCard[];
    expect(collectOrganizationNames(cards, 'en')).toEqual(['Acme', 'Beta Org', 'Zeta']);
  });

  it('suggests nothing for an empty field', () => {
    expect(matchOrganizationNames(names, '  ')).toEqual([]);
  });
});
