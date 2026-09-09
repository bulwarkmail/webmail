import { render, cleanup } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { useRef } from 'react';
import { useScrollWindow, getScrollStart, setScrollStart, type UseScrollWindowOptions } from '../use-scroll-window';

// #759: the mechanics shared by the freely scrolling calendar views.

type IOCallback = (entries: Array<{ isIntersecting: boolean }>) => void;
let observerCallbacks: IOCallback[] = [];
let observed: Element[] = [];

class FakeIntersectionObserver {
  constructor(cb: IOCallback) { observerCallbacks.push(cb); }
  observe(el: Element) { observed.push(el); }
  disconnect() {}
  unobserve() {}
}

type HarnessProps = Omit<UseScrollWindowOptions, 'scrollRef' | 'startSentinelRef' | 'endSentinelRef' | 'axis'> & {
  axis?: 'vertical' | 'horizontal';
  scrollHeight?: number;
  onRender?: (api: ReturnType<typeof useScrollWindow>) => void;
};

function Harness({ axis = 'vertical', scrollHeight = 1000, onRender, ...options }: HarnessProps) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const startRef = useRef<HTMLDivElement>(null);
  const endRef = useRef<HTMLDivElement>(null);
  const api = useScrollWindow({ ...options, axis, scrollRef, startSentinelRef: startRef, endSentinelRef: endRef });
  onRender?.(api);
  return (
    <div ref={scrollRef} data-testid="scroller" style={{ overflow: 'auto', height: 100 }}>
      <div ref={startRef} data-testid="start" />
      <div style={{ height: scrollHeight }} />
      <div ref={endRef} data-testid="end" />
    </div>
  );
}

describe('useScrollWindow', () => {
  beforeEach(() => {
    observerCallbacks = [];
    observed = [];
    vi.stubGlobal('IntersectionObserver', FakeIntersectionObserver);
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it('scrolls to the focus on mount, on navigation, and after the first load of a window', () => {
    const scrollToFocus = vi.fn();
    const base = { isLoading: false, windowKey: 'w1', focusNonce: 0, scrollToFocus };
    const { rerender } = render(<Harness {...base} />);
    expect(scrollToFocus).toHaveBeenCalledTimes(1);

    rerender(<Harness {...base} isLoading />);
    rerender(<Harness {...base} isLoading={false} />);
    expect(scrollToFocus).toHaveBeenCalledTimes(2);

    // Later loads (extensions) do not move the view ...
    rerender(<Harness {...base} isLoading />);
    rerender(<Harness {...base} isLoading={false} />);
    expect(scrollToFocus).toHaveBeenCalledTimes(2);

    // ... a navigation does, and so does the first load of a fresh window.
    rerender(<Harness {...base} focusNonce={1} windowKey="w2" />);
    expect(scrollToFocus).toHaveBeenCalledTimes(3);
    rerender(<Harness {...base} focusNonce={1} windowKey="w2" isLoading />);
    rerender(<Harness {...base} focusNonce={1} windowKey="w2" isLoading={false} />);
    expect(scrollToFocus).toHaveBeenCalledTimes(4);
  });

  it('arms the sentinels only after the first load and fires each side once per fetch', () => {
    const onExtendStart = vi.fn();
    const onExtendEnd = vi.fn();
    const base = { isLoading: false, windowKey: 'w1', focusNonce: 0, scrollToFocus: vi.fn(), onExtendStart, onExtendEnd };
    const { rerender } = render(<Harness {...base} />);
    expect(observed).toHaveLength(0);

    rerender(<Harness {...base} isLoading />);
    rerender(<Harness {...base} isLoading={false} />);
    expect(observed).toHaveLength(2);

    // Two observers: start first, then end.
    observerCallbacks[0]([{ isIntersecting: true }]);
    expect(onExtendStart).toHaveBeenCalledTimes(1);
    observerCallbacks[1]([{ isIntersecting: true }]);
    expect(onExtendEnd).not.toHaveBeenCalled(); // one extension outstanding

    rerender(<Harness {...base} isLoading />);
    expect(observed).toHaveLength(2); // nothing new observed while loading
    rerender(<Harness {...base} isLoading={false} />);
    observerCallbacks.at(-1)?.([{ isIntersecting: true }]);
    expect(onExtendEnd).toHaveBeenCalledTimes(1);
  });

  it('keeps the visible content in place while the start side grows', () => {
    let api: ReturnType<typeof useScrollWindow> | null = null;
    const base = { isLoading: false, windowKey: 'w1', focusNonce: 0, scrollToFocus: vi.fn(), onExtendStart: vi.fn(), onRender: (a: ReturnType<typeof useScrollWindow>) => { api = a; } };
    const { rerender, getByTestId } = render(<Harness {...base} contentKey={1} />);
    const scroller = getByTestId('scroller');
    // jsdom has no layout: fake the scroll geometry.
    let height = 1000;
    Object.defineProperty(scroller, 'scrollHeight', { get: () => height, configurable: true });
    scroller.scrollTop = 200;

    rerender(<Harness {...base} contentKey={1} isLoading />);
    rerender(<Harness {...base} contentKey={1} isLoading={false} />);
    api!.requestStart();
    expect(api!.pendingSide).toBeNull(); // state updates on the next render

    // The rows for the wider window render right away, before the fetch ...
    height = 1600;
    rerender(<Harness {...base} contentKey={2} />);
    expect(scroller.scrollTop).toBe(800);
    expect(api!.pendingSide).toBe('start');

    // ... and grow again when their events arrive with the fetch.
    rerender(<Harness {...base} contentKey={2} isLoading />);
    height = 1650;
    rerender(<Harness {...base} contentKey={3} isLoading={false} />);
    expect(scroller.scrollTop).toBe(850);
    expect(api!.pendingSide).toBeNull();

    // Growth that is not a start extension leaves the position alone.
    height = 2000;
    rerender(<Harness {...base} contentKey={4} />);
    expect(scroller.scrollTop).toBe(850);
  });

  it('reads and writes the logical scroll start in both directions', () => {
    const el = document.createElement('div');
    document.body.appendChild(el); // computed styles need an attached element
    el.scrollLeft = 40;
    expect(getScrollStart(el, 'horizontal')).toBe(40);
    setScrollStart(el, 'horizontal', 70);
    expect(el.scrollLeft).toBe(70);
    el.style.direction = 'rtl';
    setScrollStart(el, 'horizontal', 30);
    expect(el.scrollLeft).toBe(-30);
    expect(getScrollStart(el, 'horizontal')).toBe(30);
    setScrollStart(el, 'vertical', 12);
    expect(getScrollStart(el, 'vertical')).toBe(12);
  });
});
