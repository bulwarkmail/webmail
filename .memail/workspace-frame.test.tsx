import { fireEvent, render, screen } from '@testing-library/react';
import { expect, it, vi } from 'vitest';
import { WorkspaceQueue } from './workspace-frame';

it('identifies partial counts and opens unread through the supplied native action', () => {
  const open = vi.fn();
  render(<WorkspaceQueue count={50} unread={4} hasMore loading={false} onShortcuts={() => {}} onOpenUnread={open} />);
  expect(screen.getByRole('status')).toHaveTextContent('50+ loaded · 4 unread');
  fireEvent.click(screen.getByRole('button', { name: 'Open unread' }));
  expect(open).toHaveBeenCalledOnce();
});

it('does not open stale results while the queue is loading', () => {
  const open = vi.fn();
  render(<WorkspaceQueue count={50} unread={4} hasMore loading onShortcuts={() => {}} onOpenUnread={open} />);
  expect(screen.getByRole('status')).toHaveTextContent('Loading conversations');
  fireEvent.click(screen.getByRole('button', { name: 'Open unread' }));
  expect(open).not.toHaveBeenCalled();
});

it('keeps shortcuts available when the queue is empty', () => {
  const shortcuts = vi.fn();
  render(<WorkspaceQueue count={0} unread={0} hasMore={false} loading={false} onShortcuts={shortcuts} />);
  expect(screen.getByRole('button', { name: 'Open unread' })).toBeDisabled();
  fireEvent.click(screen.getByRole('button', { name: 'Show mail keyboard shortcuts' }));
  expect(shortcuts).toHaveBeenCalledOnce();
});
