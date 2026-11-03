import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { ToastItem } from '../toast';

describe('a toast with more than three actions', () => {
  it('shows them in order, and each closes it', () => {
    vi.useFakeTimers();
    const clicked = vi.fn();
    const onDismiss = vi.fn();
    const action = (label: string) => ({ label, onClick: () => clicked(label) });
    render(
      <ToastItem
        onClose={vi.fn()}
        toast={{
          id: 't',
          type: 'info',
          title: 'Standup',
          duration: 0,
          onDismiss,
          tertiaryAction: action('five'),
          secondaryAction: action('ten'),
          action: action('fifteen'),
          extraActions: [action('join'), action('open')],
        }}
      />,
    );
    expect(screen.getAllByRole('button').map((button) => button.textContent).filter(Boolean)).toEqual(['five', 'ten', 'fifteen', 'join', 'open']);
    fireEvent.click(screen.getByText('join'));
    expect(clicked).toHaveBeenCalledWith('join');
    expect(onDismiss).toHaveBeenCalledTimes(1);
    vi.useRealTimers();
  });
});
