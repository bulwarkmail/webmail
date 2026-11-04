import { render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { useSettingsStore } from '@/stores/settings-store';
import { EmptySpaceContextMenu } from '../empty-space-context-menu';

// The calendar grid's right-click menu shows the keys that do the same (N, T), as the
// mail menus do; with single keys off they do nothing, so they aren't shown.

const props = {
  position: { x: 10, y: 10 },
  isOpen: true,
  onClose: vi.fn(),
  menuRef: { current: null },
  onNewEvent: vi.fn(),
  onNewAllDayEvent: vi.fn(),
  onGoToToday: vi.fn(),
};

const keyOf = (testId: string) => screen.getByTestId(testId).querySelector('[data-menu-shortcut]')?.textContent ?? null;

afterEach(() => useSettingsStore.setState({ singleKeyShortcuts: true } as never));

describe('the calendar grid menu', () => {
  it('shows N for a new event and T for today', () => {
    useSettingsStore.setState({ singleKeyShortcuts: true } as never);
    render(<EmptySpaceContextMenu {...props} />);
    expect(keyOf('grid-new-event')).toBe('N');
    expect(keyOf('grid-go-to-today')).toBe('T');
  });

  it('shows none with single keys off', () => {
    useSettingsStore.setState({ singleKeyShortcuts: false } as never);
    render(<EmptySpaceContextMenu {...props} />);
    expect(keyOf('grid-new-event')).toBeNull();
  });
});
