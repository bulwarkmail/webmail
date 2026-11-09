import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ToastContainer } from '../toast';
import { toast, useToastStore } from '@/stores/toast-store';

// Toasts were left in the middle of the content: their place was worked out
// from a box (the quick reply box's height, a bar's top, the focused element)
// at one moment and kept after the box moved, closed or went with a page
// change. The stack is measured against what is on screen now, again in the
// frame after anything changes.

function Toasts() {
  const toasts = useToastStore((s) => s.toasts);
  const removeToast = useToastStore((s) => s.removeToast);
  return <ToastContainer toasts={toasts} onClose={removeToast} />;
}

const W = window.innerWidth; // 1024 in jsdom
const H = window.innerHeight; // 768 in jsdom
const stack = () => document.querySelector('[data-toast-container]') as HTMLElement;

function rect(top: number, left: number, width: number, height: number) {
  return { top, left, width, height, right: left + width, bottom: top + height, x: left, y: top, toJSON: () => ({}) } as DOMRect;
}

/**
 * Elements say where they are through data-rect="top,left,width,height";
 * fixtures that change size change their style too, as a resize does in the
 * app (jsdom has no ResizeObserver).
 */
function mockLayout() {
  vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(function (this: Element) {
    if (this.hasAttribute('data-toast-container')) {
      const bottom = parseFloat((this as HTMLElement).style.bottom) || 20;
      return rect(H - bottom - 60, W - 20 - 360, 360, 60);
    }
    const r = this.getAttribute('data-rect');
    if (!r) return rect(0, 0, 0, 0);
    const [top, left, width, height] = r.split(',').map(Number);
    return rect(top, left, width, height);
  });
}

/** Run what a frame runs: observers' callbacks, then animation frames. */
async function nextFrame() {
  await act(async () => {
    await Promise.resolve();
    vi.advanceTimersByTime(20);
  });
}

function QuickReplyBox({ top = H - 90, height = 90 }: { top?: number; height?: number }) {
  // Its height in its style, as the growing text field changes it in the app.
  return <div data-quick-reply-box="" data-toast-avoid="bottom" data-rect={`${top},300,${W - 300},${height}`} style={{ height }} />;
}

function ComposerFooter() {
  return <div data-composer-footer="" data-toast-avoid="bottom" data-rect={`${H - 56},300,${W - 300},56`} />;
}

describe('where the toast stack stands', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    useToastStore.setState({ toasts: [] });
    mockLayout();
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('stands above the quick reply box, and comes down in the next frame when the box goes', async () => {
    const { rerender } = render(<><Toasts /><QuickReplyBox /></>);
    act(() => { toast.success('Archived'); });
    expect(stack().style.bottom).toBe(`${90 + 12}px`);

    // The message is moved: the next one is still loading, no box yet.
    rerender(<><Toasts /></>);
    await nextFrame();
    expect(stack().style.bottom).toBe('20px');
  });

  it('follows the box as it grows, from where it is now rather than its height', async () => {
    // On a phone the box sits above the action bar: its height alone put the
    // toasts over it.
    const { rerender } = render(<><Toasts /><QuickReplyBox top={H - 150} height={96} /></>);
    act(() => { toast.success('Moved back'); });
    expect(stack().style.bottom).toBe(`${150 + 12}px`);

    rerender(<><Toasts /><QuickReplyBox top={H - 220} height={166} /></>);
    await nextFrame();
    expect(stack().style.bottom).toBe(`${220 + 12}px`);
  });

  it('moves from the reply dock\'s footer to the quick reply box when the dock closes', async () => {
    const { rerender } = render(<><Toasts /><ComposerFooter /></>);
    act(() => { toast.success('Draft saved'); });
    expect(stack().style.bottom).toBe(`${56 + 12}px`);

    rerender(<><Toasts /><QuickReplyBox top={H - 140} height={140} /></>);
    await nextFrame();
    expect(stack().style.bottom).toBe(`${140 + 12}px`);
  });

  it('starts over on another page: nothing from the last one is kept', async () => {
    function Mail() { return <main><QuickReplyBox top={H - 160} height={160} /></main>; }
    function Calendar() { return <main data-rect={`0,0,${W},${H}`}>month</main>; }
    const { rerender } = render(<><Toasts /><Mail /></>);
    act(() => { toast.success('Archived'); });
    expect(stack().style.bottom).toBe(`${160 + 12}px`);

    rerender(<><Toasts /><Calendar /></>);
    await nextFrame();
    expect(stack().style.bottom).toBe('20px');
  });

  it('leaves out a box scrolled out of view, one in the middle, and one under other columns', () => {
    render(
      <>
        <Toasts />
        {/* Below the fold at the end of a long message. */}
        <div data-toast-avoid="bottom" data-rect={`${H + 40},300,${W - 300},90`} />
        {/* A footer standing in the middle of a short form. */}
        <div data-toast-avoid="bottom" data-rect={`${H / 2 - 100},300,${W - 300},60`} />
        {/* Under the list column, not under the toasts. */}
        <div data-toast-avoid="bottom" data-rect={`${H - 200},0,300,200`} />
      </>,
    );
    act(() => { toast.success('Archived'); });
    expect(stack().style.bottom).toBe('20px');
  });

  it('stands beside a panel at the window\'s end, and over it above its buttons when there is no room', async () => {
    const { rerender } = render(
      <><Toasts /><div data-end-sheet="" data-rect={`0,${W - 400},400,${H}`} style={{ width: 400 }}><div data-toast-avoid="bottom" data-rect={`${H - 60},${W - 400},400,60`} /></div></>,
    );
    act(() => { toast.success('Event created'); });
    expect(stack().style.insetInlineEnd).toBe(`${400 + 20}px`);
    expect(stack().style.bottom).toBe('20px');

    // A window too narrow for both: the corner, above the panel's Save.
    rerender(
      <><Toasts /><div data-end-sheet="" data-rect={`0,${W - 700},700,${H}`} style={{ width: 700 }}><div data-toast-avoid="bottom" data-rect={`${H - 60},${W - 700},700,60`} /></div></>,
    );
    await nextFrame();
    expect(stack().style.insetInlineEnd).toBe('20px');
    expect(stack().style.bottom).toBe(`${60 + 12}px`);

    rerender(<><Toasts /></>);
    await nextFrame();
    expect(stack().style.insetInlineEnd).toBe('20px');
    expect(stack().style.bottom).toBe('20px');
  });

  it('comes back down when the focused element it stepped away from is gone', async () => {
    // The stack goes to the top corner while it would cover the focused
    // button. Removing the button sends the focus to <body> with no focusin:
    // the stack stayed at the top over the next page.
    function Page({ withSave }: { withSave: boolean }) {
      return withSave ? <button id="save" data-rect={`${H - 70},${W - 120},80,36`}>Save</button> : <p>next page</p>;
    }
    const { rerender } = render(<><Toasts /><Page withSave /></>);
    act(() => { toast.success('Settings saved'); });
    act(() => { (document.getElementById('save') as HTMLElement).focus(); });
    await nextFrame();
    expect(stack()).toHaveAttribute('data-dodging');

    rerender(<><Toasts /><Page withSave={false} /></>);
    await nextFrame();
    expect(stack()).not.toHaveAttribute('data-dodging');
    expect(stack().style.bottom).toBe('20px');
  });

  it('stays at the bottom while the focus is in the editor of the reply dock under it', async () => {
    // Above the dock's footer the stack covered the lower corner of the
    // editor; stepping up for it put the toasts over the reader's toolbar.
    render(
      <>
        <Toasts />
        <ComposerFooter />
        <div id="editor" contentEditable suppressContentEditableWarning tabIndex={0} data-rect={`${H - 180},${W - 500},500,120`}>Thanks</div>
      </>,
    );
    act(() => { (document.getElementById('editor') as HTMLElement).focus(); });
    act(() => { toast.success('Archived'); });
    await nextFrame();
    expect(stack()).not.toHaveAttribute('data-dodging');
    expect(stack().style.bottom).toBe(`${56 + 12}px`);
  });

  it('holds still while the mouse is on its way to it, and catches up once it leaves', async () => {
    const { rerender } = render(<><Toasts /></>);
    act(() => { toast.success('Archived'); });
    expect(stack().style.bottom).toBe('20px');

    // The pointer is next to the stack when the quick reply box appears.
    fireEvent.pointerMove(document, { pointerType: 'mouse', clientX: W - 200, clientY: H - 60 });
    rerender(<><Toasts /><QuickReplyBox /></>);
    await nextFrame();
    expect(stack().style.bottom).toBe('20px');

    fireEvent.pointerMove(document, { pointerType: 'mouse', clientX: 100, clientY: 100 });
    await nextFrame();
    expect(stack().style.bottom).toBe(`${90 + 12}px`);
  });

  it('keeps every toast while the pointer is on the stack, so none goes from under it', () => {
    render(<Toasts />);
    act(() => { toast.success('First'); });
    act(() => { toast.success('Second'); });
    fireEvent.pointerOver(screen.getByText('Second'), { pointerType: 'mouse' });
    act(() => { vi.advanceTimersByTime(20000); });
    expect(screen.getByText('First')).toBeInTheDocument();
    expect(screen.getByText('Second')).toBeInTheDocument();

    fireEvent.pointerLeave(stack(), { pointerType: 'mouse' });
    act(() => { vi.advanceTimersByTime(6000); });
    expect(screen.queryByText('First')).not.toBeInTheDocument();
  });
});
