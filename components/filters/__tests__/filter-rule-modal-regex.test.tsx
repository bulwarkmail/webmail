import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import React from 'react';
import type { FilterRule } from '@/lib/jmap/sieve-types';
import { FilterRuleModal } from '../filter-rule-modal';
import { useSettingsStore } from '@/stores/settings-store';

vi.mock('@/stores/toast-store', () => ({ toast: { error: vi.fn(), success: vi.fn(), info: vi.fn() } }));

const rule: FilterRule = {
  id: 'r1',
  name: 'Cron mail',
  enabled: true,
  matchType: 'all',
  conditions: [{ field: 'subject', comparator: 'contains', value: '' }],
  actions: [{ type: 'mark_read' }],
  stopProcessing: false,
};

function openModal(props: Partial<React.ComponentProps<typeof FilterRuleModal>> = {}) {
  const onSave = vi.fn();
  render(<FilterRuleModal mailboxes={[]} initialRule={rule} onSave={onSave} onClose={vi.fn()} {...props} />);
  return { onSave, saved: () => onSave.mock.calls[0][0] as FilterRule };
}

const fieldSelect = () => screen.getByLabelText('conditions') as HTMLSelectElement;
const comparatorSelect = () => screen.getByLabelText('comparators.contains') as HTMLSelectElement;
const comparatorOptions = () => [...comparatorSelect().options].map((o) => o.value);
const valueInput = () => screen.getByLabelText('condition_value') as HTMLInputElement;

describe('the "matches regex" comparator', () => {
  // Regular expressions are an advanced choice (settings-13).
  beforeEach(() => useSettingsStore.setState({ showAdvancedSettings: true }));

  it('is hidden while the advanced settings are off', () => {
    useSettingsStore.setState({ showAdvancedSettings: false });
    openModal({ regexSupported: true });
    expect(comparatorOptions()).not.toContain('regex');
  });

  it('is offered only when the server lists the regex extension', () => {
    openModal();
    expect(comparatorOptions()).not.toContain('regex');
  });

  it('is offered on header fields and the body, not on size or attachments', () => {
    openModal({ regexSupported: true });
    expect(comparatorOptions()).toContain('regex');
    fireEvent.change(fieldSelect(), { target: { value: 'body' } });
    expect(comparatorOptions()).toContain('regex');
    fireEvent.change(fieldSelect(), { target: { value: 'size' } });
    expect(comparatorOptions()).not.toContain('regex');
  });

  it('keeps commas inside the expression instead of splitting it into values', () => {
    const { saved } = openModal({ regexSupported: true });
    fireEvent.change(comparatorSelect(), { target: { value: 'regex' } });
    fireEvent.change(valueInput(), { target: { value: '^Cron, job{1,3}' } });
    fireEvent.blur(valueInput());
    expect(valueInput().value).toBe('^Cron, job{1,3}');
    fireEvent.click(screen.getByText('save'));
    expect(saved().conditions).toEqual([{ field: 'subject', comparator: 'regex', value: '^Cron, job{1,3}' }]);
  });

  it('does not save an expression the server would refuse', () => {
    const { onSave } = openModal({ regexSupported: true });
    fireEvent.change(comparatorSelect(), { target: { value: 'regex' } });
    fireEvent.change(valueInput(), { target: { value: '(unclosed' } });
    fireEvent.click(screen.getByText('save'));
    expect(onSave).not.toHaveBeenCalled();
    expect(screen.getByText('validation_regex')).toBeTruthy();
    expect(valueInput().getAttribute('aria-invalid')).toBe('true');
  });

  it('stays on a saved regex rule when the server does not list the extension', () => {
    openModal({ initialRule: { ...rule, conditions: [{ field: 'subject', comparator: 'regex', value: '^Cron' }] } });
    expect(comparatorSelect().value).toBe('regex');
  });
});
