import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

// mail-p2-2 / compose-p2-4: the docked reply took 62 % of the reading pane
// (at least 18 rem), so the message it answered was out of sight, and on a
// short window the reply itself had two lines to type in. It now grows with
// its text up to half of a tall pane; on a short pane it takes the pane under
// the reader's toolbar, with "Show the message" to read and come back.

const { ReplyDock, dockLayout } = await import('../reply-dock');

function renderInPane(height: number, readerTop = 110) {
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
    if (this.hasAttribute('data-pane')) return { top: 0, height, width: 800, left: 0, right: 800, bottom: height, x: 0, y: 0, toJSON() {} } as DOMRect;
    if (this.hasAttribute('data-reader-scroll')) return { top: readerTop, height: 0, width: 800, left: 0, right: 800, bottom: readerTop, x: 0, y: readerTop, toJSON() {} } as DOMRect;
    return { top: 0, height: 0, width: 0, left: 0, right: 0, bottom: 0, x: 0, y: 0, toJSON() {} } as DOMRect;
  });
  return render(
    <div data-pane="">
      <div data-reader-scroll="" />
      <ReplyDock><textarea aria-label="reply text" /></ReplyDock>
    </div>,
  );
}

afterEach(() => vi.restoreAllMocks());

describe('the reply dock', () => {
  it('takes at most half of a tall pane, sized by its content', () => {
    const { container } = renderInPane(768);
    const dock = container.querySelector('[data-reply-dock]') as HTMLElement;
    expect(dock.getAttribute('data-dock-mode')).toBe('share');
    expect(dock.style.maxHeight).toBe('384px');
    expect(dock.style.height).toBe('');
    expect(dock.className).not.toMatch(/basis-/);
    expect(screen.queryByText('show_message')).toBeNull();
  });

  it('takes a short pane under the reader toolbar, and folds to show the message', () => {
    const { container } = renderInPane(600, 110);
    const dock = container.querySelector('[data-reply-dock]') as HTMLElement;
    expect(dock.getAttribute('data-dock-mode')).toBe('takeover');
    expect(dock.style.height).toBe('490px');
    const editor = screen.getByLabelText('reply text');
    act(() => { fireEvent.click(screen.getByText('show_message')); });
    expect(dock.style.height).toBe('');
    // Folded, the reply stays mounted with its text.
    expect(editor.isConnected).toBe(true);
    expect(editor.parentElement!.className).toMatch(/\bhidden\b/);
    act(() => { fireEvent.click(screen.getByText('back_to_reply')); });
    expect(dock.style.height).toBe('490px');
  });

  it('chooses by the pane height', () => {
    expect(dockLayout(699).mode).toBe('takeover');
    expect(dockLayout(700)).toEqual({ mode: 'share', maxHeight: 350 });
  });
});
