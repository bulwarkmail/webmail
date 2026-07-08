import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { SelectableAvatar } from '../selectable-avatar';

// Isolate from the real Avatar (image fetching, libravatar hashing) — we only
// care about the selection wrapper behaviour here.
vi.mock('@/components/ui/avatar', () => ({
  Avatar: (props: { name?: string }) => <span data-testid="avatar">{props.name}</span>,
}));

describe('SelectableAvatar', () => {
  it('renders the wrapped avatar', () => {
    render(<SelectableAvatar name="Marta" checked={false} onToggle={() => {}} selectLabel="Select" />);
    expect(screen.getByTestId('avatar')).toHaveTextContent('Marta');
  });

  it('fires onToggle and stops propagation when the avatar is clicked', () => {
    const onToggle = vi.fn();
    const onRowClick = vi.fn();
    render(
      <div onClick={onRowClick}>
        <SelectableAvatar name="Marta" checked={false} onToggle={onToggle} selectLabel="Select" />
      </div>,
    );
    fireEvent.click(screen.getByRole('checkbox'));
    expect(onToggle).toHaveBeenCalledTimes(1);
    // Clicking the avatar must not bubble up to open/select the row.
    expect(onRowClick).not.toHaveBeenCalled();
  });

  it('reflects the checked state via aria-checked', () => {
    const { rerender } = render(
      <SelectableAvatar name="Marta" checked={false} onToggle={() => {}} selectLabel="Select" />,
    );
    expect(screen.getByRole('checkbox')).toHaveAttribute('aria-checked', 'false');
    rerender(<SelectableAvatar name="Marta" checked onToggle={() => {}} selectLabel="Select" />);
    expect(screen.getByRole('checkbox')).toHaveAttribute('aria-checked', 'true');
  });
});
