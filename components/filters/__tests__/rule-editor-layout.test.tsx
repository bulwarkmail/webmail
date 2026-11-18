import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { FilterRule } from '@/lib/jmap/sieve-types';
import { RuleEditor } from '../rule-editor';

vi.mock('@/stores/toast-store', () => ({
  toast: { success: vi.fn(), error: vi.fn(), info: vi.fn(), warning: vi.fn() },
}));

const rule: FilterRule = {
  id: 'rule-1',
  name: 'Newsletters',
  enabled: true,
  matchType: 'all',
  conditions: [{ field: 'from', comparator: 'contains', value: 'news' }],
  actions: [{ type: 'mark_read' }],
  stopProcessing: false,
};

describe('rule dialog layout', () => {
  it('has a short placeholder, with the note that commas give several values on the field itself', () => {
    render(<RuleEditor rule={rule} mailboxes={[]} onSave={vi.fn()} onClose={() => {}} />);
    const value = screen.getByLabelText('condition_value');
    expect(value).toHaveAttribute('placeholder', 'filter_value_placeholder');
    expect(value).toHaveAttribute('title', 'filter_values_hint');
  });

  it('keeps Apply to next to Save, out of the scrolling body', async () => {
    const previewMatches = vi.fn().mockResolvedValue({ items: [], total: 4, complete: true, inFolder: 2 });
    render(
      <RuleEditor rule={rule} mailboxes={[]} previewMatches={previewMatches} offerApplyToExisting applyExistingFolder="Inbox" onSave={vi.fn()} onClose={() => {}} />,
    );
    const choice = await screen.findByLabelText('apply_to', {}, { timeout: 3000 });
    const footer = screen.getByRole('button', { name: 'save' }).parentElement!;
    expect(footer.contains(choice)).toBe(true);
  });
});
