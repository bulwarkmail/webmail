import { act, cleanup, fireEvent, render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CalendarWeekView } from '../calendar-week-view';
import { CalendarDayView } from '../calendar-day-view';
import type { Calendar } from '@/lib/jmap/types';

// #1762: an inactive Pro tab stays mounted with display: none. The hidden
// strip measured a zero width and read its scroll position as 0, and the
// views reported that as the day in view, so coming back showed another
// week (a month off with free scrolling).

const calendars = [{ id: 'cal-1', name: 'Work', color: '#123456' }] as unknown as Calendar[];

let width = 1000;
const observers: Array<{ callback: ResizeObserverCallback; targets: Element[] }> = [];

beforeEach(() => {
  width = 1000;
  observers.length = 0;
  vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockImplementation(() => width);
  vi.stubGlobal('ResizeObserver', class {
    private entry: { callback: ResizeObserverCallback; targets: Element[] };
    constructor(callback: ResizeObserverCallback) {
      this.entry = { callback, targets: [] };
      observers.push(this.entry);
    }
    observe(target: Element) { this.entry.targets.push(target); }
    unobserve() {}
    disconnect() { this.entry.targets = []; }
  });
  vi.stubGlobal('requestAnimationFrame', (fn: FrameRequestCallback) => { fn(0); return 1; });
  vi.stubGlobal('cancelAnimationFrame', () => {});
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

/** The browser's resize pass: every observer of the strip hears about it. */
function resize(root: Element) {
  act(() => {
    for (const { callback, targets } of [...observers]) {
      if (targets.includes(root)) callback([], {} as ResizeObserver);
    }
  });
}

/** The scroll container, with a scroll position jsdom keeps (it has no layout). */
function stripOf(container: HTMLElement): HTMLElement {
  // The outermost observed element around the days (the sticky header is observed too).
  let el: HTMLElement | null = null;
  for (let at: HTMLElement | null = container.querySelector<HTMLElement>('[data-day]'); at; at = at.parentElement) {
    if (observers.some(({ targets }) => targets.includes(at!))) el = at;
  }
  let left = 0;
  Object.defineProperty(el!, 'scrollLeft', { configurable: true, get: () => left, set: (value: number) => { left = value; } });
  // Settling on a column boundary (smooth scrolling) is not what is tested here.
  el!.scrollTo = () => {};
  return el!;
}

const range = { start: new Date(2026, 8, 7), end: new Date(2026, 9, 4) };

describe.each([
  ['Week', (onVisibleDateChange: (d: Date) => void, focus = { date: new Date(2026, 8, 16), nonce: 0 }) => (
    <CalendarWeekView
      focus={focus}
      windowKey="week:2026-09-14"
      rangeStart={range.start}
      rangeEnd={range.end}
      selectedDate={new Date(2026, 8, 16)}
      events={[]}
      calendars={calendars}
      onSelectDate={vi.fn()}
      onSelectEvent={vi.fn()}
      onCreateAtTime={vi.fn()}
      onVisibleDateChange={onVisibleDateChange}
    />
  )],
  ['Day', (onVisibleDateChange: (d: Date) => void, focus = { date: new Date(2026, 8, 16), nonce: 0 }) => (
    <CalendarDayView
      focus={focus}
      windowKey="day:2026-09-16"
      rangeStart={range.start}
      rangeEnd={range.end}
      selectedDate={new Date(2026, 8, 16)}
      events={[]}
      calendars={calendars}
      onSelectEvent={vi.fn()}
      onCreateAtTime={vi.fn()}
      onVisibleDateChange={onVisibleDateChange}
    />
  )],
] as const)('%s view in a Pro tab that is hidden and shown again', (_name, view) => {
  it('reports no day while hidden and comes back where it was', () => {
    vi.useFakeTimers();
    const onVisibleDateChange = vi.fn();
    const { container } = render(view(onVisibleDateChange));
    const strip = stripOf(container);
    const columns = () => Array.from(container.querySelectorAll<HTMLElement>('[style*="grid-template-columns"]')).map((el) => el.style.gridTemplateColumns)[0];
    resize(strip);
    const shownColumns = columns();

    // On screen, scrolled to some day.
    strip.scrollLeft = 1888;
    fireEvent.scroll(strip);
    act(() => { vi.advanceTimersByTime(200); });
    onVisibleDateChange.mockClear();

    // The tab is hidden: no width, and the position reads 0.
    width = 0;
    strip.scrollLeft = 0;
    resize(strip);
    fireEvent.scroll(strip);
    act(() => { vi.advanceTimersByTime(200); });
    expect(onVisibleDateChange).not.toHaveBeenCalled();
    expect(columns()).toBe(shownColumns);

    // Shown again: the same place.
    width = 1000;
    resize(strip);
    expect(strip.scrollLeft).toBe(1888);
    expect(columns()).toBe(shownColumns);
  });

  it('goes to a date picked while hidden once shown', () => {
    const { container, rerender } = render(view(vi.fn()));
    const strip = stripOf(container);
    resize(strip);
    strip.scrollLeft = 1888;
    fireEvent.scroll(strip);

    width = 0;
    strip.scrollLeft = 0;
    resize(strip);
    rerender(view(vi.fn(), { date: new Date(2026, 8, 30), nonce: 1 }));
    expect(strip.scrollLeft).toBe(0);

    width = 1000;
    resize(strip);
    expect(strip.scrollLeft).toBeGreaterThan(1888);
  });
});
