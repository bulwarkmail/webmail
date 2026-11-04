import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { Star, StarOff, Archive } from '@/components/icons';
import { SelectionView } from '../selection-view';
import type { MessageActionEntry } from '../message-actions';

// After an action the focus stays where it was in the selection view: Star turning into
// Unstar is the same button.

const entries = (starred: boolean): MessageActionEntry[] => [
  { kind: 'item', key: 'archive', icon: Archive, label: 'archive', run: vi.fn(), testId: 'ctx-archive' },
  starred
    ? { kind: 'item', key: 'star', icon: StarOff, label: 'unstar', run: vi.fn(), testId: 'ctx-unstar' }
    : { kind: 'item', key: 'star', icon: Star, label: 'star', run: vi.fn(), testId: 'ctx-star' },
];

const props = {
  title: '2 selected',
  unread: 0,
  shortcutOf: () => undefined,
  onMove: vi.fn(),
  onMore: vi.fn(),
  onClear: vi.fn(),
  tags: { selectedIds: [], partialIds: [], scope: null, onToggle: vi.fn() },
};

describe('the selection view after an action', () => {
  it('keeps the focus on Star when it becomes Unstar', () => {
    const { rerender } = render(<SelectionView {...props} entries={entries(false)} />);
    const star = screen.getByTestId('pane-batch-star');
    star.focus();
    rerender(<SelectionView {...props} entries={entries(true)} />);
    expect(document.activeElement).toBe(screen.getByTestId('pane-batch-unstar'));
    expect(screen.getByTestId('pane-batch-unstar')).toBe(star);
  });
});
