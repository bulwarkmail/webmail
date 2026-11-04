import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ContactCard } from '@/lib/jmap/types';

vi.mock('next-intl', () => ({
  useTranslations: () => (key: string, params?: Record<string, unknown>) => (params ? `${key} ${JSON.stringify(params)}` : key),
  useLocale: () => 'en',
}));

import { ContactMergeDialog } from '../contact-merge-dialog';

// pim-p3-17: "Merged in and then deleted: Alice Example" when both cards are
// Alice Example: the address says which one goes.

afterEach(() => cleanup());

const card = (id: string, full: string, address: string, updated: string) => ({
  id, kind: 'individual', name: { full }, emails: { e: { address } }, updated,
}) as unknown as ContactCard;

describe('the merge preview names the card that goes', () => {
  it('adds the address when it has the kept card\'s name', () => {
    const kept = card('1', 'Alice Example', 'alice@example.org', '2026-11-01T10:00:00Z');
    const gone = card('2', 'Alice Example', 'alice.old@example.org', '2025-01-01T10:00:00Z');
    render(<ContactMergeDialog cards={[kept, gone]} groups={[]} onMerge={vi.fn()} onClose={vi.fn()} />);
    expect(screen.getByText(/^preview_deleted/).textContent).toBe('preview_deleted {"names":"Alice Example (alice.old@example.org)"}');
  });

  it('keeps just the name when the names differ', () => {
    const kept = card('1', 'Alice Example', 'alice@example.org', '2026-11-01T10:00:00Z');
    const gone = card('2', 'Alice E.', 'alice.old@example.org', '2025-01-01T10:00:00Z');
    render(<ContactMergeDialog cards={[kept, gone]} groups={[]} onMerge={vi.fn()} onClose={vi.fn()} />);
    expect(screen.getByText(/^preview_deleted/).textContent).toBe('preview_deleted {"names":"Alice E."}');
  });
});
