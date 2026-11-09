import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { Archive, Copy, Filter, Paperclip, Trash2 } from '@/components/icons';
import { SelectionView } from '../selection-view';
import type { MessageActionEntry } from '../message-actions';

// mail-p3-8: the selection's More actions opened Forward as attachments and
// Rules, nothing else. Two entries or fewer are buttons of their own now.

const top: MessageActionEntry[] = [
  { kind: 'item', key: 'archive', icon: Archive, label: 'archive', run: vi.fn(), testId: 'ctx-archive' },
  { kind: 'item', key: 'delete', icon: Trash2, label: 'delete', run: vi.fn(), testId: 'ctx-delete' },
];
const forward = vi.fn();
const two: MessageActionEntry[] = [
  { kind: 'item', key: 'forward_as_attachment', icon: Paperclip, label: 'forward_as_attachments', run: forward, testId: 'ctx-batch-forward-as-attachment' },
  { kind: 'separator' },
  { kind: 'submenu', key: 'rules', icon: Filter, label: 'rules', testId: 'ctx-rules' },
];
const three: MessageActionEntry[] = [
  ...two,
  { kind: 'submenu', key: 'copy_to_account', icon: Copy, label: 'copy_to_account', testId: 'ctx-copy-to' },
];

const props = {
  title: '2 selected',
  unread: 0,
  entries: top,
  shortcutOf: () => undefined,
  onMove: vi.fn(),
  onMore: vi.fn(),
  onClear: vi.fn(),
  tags: { selectedIds: [], partialIds: [], scope: null, onToggle: vi.fn() },
};

describe('More actions in the selection view', () => {
  it('shows two entries as buttons and no More', () => {
    const onOpenRules = vi.fn();
    render(<SelectionView {...props} more={two} onOpenRules={onOpenRules} />);
    expect(screen.queryByTestId('pane-batch-more')).toBeNull();
    fireEvent.click(screen.getByTestId('pane-batch-batch-forward-as-attachment'));
    expect(forward).toHaveBeenCalled();
    fireEvent.click(screen.getByTestId('pane-batch-rules'));
    expect(onOpenRules).toHaveBeenCalledWith(screen.getByTestId('pane-batch-rules'));
  });

  it('keeps More for three entries', () => {
    render(<SelectionView {...props} more={three} onOpenRules={vi.fn()} />);
    expect(screen.getByTestId('pane-batch-more')).toBeTruthy();
    expect(screen.queryByTestId('pane-batch-rules')).toBeNull();
  });

  it('keeps More when the host does not say what it holds', () => {
    render(<SelectionView {...props} />);
    expect(screen.getByTestId('pane-batch-more')).toBeTruthy();
  });
});
