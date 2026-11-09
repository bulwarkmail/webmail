import { act, fireEvent, render, screen } from '@testing-library/react';
import { useEffect } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// mail-p2-2 / compose-p2-4: the docked reply took 62 % of the reading pane
// (at least 18 rem), so the message it answered was out of sight. It then
// grew with its text up to half of a tall pane, which left a line or two to
// type in once To, Cc and the bottom bar had their room (inline-reply). It
// now takes 60 % of a tall pane, at least 320 px, with a divider to drag;
// on a short pane, or with a plugin panel open, it takes the pane under the
// reader's toolbar, with "Show the message" to read and come back.

const { ReplyDock, dockLayout, useReplyDock } = await import('../reply-dock');

interface Pane { height: number; readerTop?: number; subjectTop?: number; bodyTop?: number }

function renderInPane({ height, readerTop = 110, subjectTop, bodyTop }: Pane, child = <textarea aria-label="reply text" />) {
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
    const at = (top: number, h = 0) => ({ top, height: h, width: 800, left: 0, right: 800, bottom: top + h, x: 0, y: top, toJSON() {} }) as DOMRect;
    if (this.hasAttribute('data-pane')) return at(0, height);
    if (this.hasAttribute('data-reader-scroll')) return at(readerTop);
    if (this.hasAttribute('data-reader-subject') && subjectTop !== undefined) return at(subjectTop, readerTop - subjectTop);
    if (this.hasAttribute('data-reader-body') && bodyTop !== undefined) return at(bodyTop, 400);
    return at(0);
  });
  return render(
    <div data-pane="">
      {subjectTop !== undefined && <div data-reader-subject=""><h2>Lunch on Friday</h2></div>}
      <div data-reader-scroll=""><div>{bodyTop !== undefined && <div data-reader-body="" />}</div></div>
      <ReplyDock>{child}</ReplyDock>
    </div>,
  );
}

const dockOf = (container: HTMLElement) => container.querySelector('[data-reply-dock]') as HTMLElement;

beforeEach(() => localStorage.clear());
afterEach(() => {
  vi.restoreAllMocks();
  localStorage.clear();
});

describe('the reply dock', () => {
  it('takes 60 % of a tall pane from the start, whatever its content', () => {
    const { container } = renderInPane({ height: 900 });
    const dock = dockOf(container);
    expect(dock.getAttribute('data-dock-mode')).toBe('share');
    expect(dock.style.height).toBe('540px');
    expect(dock.style.maxHeight).toBe('');
    expect(screen.queryByText('show_message')).toBeNull();
  });

  it('never shares the pane below 320 px', () => {
    expect(dockLayout({ paneHeight: 700, readerChrome: 110 })).toEqual({ mode: 'share', height: 420 });
    // 700 px with a tall header: 700 - 300 - 80 leaves 320.
    expect(dockLayout({ paneHeight: 700, readerChrome: 300 })).toEqual({ mode: 'share', height: 320 });
    // No room for 320 px and the sender line above: the reply takes the pane.
    expect(dockLayout({ paneHeight: 700, readerChrome: 320 })).toEqual({ mode: 'takeover' });
  });

  it('chooses by the pane height', () => {
    expect(dockLayout({ paneHeight: 699 }).mode).toBe('takeover');
    expect(dockLayout({ paneHeight: 700 })).toEqual({ mode: 'share', height: 420 });
  });

  it('takes the pane under the toolbar when short, covering the subject, and folds to show the message', () => {
    // Toolbar 56 px, then the subject to 110 px.
    const { container } = renderInPane({ height: 450, readerTop: 110, subjectTop: 56 });
    const dock = dockOf(container);
    expect(dock.getAttribute('data-dock-mode')).toBe('takeover');
    expect(dock.style.height).toBe('394px');
    // The subject it covers is in its bar.
    expect(container.querySelector('[data-dock-subject]')?.textContent).toBe('Lunch on Friday');
    const editor = screen.getByLabelText('reply text');
    act(() => { fireEvent.click(screen.getByText('show_message')); });
    expect(dock.style.height).toBe('');
    // Folded, the reply stays mounted with its text.
    expect(editor.isConnected).toBe(true);
    expect(editor.parentElement!.className).toMatch(/\bhidden\b/);
    act(() => { fireEvent.click(screen.getByText('back_to_reply')); });
    expect(dock.style.height).toBe('394px');
  });

  it('keeps the toolbar and subject when there is no subject block to cover', () => {
    const { container } = renderInPane({ height: 600, readerTop: 110 });
    expect(dockOf(container).style.height).toBe('490px');
  });

  // compose-p3-7: a message with two attachment cards showed its sender and
  // its cards above the reply, none of its text.
  it('gives up its share for some of the message’s text, down to half the pane', () => {
    // Sender and cards to 380 px of a 900 px pane: 900 - 380 - 100 = 420 < 540.
    expect(dockLayout({ paneHeight: 900, readerChrome: 110, aboveBody: 380 })).toEqual({ mode: 'share', height: 450 });
    expect(dockLayout({ paneHeight: 900, readerChrome: 110, aboveBody: 300 })).toEqual({ mode: 'share', height: 500 });
    const { container } = renderInPane({ height: 900, readerTop: 110, bodyTop: 500 });
    expect(dockOf(container).style.height).toBe('450px');
  });

  it('takes the size the user drags it to, and keeps it for the next reply', async () => {
    const { container, unmount } = renderInPane({ height: 900 });
    const handle = screen.getByTestId('reply-dock-resize');
    expect(handle).toHaveAttribute('aria-label', 'resize_reply');
    expect(handle).toHaveAttribute('aria-valuenow', '540');
    // Up by ten from the keyboard: a taller reply.
    await act(async () => { fireEvent.keyDown(handle, { key: 'ArrowUp' }); });
    expect(dockOf(container).style.height).toBe('550px');
    unmount();
    vi.restoreAllMocks();
    const next = renderInPane({ height: 900 });
    expect(dockOf(next.container).style.height).toBe('550px');
    // A double click goes back to 60 %.
    act(() => { fireEvent.doubleClick(screen.getByTestId('reply-dock-resize')); });
    expect(dockOf(next.container).style.height).toBe('540px');
  });

  it('takes the pane while the reply asks for room, and gives it back', () => {
    let ask: (wants: boolean) => void = () => {};
    function Asker() {
      const dock = useReplyDock();
      useEffect(() => { ask = (w) => dock?.setWantsRoom(w); }, [dock]);
      return null;
    }
    const { container } = renderInPane({ height: 900, readerTop: 110, subjectTop: 56 }, <Asker />);
    expect(dockOf(container).getAttribute('data-dock-mode')).toBe('share');
    act(() => ask(true));
    expect(dockOf(container).getAttribute('data-dock-mode')).toBe('takeover');
    expect(dockOf(container).style.height).toBe('844px');
    act(() => ask(false));
    expect(dockOf(container).getAttribute('data-dock-mode')).toBe('share');
  });
});
