import { describe, it, expect } from 'vitest';
import { getContactSortName } from '../contact-store';
import type { ContactCard } from '@/lib/jmap/types';

const make = (overrides: Partial<ContactCard>): ContactCard => ({
  id: 'c1',
  addressBookIds: {},
  ...overrides,
});

const structured = make({
  name: {
    components: [
      { kind: 'given', value: 'Alice' },
      { kind: 'middle', value: 'Jane' },
      { kind: 'surname', value: 'Smith' },
    ],
    isOrdered: true,
  },
});

describe('getContactSortName (#963)', () => {
  it('returns the display name when not sorting by last name', () => {
    expect(getContactSortName(structured, false)).toBe('Alice Smith');
  });

  it('leads with the surname when sorting by last name', () => {
    expect(getContactSortName(structured, true)).toBe('Smith, Alice Jane');
  });

  it('returns just the surname when no given name exists', () => {
    const c = make({ name: { components: [{ kind: 'surname', value: 'Smith' }], isOrdered: true } });
    expect(getContactSortName(c, true)).toBe('Smith');
  });

  it('uses the last word of name.full when there are no components', () => {
    const c = make({ name: { full: 'Jean Pierre Dupont' } });
    expect(getContactSortName(c, true)).toBe('Dupont, Jean Pierre');
  });

  it('keeps a single-word name.full as-is', () => {
    const c = make({ name: { full: 'Madonna' } });
    expect(getContactSortName(c, true)).toBe('Madonna');
  });

  it('does not split organization or email fallbacks into a surname', () => {
    const org = make({ organizations: { o1: { name: 'Acme Corp' } } });
    expect(getContactSortName(org, true)).toBe('Acme Corp');
    const mail = make({ emails: { e0: { address: 'someone@example.com' } } });
    expect(getContactSortName(mail, true)).toBe('someone@example.com');
  });

  it('falls back to the display name for a given-only name (e.g. a group)', () => {
    const c = make({ kind: 'group', name: { components: [{ kind: 'given', value: 'Team' }], isOrdered: true } });
    expect(getContactSortName(c, true)).toBe('Team');
  });
});
