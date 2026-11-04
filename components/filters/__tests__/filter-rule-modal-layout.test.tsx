import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { FilterRule } from '@/lib/jmap/sieve-types';
import { FilterRuleModal } from '../filter-rule-modal';

// settings-p3-20 (usability pass 3, 2026-11-04): the value field's placeholder
// "Value (multiple separated by commas)" was cut in a narrow field, and the note saying
// why "Also apply…" is greyed sat below the dialog's fold. Keys here (next-intl mock).

vi.mock('@/stores/toast-store', () => ({
  toast: { success: vi.fn(), error: vi.fn(), info: vi.fn(), warning: vi.fn() },
}));

const rule: FilterRule = {
  id: 'rule-1',
  name: 'Newsletters',
  enabled: true,
  matchType: 'all',
  conditions: [{ field: 'from', comparator: 'contains', value: '' }],
  // Forward can't run on mail already there: the box is greyed, with the note why.
  actions: [{ type: 'forward', value: 'a@example.org' }],
  stopProcessing: false,
};

describe('filter rule dialog', () => {
  it('has a short placeholder, and says once under the conditions that commas give several values', () => {
    render(<FilterRuleModal rule={rule} mailboxes={[]} onSave={vi.fn()} onClose={() => {}} />);
    expect(screen.getByLabelText('condition_value')).toHaveAttribute('placeholder', 'filter_value_placeholder');
    expect(screen.getAllByText('filter_values_hint')).toHaveLength(1);
  });

  it('keeps "Also apply…" and the note why it is greyed next to Save, out of the scrolling body', () => {
    render(<FilterRuleModal rule={rule} mailboxes={[]} onSave={vi.fn()} onClose={() => {}} offerApplyToExisting applyExistingFolder="Inbox" />);
    const box = screen.getByRole('checkbox', { name: 'apply_existing_in' });
    expect(box).toBeDisabled();
    const footer = screen.getByRole('button', { name: 'save' }).parentElement!;
    expect(footer.contains(box)).toBe(true);
    expect(footer.contains(screen.getByText('apply_existing_unsupported'))).toBe(true);
  });
});
