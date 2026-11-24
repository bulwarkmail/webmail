import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ToastContainer } from '../toast';
import { toast, useToastStore } from '@/stores/toast-store';
import { TOAST_EASE, TOAST_MOVE_MS } from '@/lib/toast-motion';

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

function QuickReplyBox({ top = H - 90, height = 90, writing = true, started = false }: { top?: number; height?: number; writing?: boolean; started?: boolean }) {
  // Its height in its style, as the growing text field changes it in the app.
  return (
    <div data-quick-reply-box="" data-reply-started={started ? '' : undefined} data-toast-avoid="bottom" data-rect={`${top},300,${W - 300},${height}`} style={{ height }}>
      {writing ? <textarea autoFocus /> : <button type="button">Reply</button>}
    </div>
  );
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

  it('stays clear of a reply that was started, even while the focus and the pointer are elsewhere', async () => {
    render(<><Toasts /><QuickReplyBox writing={false} started /></>);
    act(() => { toast.success('Archived'); });
    await nextFrame();
    expect(stack().style.bottom).toBe(`${90 + 12}px`);
  });

  it('stays in the corner when the quick reply box ends above it', () => {
    render(<><Toasts /><QuickReplyBox top={H - 200} height={110} /></>);
    act(() => { toast.success('Archived'); });
    expect(stack().style.bottom).toBe('20px');
  });

  it('holds still while one message after another puts its reply box at another height above it', async () => {
    const { rerender } = render(<><Toasts /><QuickReplyBox top={H - 300} height={90} writing={false} /></>);
    act(() => { toast.success('Archived'); });
    const seen = new Set([stack().style.bottom]);
    for (const top of [H - 170, H - 110, H - 330, H - 90, H - 250, H - 140, H - 360]) {
      rerender(<><Toasts /></>);
      await nextFrame();
      seen.add(stack().style.bottom);
      rerender(<><Toasts /><QuickReplyBox top={top} height={90} writing={false} /></>);
      await nextFrame();
      seen.add(stack().style.bottom);
    }
    expect([...seen]).toEqual(['20px']);
  });

  it('makes room above the quick reply box once the pointer rests on it, and comes back down a while after it left', async () => {
    render(<><Toasts /><QuickReplyBox writing={false} /></>);
    act(() => { toast.success('Archived'); });
    expect(stack().style.bottom).toBe('20px');

    const box = document.querySelector('[data-quick-reply-box]') as HTMLElement;
    fireEvent.pointerMove(box, { pointerType: 'mouse', clientX: 340, clientY: H - 40 });
    await nextFrame();
    expect(stack().style.bottom).toBe('20px');
    await act(async () => { vi.advanceTimersByTime(500); });
    await nextFrame();
    expect(stack().style.bottom).toBe(`${90 + 12}px`);

    fireEvent.pointerMove(document.body, { pointerType: 'mouse', clientX: 100, clientY: 100 });
    await nextFrame();
    expect(stack().style.bottom).toBe(`${90 + 12}px`);
    await act(async () => { vi.advanceTimersByTime(800); });
    await nextFrame();
    expect(stack().style.bottom).toBe('20px');
  });

  it('stays put when the pointer only crosses the quick reply box on its way to the stack', async () => {
    render(<><Toasts /><QuickReplyBox writing={false} /></>);
    act(() => { toast.success('Archived'); });
    const box = document.querySelector('[data-quick-reply-box]') as HTMLElement;
    for (const x of [340, 420, 500, 580]) {
      fireEvent.pointerMove(box, { pointerType: 'mouse', clientX: x, clientY: H - 40 });
      await act(async () => { vi.advanceTimersByTime(60); });
      await nextFrame();
      expect(stack().style.bottom).toBe('20px');
    }
    fireEvent.pointerMove(stack(), { pointerType: 'mouse', clientX: W - 300, clientY: H - 50 });
    await act(async () => { vi.advanceTimersByTime(2000); });
    await nextFrame();
    expect(stack().style.bottom).toBe('20px');
  });

  it('holds still when the pointer goes for the stack over the quick reply box', async () => {
    render(<><Toasts /><QuickReplyBox writing={false} /></>);
    act(() => { toast.success('Archived'); });
    fireEvent.pointerMove(stack(), { pointerType: 'mouse', clientX: W - 200, clientY: H - 50 });
    await nextFrame();
    expect(stack().style.bottom).toBe('20px');
  });

  it('makes room above the quick reply box once a reply is being written in it', async () => {
    const { rerender } = render(<><Toasts /><QuickReplyBox writing={false} /></>);
    act(() => { toast.success('Archived'); });
    expect(stack().style.bottom).toBe('20px');

    rerender(<><Toasts /><QuickReplyBox writing /></>);
    await nextFrame();
    expect(stack().style.bottom).toBe(`${90 + 12}px`);
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
    act(() => { vi.advanceTimersByTime(600); });
    act(() => { vi.advanceTimersByTime(6000); });
    expect(screen.queryByText('First')).not.toBeInTheDocument();
  });
});

describe('how the toast stack moves', () => {
  type Glide = { keyframes: Keyframe[]; options?: KeyframeAnimationOptions; cancel: ReturnType<typeof vi.fn> };
  let glides: Glide[] = [];
  const originalMatchMedia = window.matchMedia;

  beforeEach(() => {
    vi.useFakeTimers();
    useToastStore.setState({ toasts: [] });
    mockLayout();
    glides = [];
    (HTMLElement.prototype as unknown as { animate: unknown }).animate = vi.fn(function (keyframes: Keyframe[], options?: KeyframeAnimationOptions) {
      const glide = { keyframes, options, cancel: vi.fn() };
      glides.push(glide);
      return glide as unknown as Animation;
    });
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    delete (HTMLElement.prototype as unknown as { animate?: unknown }).animate;
    window.matchMedia = originalMatchMedia;
  });

  it('appears in its place without gliding there', () => {
    render(<><Toasts /><ComposerFooter /></>);
    act(() => { toast.success('Draft saved'); });
    expect(stack().style.bottom).toBe(`${56 + 12}px`);
    expect(glides).toHaveLength(0);
  });

  it('glides from where it stood to its new place', async () => {
    const { rerender } = render(<><Toasts /></>);
    act(() => { toast.success('Draft saved'); });
    rerender(<><Toasts /><ComposerFooter /></>);
    await nextFrame();

    expect(stack().style.bottom).toBe(`${56 + 12}px`);
    expect(glides).toHaveLength(1);
    expect(glides[0].options).toMatchObject({ duration: TOAST_MOVE_MS, easing: TOAST_EASE });
    expect(glides[0].keyframes[0].transform).toBe('translate(0px, 48px)');
    expect(glides[0].keyframes.at(-1)!.transform).toBe('translate(0px, 0px)');
  });

  it('turns a glide around when it has to move again before it got there', async () => {
    const { rerender } = render(<><Toasts /></>);
    act(() => { toast.success('Draft saved'); });
    rerender(<><Toasts /><ComposerFooter /></>);
    await nextFrame();
    rerender(<><Toasts /></>);
    await nextFrame();

    expect(glides).toHaveLength(2);
    expect(glides[0].cancel).toHaveBeenCalled();
    expect(stack().style.bottom).toBe('20px');
  });

  it('jumps straight there when motion is reduced', async () => {
    window.matchMedia = ((query: string) => ({
      matches: query.includes('prefers-reduced-motion'), media: query, onchange: null,
      addListener: () => {}, removeListener: () => {}, addEventListener: () => {}, removeEventListener: () => {}, dispatchEvent: () => false,
    })) as unknown as typeof window.matchMedia;
    const { rerender } = render(<><Toasts /></>);
    act(() => { toast.success('Draft saved'); });
    rerender(<><Toasts /><ComposerFooter /></>);
    await nextFrame();

    expect(stack().style.bottom).toBe(`${56 + 12}px`);
    expect(glides).toHaveLength(0);
  });
});
