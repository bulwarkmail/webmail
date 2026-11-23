import { render, screen, fireEvent, act } from '@testing-library/react';
import { describe, it, expect, vi } from 'vitest';
import { ContactListItem } from '../contact-list-item';
import type { ContactCard } from '@/lib/jmap/types';

const contact: ContactCard = {
  id: '1',
  addressBookIds: {},
  name: { components: [{ kind: 'given', value: 'Alice' }, { kind: 'surname', value: 'Smith' }], isOrdered: true },
  emails: { e0: { address: 'alice@example.com' } },
  organizations: { o0: { name: 'Acme Corp' } },
};

const noNameContact: ContactCard = {
  id: '2',
  addressBookIds: {},
  emails: { e0: { address: 'nobody@example.com' } },
};

const _emptyContact: ContactCard = {
  id: '3',
  addressBookIds: {},
};

describe('ContactListItem', () => {
  const baseProps = {
    isSelected: false,
    isChecked: false,
    hasSelection: false,
    density: 'regular' as const,
    onClick: vi.fn(),
    onCheckboxClick: vi.fn(),
    selectedContactIds: new Set<string>(),
  };

  it('renders contact name and email', () => {
    render(<ContactListItem contact={contact} {...baseProps} />);
    expect(screen.getByText('Alice Smith')).toBeInTheDocument();
    expect(screen.getByText('alice@example.com')).toBeInTheDocument();
  });

  it('renders organization in comfortable density', () => {
    render(<ContactListItem contact={contact} {...baseProps} density="comfortable" />);
    expect(screen.getByText('Acme Corp')).toBeInTheDocument();
  });

  it('hides organization in regular density', () => {
    render(<ContactListItem contact={contact} {...baseProps} density="regular" />);
    expect(screen.queryByText('Acme Corp')).not.toBeInTheDocument();
  });

  it('applies selected styling', () => {
    const { container } = render(<ContactListItem contact={contact} {...baseProps} isSelected={true} />);
    const div = container.firstElementChild;
    expect(div?.className).toContain('bg-selection');
  });

  it('shows email as display name when no name exists', () => {
    render(<ContactListItem contact={noNameContact} {...baseProps} />);
    const matches = screen.getAllByText('nobody@example.com');
    expect(matches.length).toBeGreaterThanOrEqual(1);
  });

  it('calls onClick when clicked', () => {
    const onClick = vi.fn();
    render(<ContactListItem contact={contact} {...baseProps} onClick={onClick} />);
    fireEvent.click(screen.getByText('Alice Smith'));
    expect(onClick).toHaveBeenCalledOnce();
  });

  it('does not show checkbox when hasSelection is false', () => {
    const { container } = render(<ContactListItem contact={contact} {...baseProps} hasSelection={false} />);
    expect(container.querySelector('button')).not.toBeInTheDocument();
  });

  it('shows checkbox when hasSelection is true', () => {
    const { container } = render(<ContactListItem contact={contact} {...baseProps} hasSelection={true} />);
    expect(container.querySelector('button')).toBeInTheDocument();
  });

  it('hides avatar in extra-compact density', () => {
    const { container } = render(<ContactListItem contact={contact} {...baseProps} density="extra-compact" />);
    expect(container.querySelector('[data-testid="avatar"]') || container.querySelector('.rounded-full')).toBeNull();
  });

  it('hides avatar but keeps the email line in regular-no-avatars density', () => {
    const { container } = render(<ContactListItem contact={contact} {...baseProps} density="regular-no-avatars" />);
    expect(container.querySelector('.rounded-full')).toBeNull();
    expect(screen.getByText('alice@example.com')).toBeInTheDocument();
  });

  it('draws the avatar in regular density', () => {
    const { container } = render(<ContactListItem contact={contact} {...baseProps} />);
    expect(container.querySelector('.rounded-full')).not.toBeNull();
  });

  it('opens the row menu on long-press without leaking the press state onto the row', () => {
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.useFakeTimers();
    try {
      const onLongPress = vi.fn();
      const { container } = render(<ContactListItem contact={contact} {...baseProps} onLongPress={onLongPress} />);
      const row = container.firstElementChild!;
      const touchStart = new Event('touchstart', { bubbles: true });
      Object.defineProperty(touchStart, 'touches', { value: [{ clientX: 5, clientY: 5 }] });
      act(() => { row.dispatchEvent(touchStart); });
      act(() => { vi.advanceTimersByTime(600); });
      expect(onLongPress).toHaveBeenCalledWith(row);
      const unknownProp = errors.mock.calls.some((args) => args.some((a) => String(a).includes('isPressed')));
      expect(unknownProp).toBe(false);
    } finally {
      vi.useRealTimers();
      errors.mockRestore();
    }
  });
});
