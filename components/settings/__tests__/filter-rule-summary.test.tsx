import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import React from 'react';
import { RuleSummary, VisualRuleSummary } from '../filter-settings';
import type { FilterRule } from '@/lib/jmap/sieve-types';

// Keys as text, except one a locale leaves empty: Mongolian has no words of
// its own for "starts with" (nor for "ends with").
vi.mock('next-intl', () => {
  const t = (key: string) => (key === 'comparators.starts_with' ? '' : key);
  return { useTranslations: () => t, useLocale: () => 'en' };
});

const rule = (overrides: Partial<FilterRule>): FilterRule => ({
  id: 'r1',
  name: 'Rule',
  enabled: true,
  matchType: 'all',
  conditions: [],
  actions: [],
  stopProcessing: false,
  ...overrides,
});

/** The value items in the chip of the condition on `field` (next-intl returns keys). */
const valuesOf = (field: string) => {
  const chip = screen.getByText(`condition_fields.${field}`).parentElement!;
  return { chip, values: [...chip.lastElementChild!.children].map((el) => el.textContent) };
};

// The expanded view wraps a condition's values between each other, so each
// value is its own item and each "or" leads the value after it - a wrapped
// line then starts with "or", and no value is split from its "or".
describe('filter rule summary (expanded view)', () => {
  it('keeps the values of one condition apart, each "or" leading the value after it', () => {
    render(<VisualRuleSummary rule={rule({
      matchType: 'any',
      conditions: [{
        field: 'from',
        comparator: 'contains',
        value: ['ReportingEMail@autoscout24.com', 'gebrauchtwagen.expert', 'noreply@webmobil24.com'],
      }],
      actions: [{ type: 'move', value: 'INBOX/Boersen' }],
    })} />);
    expect(valuesOf('from').values).toEqual([
      '“ReportingEMail@autoscout24.com”',
      'or “gebrauchtwagen.expert”',
      'or “noreply@webmobil24.com”',
    ]);
  });

  it('keeps "or" inside the condition, apart from the "and" between conditions', () => {
    render(<VisualRuleSummary rule={rule({
      matchType: 'all',
      conditions: [
        { field: 'from', comparator: 'contains', value: ['a@example.com', 'b@example.com'] },
        { field: 'body', comparator: 'contains', value: 'Jochen Seith' },
      ],
    })} />);
    const from = valuesOf('from');
    expect(from.chip).toHaveTextContent('or “b@example.com”');
    expect(from.chip).not.toHaveTextContent('and');
    expect(valuesOf('body').values).toEqual(['“Jochen Seith”']);
    expect(from.chip.contains(screen.getByText('and'))).toBe(false);
  });

  it('shows no value for a condition that has none', () => {
    render(<VisualRuleSummary rule={rule({
      conditions: [{ field: 'attachment', comparator: 'has_any', value: '' }],
    })} />);
    const chip = screen.getByText('condition_fields.attachment').parentElement!;
    expect([...chip.children].map((el) => el.textContent)).toEqual([
      'condition_fields.attachment',
      'comparators.has_any',
    ]);
  });

  it('shows the value where a locale leaves the comparator empty', () => {
    render(<VisualRuleSummary rule={rule({
      conditions: [{ field: 'subject', comparator: 'starts_with', value: 'Rechnung' }],
    })} />);
    expect(valuesOf('subject').values).toEqual(['“Rechnung”']);
  });

  it('shows "all messages" on its own, without a comparator or a value', () => {
    const all = rule({
      conditions: [{ field: 'all', comparator: 'any', value: '' }],
      actions: [{ type: 'mark_read' }],
    });
    const { unmount } = render(<VisualRuleSummary rule={all} />);
    const chip = screen.getByText('condition_fields.all').parentElement!;
    expect([...chip.children].map((el) => el.textContent)).toEqual(['condition_fields.all']);
    unmount();

    const { container } = render(<RuleSummary rule={all} />);
    expect(container.textContent).toBe('condition_fields.all→action_types.mark_read');
  });
});
