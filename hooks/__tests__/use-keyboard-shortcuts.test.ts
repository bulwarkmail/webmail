import { renderHook } from '@testing-library/react';
import { describe, it, expect, vi } from 'vitest';
import { useKeyboardShortcuts, KEYBOARD_SHORTCUTS } from '../use-keyboard-shortcuts';

// #683: the help modal advertises `x` for thread expansion and the hook binds
// it; the handler must actually be invoked when a message is selected.

function pressX() {
  document.dispatchEvent(new KeyboardEvent('keydown', { key: 'x', code: 'KeyX', bubbles: true }));
}

describe('useKeyboardShortcuts: x toggles thread expansion', () => {
  it('calls onToggleThreadExpansion for the selected email', () => {
    const onToggleThreadExpansion = vi.fn();
    renderHook(() =>
      useKeyboardShortcuts({
        enabled: true,
        emails: [],
        selectedEmailId: 'e1',
        handlers: { onToggleThreadExpansion },
      }),
    );

    pressX();

    expect(onToggleThreadExpansion).toHaveBeenCalledTimes(1);
  });

  it('does nothing without a selected email', () => {
    const onToggleThreadExpansion = vi.fn();
    renderHook(() =>
      useKeyboardShortcuts({
        enabled: true,
        emails: [],
        handlers: { onToggleThreadExpansion },
      }),
    );

    pressX();

    expect(onToggleThreadExpansion).not.toHaveBeenCalled();
  });
});

// #992: Shift + arrow (or j/k) extends the selection instead of moving to the
// next message; plain arrows still move.
describe('useKeyboardShortcuts: Shift + arrow extends the selection', () => {
  // From inside the message list: the arrows only move the selection there.
  function press(key: string, code: string, shiftKey: boolean) {
    const list = document.createElement('div');
    list.id = 'message-list';
    document.body.appendChild(list);
    try {
      list.dispatchEvent(new KeyboardEvent('keydown', { key, code, shiftKey, bubbles: true }));
    } finally {
      list.remove();
    }
  }

  it.each([
    ['ArrowDown', 'ArrowDown', 1],
    ['ArrowUp', 'ArrowUp', -1],
    ['J', 'KeyJ', 1],
    ['K', 'KeyK', -1],
  ] as const)('Shift + %s (%s) extends by %i', (key, code, direction) => {
    const onExtendSelection = vi.fn();
    const onNextEmail = vi.fn();
    const onPreviousEmail = vi.fn();
    renderHook(() =>
      useKeyboardShortcuts({
        emails: [],
        selectedEmailId: 'e1',
        handlers: { onExtendSelection, onNextEmail, onPreviousEmail },
      }),
    );

    press(key, code, true);

    expect(onExtendSelection).toHaveBeenCalledWith(direction);
    expect(onNextEmail).not.toHaveBeenCalled();
    expect(onPreviousEmail).not.toHaveBeenCalled();
  });

  it('plain ArrowDown still moves to the next message', () => {
    const onExtendSelection = vi.fn();
    const onNextEmail = vi.fn();
    renderHook(() =>
      useKeyboardShortcuts({
        emails: [],
        selectedEmailId: 'e1',
        handlers: { onExtendSelection, onNextEmail },
      }),
    );

    press('ArrowDown', 'ArrowDown', false);

    expect(onNextEmail).toHaveBeenCalledTimes(1);
    expect(onExtendSelection).not.toHaveBeenCalled();
  });
});

// #514: `n` jumps to the next unread message, with or without one open.
describe('useKeyboardShortcuts: n opens the next unread message', () => {
  function pressN(shiftKey = false) {
    document.dispatchEvent(new KeyboardEvent('keydown', { key: shiftKey ? 'N' : 'n', code: 'KeyN', shiftKey, bubbles: true }));
  }

  it('calls onNextUnread with a message open', () => {
    const onNextUnread = vi.fn();
    renderHook(() =>
      useKeyboardShortcuts({ enabled: true, emails: [], selectedEmailId: 'e1', handlers: { onNextUnread } }),
    );

    pressN();

    expect(onNextUnread).toHaveBeenCalledTimes(1);
  });

  it('calls onNextUnread with nothing open', () => {
    const onNextUnread = vi.fn();
    renderHook(() => useKeyboardShortcuts({ enabled: true, emails: [], handlers: { onNextUnread } }));

    pressN();

    expect(onNextUnread).toHaveBeenCalledTimes(1);
  });

  it('ignores Shift + N', () => {
    const onNextUnread = vi.fn();
    renderHook(() => useKeyboardShortcuts({ enabled: true, emails: [], handlers: { onNextUnread } }));

    pressN(true);

    expect(onNextUnread).not.toHaveBeenCalled();
  });

  it('is listed in the help modal under navigation', () => {
    expect(KEYBOARD_SHORTCUTS.navigation).toContainEqual({ key: 'n', description: 'shortcuts.navigation.next_unread' });
  });
});

// Enter on the focused "Skip to message list" link (or any button) belongs to
// that control: it must not open the selected message.
describe('useKeyboardShortcuts: Enter on a link or button', () => {
  function setup() {
    const onOpenEmail = vi.fn();
    renderHook(() =>
      useKeyboardShortcuts({ enabled: true, emails: [], selectedEmailId: 'e1', handlers: { onOpenEmail } }),
    );
    return onOpenEmail;
  }

  it.each([
    ['a link', () => { const a = document.createElement('a'); a.href = '#message-list'; return a; }],
    ['a button', () => document.createElement('button')],
  ])('leaves Enter on %s to it', (_name, make) => {
    const onOpenEmail = setup();
    const el = make();
    document.body.appendChild(el);
    try {
      const event = new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', bubbles: true, cancelable: true });
      el.dispatchEvent(event);
      expect(onOpenEmail).not.toHaveBeenCalled();
      expect(event.defaultPrevented).toBe(false);
    } finally {
      el.remove();
    }
  });

  it('still opens the selected message with Enter elsewhere', () => {
    const onOpenEmail = setup();
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', bubbles: true }));
    expect(onOpenEmail).toHaveBeenCalledTimes(1);
  });
});

describe('useKeyboardShortcuts: Ctrl+A', () => {
  const pressCtrlA = () => {
    const event = new KeyboardEvent('keydown', { key: 'a', code: 'KeyA', ctrlKey: true, bubbles: true, cancelable: true });
    document.dispatchEvent(event);
    return event;
  };

  it('selects all where there is a list', () => {
    const onSelectAll = vi.fn();
    const { unmount } = renderHook(() => useKeyboardShortcuts({ emails: [], handlers: { onSelectAll } }));
    expect(pressCtrlA().defaultPrevented).toBe(true);
    expect(onSelectAll).toHaveBeenCalled();
    unmount();
  });

  it('leaves it to the browser without a list', () => {
    const { unmount } = renderHook(() => useKeyboardShortcuts({ emails: [], selectedEmailId: 'e1', handlers: {} }));
    expect(pressCtrlA().defaultPrevented).toBe(false);
    unmount();
  });
});
