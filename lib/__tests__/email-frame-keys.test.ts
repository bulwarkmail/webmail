import { renderHook } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { useKeyboardShortcuts } from '@/hooks/use-keyboard-shortcuts';
import { forwardFrameKeys } from '../email-frame-keys';

// mail-3: after a click into an HTML message, j, k, e, # and the rest did
// nothing, since the key presses went to the body's frame and never reached
// the page's shortcut handlers.

const email = { id: 'm1' } as never;

function frameWith(html: string) {
  const frame = document.createElement('iframe');
  document.body.appendChild(frame);
  const doc = frame.contentDocument!;
  doc.body.innerHTML = html;
  forwardFrameKeys(doc, frame);
  return { frame, doc };
}

/** A key press as the frame's own window makes it. */
function pressIn(doc: Document, target: Element, key: string, code: string, init: KeyboardEventInit = {}) {
  const FrameKeyboardEvent = (doc.defaultView as unknown as { KeyboardEvent: typeof KeyboardEvent }).KeyboardEvent;
  const event = new FrameKeyboardEvent('keydown', { key, code, bubbles: true, cancelable: true, ...init });
  target.dispatchEvent(event);
  return event;
}

function mountShortcuts() {
  const handlers = { onNextEmail: vi.fn(), onArchive: vi.fn(), onDelete: vi.fn(), onCloseEmail: vi.fn(), onSelectAll: vi.fn() };
  renderHook(() => useKeyboardShortcuts({ emails: [email], selectedEmailId: 'm1', handlers }));
  return handlers;
}

afterEach(() => {
  document.body.innerHTML = '';
});

describe('keys pressed in a message body', () => {
  it('reach the app shortcuts: j, e and #', () => {
    const handlers = mountShortcuts();
    const { doc } = frameWith('<p>Newsletter</p>');
    const p = doc.querySelector('p')!;
    const j = pressIn(doc, p, 'j', 'KeyJ');
    pressIn(doc, p, 'e', 'KeyE');
    pressIn(doc, p, '#', 'Digit3', { shiftKey: true });
    expect(handlers.onNextEmail).toHaveBeenCalledTimes(1);
    expect(handlers.onArchive).toHaveBeenCalledTimes(1);
    expect(handlers.onDelete).toHaveBeenCalledTimes(1);
    // The frame doesn't act on a key a shortcut took.
    expect(j.defaultPrevented).toBe(true);
  });

  it('stay in a form inside the mail', () => {
    const handlers = mountShortcuts();
    const { doc } = frameWith('<form><input name="q"><textarea></textarea><div contenteditable="true"><b>x</b></div></form>');
    pressIn(doc, doc.querySelector('input')!, 'j', 'KeyJ');
    pressIn(doc, doc.querySelector('textarea')!, 'e', 'KeyE');
    pressIn(doc, doc.querySelector('b')!, 'Backspace', 'Backspace');
    expect(handlers.onNextEmail).not.toHaveBeenCalled();
    expect(handlers.onArchive).not.toHaveBeenCalled();
    expect(handlers.onDelete).not.toHaveBeenCalled();
  });

  it('leave Ctrl+A, Ctrl+C and the scrolling keys to the body', () => {
    const handlers = mountShortcuts();
    const { doc } = frameWith('<p>Text</p>');
    const p = doc.querySelector('p')!;
    const selectAll = pressIn(doc, p, 'a', 'KeyA', { ctrlKey: true });
    const copy = pressIn(doc, p, 'c', 'KeyC', { ctrlKey: true });
    const space = pressIn(doc, p, ' ', 'Space');
    const down = pressIn(doc, p, 'ArrowDown', 'ArrowDown');
    // Ctrl+A in the list selects every message; in the body it selects the text.
    expect(handlers.onSelectAll).not.toHaveBeenCalled();
    expect(handlers.onNextEmail).not.toHaveBeenCalled();
    for (const event of [selectAll, copy, space, down]) expect(event.defaultPrevented).toBe(false);
  });

  it('Escape puts the focus back on the open message in the list', () => {
    const handlers = mountShortcuts();
    const list = document.createElement('div');
    list.id = 'message-list';
    list.innerHTML = '<div role="row" tabindex="-1">A</div><div role="row" tabindex="-1" aria-current="true">B</div>';
    document.body.appendChild(list);
    const { doc } = frameWith('<p>Text</p>');
    pressIn(doc, doc.querySelector('p')!, 'Escape', 'Escape');
    expect(document.activeElement?.textContent).toBe('B');
    // Only the focus moves: the message stays open.
    expect(handlers.onCloseEmail).not.toHaveBeenCalled();
  });

  it('Escape without a list (a message window) is the app\'s Escape', () => {
    const handlers = mountShortcuts();
    const { doc } = frameWith('<p>Text</p>');
    pressIn(doc, doc.querySelector('p')!, 'Escape', 'Escape');
    expect(handlers.onCloseEmail).toHaveBeenCalledTimes(1);
  });

  it('stop while a menu is open on the page', () => {
    const handlers = mountShortcuts();
    const menu = document.createElement('div');
    menu.setAttribute('role', 'menu');
    document.body.appendChild(menu);
    const { doc } = frameWith('<p>Text</p>');
    pressIn(doc, doc.querySelector('p')!, 'e', 'KeyE');
    expect(handlers.onArchive).not.toHaveBeenCalled();
  });
});
