import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import React from 'react';
import type { FilterRule } from '@/lib/jmap/sieve-types';
import { FilterRuleModal } from '../filter-rule-modal';

vi.mock('@/stores/toast-store', () => ({ toast: { error: vi.fn(), success: vi.fn(), info: vi.fn() } }));

const rule: FilterRule = {
  id: 'r1',
  name: 'Alles markieren',
  enabled: true,
  matchType: 'all',
  conditions: [{ field: 'from', comparator: 'address_is', value: 'anna@acme.com' }],
  actions: [{ type: 'mark_read' }],
  stopProcessing: false,
};

function openModal(props: Partial<React.ComponentProps<typeof FilterRuleModal>> = {}) {
  const onSave = vi.fn();
  render(<FilterRuleModal mailboxes={[]} initialRule={rule} onSave={onSave} onClose={vi.fn()} {...props} />);
  return { onSave, saved: () => onSave.mock.calls[0][0] as FilterRule };
}

const fieldSelect = () => screen.getByLabelText('conditions') as HTMLSelectElement;
const comparatorSelect = () => screen.queryByLabelText('comparators.contains') as HTMLSelectElement | null;
const valueInput = () => screen.queryByPlaceholderText('value_placeholder_multi') as HTMLInputElement | null;

describe('the "all messages" condition', () => {
  it('is offered, and asks for neither a comparator nor a value', () => {
    const { onSave, saved } = openModal();
    expect([...fieldSelect().options].map((o) => o.value)).toContain('all');
    fireEvent.change(fieldSelect(), { target: { value: 'all' } });
    expect(comparatorSelect()).toBeNull();
    expect(valueInput()).toBeNull();

    fireEvent.click(screen.getByText('save'));
    expect(onSave).toHaveBeenCalledTimes(1);
    expect(saved().conditions).toEqual([{ field: 'all', comparator: 'any', value: '' }]);
  });

  it('turns back into a regular condition when another field is chosen', () => {
    openModal();
    fireEvent.change(fieldSelect(), { target: { value: 'all' } });
    fireEvent.change(fieldSelect(), { target: { value: 'subject' } });
    expect(comparatorSelect()!.value).toBe('contains');
    expect(valueInput()!.value).toBe('');
  });

  it('opens as it was saved, and keeps itself next to a blank row', () => {
    const { saved } = openModal({ initialRule: { ...rule, conditions: [{ field: 'all', comparator: 'any', value: '' }] } });
    expect(fieldSelect().value).toBe('all');
    expect(comparatorSelect()).toBeNull();
    expect(valueInput()).toBeNull();
    // A second row left blank is dropped on save; this one is not.
    fireEvent.click(screen.getByText('add_condition'));
    fireEvent.click(screen.getByText('save'));
    expect(saved().conditions).toEqual([{ field: 'all', comparator: 'any', value: '' }]);
  });

  it('drops the header name of a custom header condition it replaces', () => {
    const { saved } = openModal({
      initialRule: { ...rule, conditions: [{ field: 'header', comparator: 'contains', value: 'bar', headerName: 'X-Foo' }] },
    });
    fireEvent.change(fieldSelect(), { target: { value: 'all' } });
    fireEvent.click(screen.getByText('save'));
    expect(saved().conditions).toEqual([{ field: 'all', comparator: 'any', value: '' }]);
    expect(saved().conditions[0]).not.toHaveProperty('headerName');
  });

  it('stays when a suggestion is added next to it', () => {
    const { saved } = openModal({
      initialRule: { ...rule, conditions: [{ field: 'all', comparator: 'any', value: '' }] },
      suggestions: [{ id: 'subject', label: 'Betreff Rechnung', condition: { field: 'subject', comparator: 'contains', value: 'Rechnung' } }],
    });
    // Unlike a blank row, it takes no value and is not made way for.
    fireEvent.click(screen.getByText('Betreff Rechnung'));
    fireEvent.click(screen.getByText('save'));
    expect(saved().conditions).toEqual([
      { field: 'all', comparator: 'any', value: '' },
      { field: 'subject', comparator: 'contains', value: 'Rechnung' },
    ]);
  });

  it('is never run on the messages already in the folder', () => {
    openModal({ offerApplyToExisting: true });
    const applyExisting = screen.getByLabelText('apply_existing') as HTMLInputElement;
    expect(applyExisting.disabled).toBe(false);
    fireEvent.change(fieldSelect(), { target: { value: 'all' } });
    expect(fieldSelect().value).toBe('all');
    expect(applyExisting.disabled).toBe(true);
  });
});
