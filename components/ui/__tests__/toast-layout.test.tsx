import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ToastContainer } from '../toast';
import { toast, useToastStore } from '@/stores/toast-store';
import { useBottomControls } from '@/hooks/use-bottom-controls';
import { ContextMenu, ContextMenuItem } from '../context-menu';

function Toasts() {
  const toasts = useToastStore((s) => s.toasts);
  const removeToast = useToastStore((s) => s.removeToast);
  return <ToastContainer toasts={toasts} onClose={removeToast} />;
}

const toastContainer = () => document.querySelector('[data-toast-container]') as HTMLElement;
const card = (title: string) => screen.getByText(title).closest('.toast-item') as HTMLElement;

describe('toast layout', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    useToastStore.setState({ toasts: [] });
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('stacks the newest toast at the bottom, at the end corner', () => {
    render(<Toasts />);
    act(() => { toast.info('First'); });
    act(() => { toast.info('Second'); });
    const container = toastContainer();
    expect(container).toHaveClass('flex-col', 'end-5', 'max-sm:inset-x-3');
    expect(container).not.toHaveClass('flex-col-reverse');
    expect(container.className).not.toMatch(/\bright-5\b/);
    const titles = Array.from(container.querySelectorAll('.toast-item p:first-child')).map((p) => p.textContent);
    expect(titles).toEqual(['First', 'Second']);
  });

  // Where it stands above docked boxes and beside panels: toast-placement.test.tsx.
  it('starts in the bottom end corner, across the bottom on a phone', () => {
    render(<Toasts />);
    expect(toastContainer()).toHaveClass('bottom-5', 'end-5', 'max-sm:inset-x-3', 'max-sm:bottom-3');
  });

  it('names the close button and hides it on a phone', () => {
    render(<Toasts />);
    act(() => { toast.success('Saved'); });
    const close = screen.getByRole('button', { name: 'close' });
    expect(close).toHaveClass('max-sm:hidden');
  });

  it('is dismissed by a sideways swipe on a touch screen', () => {
    const onDismiss = vi.fn();
    render(<Toasts />);
    act(() => { useToastStore.getState().addToast({ type: 'info', title: 'Moved', onDismiss }); });
    const el = card('Moved');
    fireEvent.pointerDown(el, { pointerType: 'touch', pointerId: 1, clientX: 100, clientY: 10 });
    fireEvent.pointerMove(el, { pointerType: 'touch', pointerId: 1, clientX: 140, clientY: 12 });
    fireEvent.pointerMove(el, { pointerType: 'touch', pointerId: 1, clientX: 200, clientY: 12 });
    expect(el.style.transform).toBe('translateX(100px)');
    fireEvent.pointerUp(el, { pointerType: 'touch', pointerId: 1, clientX: 200, clientY: 12 });
    expect(onDismiss).toHaveBeenCalledTimes(1);
    act(() => { vi.advanceTimersByTime(250); });
    expect(screen.queryByText('Moved')).toBeNull();
  });

  it('snaps back after a short swipe, and ignores mouse drags and vertical moves', () => {
    render(<Toasts />);
    act(() => { toast.info('Stays'); });
    const el = card('Stays');
    fireEvent.pointerDown(el, { pointerType: 'touch', pointerId: 1, clientX: 100, clientY: 10 });
    fireEvent.pointerMove(el, { pointerType: 'touch', pointerId: 1, clientX: 130, clientY: 10 });
    fireEvent.pointerUp(el, { pointerType: 'touch', pointerId: 1, clientX: 130, clientY: 10 });
    expect(el.style.transform).toBe('');

    fireEvent.pointerDown(el, { pointerType: 'mouse', pointerId: 2, clientX: 100, clientY: 10 });
    fireEvent.pointerMove(el, { pointerType: 'mouse', pointerId: 2, clientX: 300, clientY: 10 });
    fireEvent.pointerUp(el, { pointerType: 'mouse', pointerId: 2, clientX: 300, clientY: 10 });

    fireEvent.pointerDown(el, { pointerType: 'touch', pointerId: 3, clientX: 100, clientY: 10 });
    fireEvent.pointerMove(el, { pointerType: 'touch', pointerId: 3, clientX: 110, clientY: 200 });
    fireEvent.pointerUp(el, { pointerType: 'touch', pointerId: 3, clientX: 190, clientY: 200 });
    act(() => { vi.advanceTimersByTime(300); });
    expect(screen.getByText('Stays')).toBeInTheDocument();
  });
});

describe('useBottomControls', () => {
  afterEach(() => vi.restoreAllMocks());

  function Bar({ active = true }: { active?: boolean }) {
    const ref = useBottomControls(active);
    return <nav ref={ref}>tabs</nav>;
  }

  it('publishes how far the bar reaches from the bottom while it is mounted', () => {
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(
      () => ({ left: 0, top: window.innerHeight - 64, width: 390, height: 64, right: 390, bottom: window.innerHeight, x: 0, y: 0, toJSON: () => ({}) }) as DOMRect,
    );
    const { unmount } = render(<Bar />);
    expect(document.documentElement.style.getPropertyValue('--bottom-controls-height')).toBe('64px');
    // Toasts keep clear of it (lib/toast-placement).
    expect(screen.getByText('tabs')).toHaveAttribute('data-toast-avoid', 'bottom');
    unmount();
    expect(document.documentElement.style.getPropertyValue('--bottom-controls-height')).toBe('');
  });
});

// On a phone a toast spans the screen and covered the last items of a
// long-press menu. While a menu is open it steps aside and its countdown
// waits; it comes back when the menu closes.
describe('toasts and open menus', () => {
  let phone = true;
  beforeEach(() => {
    vi.useFakeTimers();
    useToastStore.setState({ toasts: [] });
    phone = true;
    vi.spyOn(window, 'matchMedia').mockImplementation((query: string) => ({
      matches: query === '(width < 40rem)' ? phone : false,
      media: query, onchange: null,
      addEventListener: () => {}, removeEventListener: () => {}, addListener: () => {}, removeListener: () => {},
      dispatchEvent: () => false,
    }) as MediaQueryList);
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  function Screen({ menu }: { menu: boolean }) {
    return (
      <>
        <Toasts />
        <ContextMenu isOpen={menu} position={{ x: 10, y: 10 }} onClose={() => {}} label="Row">
          <ContextMenuItem label="Archive" onClick={() => {}} />
        </ContextMenu>
      </>
    );
  }

  it('hides a phone toast while a menu is open and keeps it until the menu closes', () => {
    const { rerender } = render(<Screen menu={false} />);
    act(() => { toast.success('Moved to Trash'); });
    const container = toastContainer();
    expect(container).not.toHaveClass('invisible');

    rerender(<Screen menu />);
    expect(container).toHaveClass('invisible');
    act(() => { vi.advanceTimersByTime(20000); });
    expect(screen.getByText('Moved to Trash')).toBeInTheDocument();

    rerender(<Screen menu={false} />);
    expect(container).not.toHaveClass('invisible');
    act(() => { vi.advanceTimersByTime(6000); });
    expect(screen.queryByText('Moved to Trash')).not.toBeInTheDocument();
  });

  it('leaves desktop toasts where they are', () => {
    phone = false;
    render(<Screen menu />);
    act(() => { toast.success('Saved'); });
    expect(toastContainer()).not.toHaveClass('invisible');
  });
});

// A toast covered the focused Save button at the foot of the event editor
// (WCAG 2.4.11). The stack moves to the top corner while it would cover the
// focused element, and back once the focus is elsewhere.
describe('toasts and the focused element', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    useToastStore.setState({ toasts: [] });
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  function rect(top: number, left: number, width: number, height: number) {
    return { top, left, width, height, right: left + width, bottom: top + height, x: left, y: top, toJSON: () => ({}) } as DOMRect;
  }

  it('moves out from over the focused button and comes back when the focus leaves', () => {
    const h = window.innerHeight;
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
      if (this.hasAttribute('data-toast-container')) return rect(h - 100, 600, 360, 80);
      if (this.id === 'save') return rect(h - 70, 700, 80, 36);
      return rect(10, 10, 80, 36);
    });
    render(<><Toasts /><button id="save">Save</button><button id="title">Title</button></>);
    act(() => { toast.success('Event created'); });
    act(() => { vi.advanceTimersByTime(20); });
    expect(toastContainer()).not.toHaveAttribute('data-dodging');

    act(() => { (document.getElementById('save') as HTMLElement).focus(); });
    act(() => { vi.advanceTimersByTime(20); });
    expect(toastContainer()).toHaveAttribute('data-dodging');
    expect(toastContainer().style.top).toBe('20px');
    expect(toastContainer().style.bottom).toBe('auto');

    act(() => { (document.getElementById('title') as HTMLElement).focus(); });
    act(() => { vi.advanceTimersByTime(20); });
    expect(toastContainer()).not.toHaveAttribute('data-dodging');
  });

  // With the focus in the composer's text or the quick reply box, "Email
  // sent" and "Sending in 5 seconds" moved to the top and covered the
  // composer's close button and the reader's toolbar. A large field the
  // stack only overlaps at a corner keeps the toasts at the bottom.
  it('stays at the bottom over a corner of a large focused field', () => {
    const h = window.innerHeight;
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
      if (this.hasAttribute('data-toast-container')) return rect(h - 100, 600, 360, 80);
      if (this.id === 'body') return rect(h - 400, 300, 700, 360);
      return rect(10, 10, 80, 36);
    });
    render(<><Toasts /><textarea id="body" /></>);
    act(() => { (document.getElementById('body') as HTMLElement).focus(); });
    act(() => { toast.success('Email sent'); });
    act(() => { vi.advanceTimersByTime(20); });
    expect(toastContainer()).not.toHaveAttribute('data-dodging');
    expect(toastContainer().style.top).toBe('');
  });

  // On a phone the top of the screen is the header with Back and the message
  // actions; an Undo toast that moved there blocked them. (#1472)
  it('stays at the bottom on a phone, clear of the header', () => {
    vi.spyOn(window, 'matchMedia').mockImplementation((query: string) => ({
      matches: query === '(width < 40rem)',
      media: query, onchange: null,
      addEventListener: () => {}, removeEventListener: () => {}, addListener: () => {}, removeListener: () => {},
      dispatchEvent: () => false,
    }) as MediaQueryList);
    const h = window.innerHeight;
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
      if (this.hasAttribute('data-toast-container')) return rect(h - 140, 12, 366, 80);
      if (this.id === 'list') return rect(56, 0, 390, h - 116);
      return rect(10, 10, 80, 36);
    });
    render(<><Toasts /><div id="list" tabIndex={-1}>Messages</div></>);
    act(() => { (document.getElementById('list') as HTMLElement).focus(); });
    act(() => { toast.success('Moved to Trash'); });
    act(() => { vi.advanceTimersByTime(20); });
    expect(toastContainer()).not.toHaveAttribute('data-dodging');
    expect(toastContainer().style.top).toBe('');
  });
});
