import { describe, it, expect, vi, beforeEach } from 'vitest';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { PluginActions } from '../plugin-actions';
import { resetActions, setActionDispatcher, setPluginActions } from '@/lib/plugin-sandbox/actions';

const dispatch = vi.fn().mockResolvedValue(undefined);

beforeEach(() => {
  resetActions();
  dispatch.mockClear();
  setActionDispatcher(dispatch);
});

describe('PluginActions', () => {
  it('renders nothing when no plugin declared actions', () => {
    const { container } = render(<PluginActions surface="message-bulk-actions" context={{ emailIds: ['e1'] }} />);

    expect(container).toBeEmptyDOMElement();
  });

  it('draws declared buttons and sends the click with the context', async () => {
    render(<PluginActions surface="message-bulk-actions" context={{ emailIds: ['e1', 'e2'] }} />);
    act(() => setPluginActions('tasks', 'Email to task', 'message-bulk-actions', [{ id: 'make', label: 'Make tasks' }]));

    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Make tasks' })); });

    expect(dispatch).toHaveBeenCalledWith('tasks', 'message-bulk-actions', 'make', { emailIds: ['e1', 'e2'] });
  });

  it('shows only actions meant for the folder or file type', () => {
    act(() => setPluginActions('p', 'P', 'attachment-menu', [
      { id: 'pdf', label: 'Send PDF', mimeTypes: ['application/pdf'] },
      { id: 'img', label: 'Edit image', mimeTypes: ['image/'] },
    ]));

    render(<PluginActions surface="attachment-menu" context={{}} variant="menu" mimeType="image/png" />);

    expect(screen.queryByRole('menuitem', { name: 'Send PDF' })).toBeNull();
    expect(screen.getByRole('menuitem', { name: 'Edit image' })).toBeInTheDocument();
  });

  it('draws a badge on the button, tinted, as the filter button its count', () => {
    act(() => setPluginActions('p', 'P', 'top-bar-actions', [
      { id: 'labels', label: 'Labels', icon: 'tags', badge: 2 },
      { id: 'other', label: 'Other' },
    ]));

    render(<PluginActions surface="top-bar-actions" context={{}} compact />);

    const button = screen.getByRole('button', { name: 'Labels' });
    expect(button.querySelector('[data-plugin-action-badge]')).toHaveTextContent('2');
    expect(button).toHaveClass('bg-primary/10', 'text-primary');
    const other = screen.getByRole('button', { name: 'Other' });
    expect(other.querySelector('[data-plugin-action-badge]')).toBeNull();
    expect(other).not.toHaveClass('bg-primary/10');
  });

  it('draws "99+" past two digits and the count after a menu entry\'s label', () => {
    act(() => setPluginActions('p', 'P', 'top-bar-actions', [{ id: 'labels', label: 'Labels', badge: 120 }]));

    const { unmount } = render(<PluginActions surface="top-bar-actions" context={{}} compact />);
    expect(screen.getByRole('button', { name: 'Labels' })).toHaveTextContent('99+');
    unmount();

    render(<PluginActions surface="top-bar-actions" context={{}} variant="menu" />);
    expect(screen.getByRole('menuitem', { name: /Labels/ })).toHaveTextContent('99+');
  });
});
