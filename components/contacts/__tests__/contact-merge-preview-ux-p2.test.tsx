import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ContactCard } from '@/lib/jmap/types';
import { ContactMergeDialog } from '../contact-merge-dialog';

// pim-p2-14 and pim-p2-15 (2026-11-04): the merge preview listed "Hauptstraße 5,
// Berlin, 10115, Germany" where the card shows "Hauptstraße 5" / "10115 Berlin", and
// left out the birthday the merge keeps. "Merge with…" listed every contact unsorted.

afterEach(() => cleanup());

const anna = {
  id: 'anna', kind: 'individual', name: { full: 'Anna Schmidt' },
  emails: { e: { address: 'anna@example.org' } },
  addresses: {
    a: {
      countryCode: 'DE',
      components: [
        { kind: 'name', value: 'Hauptstraße' }, { kind: 'number', value: '5' },
        { kind: 'locality', value: 'Berlin' }, { kind: 'postcode', value: '10115' }, { kind: 'country', value: 'Germany' },
      ],
    },
  },
  updated: '2026-11-01T10:00:00Z',
} as unknown as ContactCard;

const annaOld = {
  id: 'anna-old', kind: 'individual', name: { full: 'Anna Schmidt' },
  emails: { e: { address: 'anna.s@example.org' } },
  anniversaries: { b: { kind: 'birth', date: { '@type': 'PartialDate', year: 1990, month: 3, day: 14 } } },
  updated: '2025-01-01T10:00:00Z',
} as unknown as ContactCard;

const named = (id: string, full: string) => ({ id, kind: 'individual', name: { full } }) as unknown as ContactCard;

describe('the merge preview', () => {
  it('lays the address out as the card does and lists the birthday it keeps', () => {
    render(<ContactMergeDialog cards={[anna, annaOld]} groups={[]} onMerge={vi.fn()} onClose={vi.fn()} />);
    const preview = screen.getByTestId('merge-preview');
    const address = within(preview).getByText('group_adr_any').nextElementSibling as HTMLElement;
    expect(address.textContent).toBe('Hauptstraße 5\n10115 Berlin\nGermany');
    const birthday = within(preview).getByText('detail.anniversary_birth').nextElementSibling as HTMLElement;
    expect(birthday.textContent).toMatch(/1990/);
  });
});

describe('Merge with…', () => {
  it('lists the contacts to pick by name', () => {
    const candidates = [named('3', 'Jürgen'), named('1', 'Alice'), named('5', 'Zoë'), named('2', 'anna'), named('4', 'Bob')];
    render(<ContactMergeDialog pickFor={named('0', 'Me')} candidates={candidates} groups={[]} onMerge={vi.fn()} onClose={vi.fn()} />);
    const rows = within(screen.getByTestId('merge-pick-list')).getAllByRole('button');
    expect(rows.map((row) => row.textContent)).toEqual(['Alice', 'anna', 'Bob', 'Jürgen', 'Zoë']);
    fireEvent.click(rows[0]);
    expect(screen.getByTestId('merge-preview')).toBeInTheDocument();
  });
});
