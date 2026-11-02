import { act, fireEvent, render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { useComposerSelectionMenu, COMPOSER_SELECTION_SURFACE } from '../composer-selection-menu';
import { clearPluginActions, setPluginActions } from '@/lib/plugin-sandbox/actions';

// The plugins' right-click menu opens only for text the user selected
// before the right-click. A word the browser selects as the button goes
// down (Chrome on a misspelled word, Safari, Chrome on a Mac) belongs to the
// browser's menu with its spelling suggestions.

let menu: ReturnType<typeof useComposerSelectionMenu>;

function Body() {
  menu = useComposerSelectionMenu();
  const read = () => {
    const ta = document.querySelector('textarea')!;
    return ta.value.slice(ta.selectionStart, ta.selectionEnd);
  };
  return <textarea defaultValue="Hello teh world" onMouseDown={menu.onMouseDown} onContextMenu={(e) => menu.onContextMenu(e, read)} />;
}

function setup() {
  render(<Body />);
  const ta = document.querySelector('textarea')!;
  ta.focus();
  return ta;
}

const rightClick = (ta: HTMLTextAreaElement, between?: () => void) => {
  fireEvent.mouseDown(ta, { button: 2 });
  between?.();
  const event = new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 20, clientY: 20 });
  ta.dispatchEvent(event);
  return event;
};

beforeEach(() => {
  // jsdom has no layout; the keyboard path places the menu under the selection.
  Range.prototype.getBoundingClientRect = () => new DOMRect(10, 10, 20, 10);
  setPluginActions('ai', 'AI', COMPOSER_SELECTION_SURFACE, [{ id: 'rewrite', label: 'Rewrite' }]);
});
afterEach(() => clearPluginActions('ai'));

describe('composer selection menu', () => {
  it('opens for text that was selected before the right-click', () => {
    const ta = setup();
    ta.setSelectionRange(0, 5);
    let event!: MouseEvent;
    act(() => { event = rightClick(ta); });
    expect(event.defaultPrevented).toBe(true);
    expect(menu.contextMenu.isOpen).toBe(true);
  });

  it('leaves the browser\'s menu for a word the browser selected on the press', () => {
    const ta = setup();
    ta.setSelectionRange(6, 6);
    const event = rightClick(ta, () => ta.setSelectionRange(6, 9));
    expect(event.defaultPrevented).toBe(false);
    expect(menu.contextMenu.isOpen).toBe(false);
  });

  it('leaves it too when the press moved an existing selection to another word', () => {
    const ta = setup();
    ta.setSelectionRange(0, 5);
    expect(rightClick(ta, () => ta.setSelectionRange(6, 9)).defaultPrevented).toBe(false);
  });

  it('opens from the keyboard (Shift+F10, the Menu key) on the current selection', () => {
    const ta = setup();
    ta.setSelectionRange(0, 5);
    const event = new MouseEvent('contextmenu', { bubbles: true, cancelable: true });
    ta.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(true);
  });

  it('stays out of the way when a proofreading underline already took the click', () => {
    const ta = setup();
    ta.setSelectionRange(0, 5);
    fireEvent.mouseDown(ta, { button: 2 });
    const event = new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 20, clientY: 20 });
    event.preventDefault();
    ta.dispatchEvent(event);
    expect(menu.contextMenu.isOpen).toBe(false);
  });
});
