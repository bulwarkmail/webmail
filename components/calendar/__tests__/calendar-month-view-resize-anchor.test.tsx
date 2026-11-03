import { render, act, cleanup } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CalendarMonthView } from '../calendar-month-view';
import type { Calendar } from '@/lib/jmap/types';

// Rows change height with the window. The week at the top has to stay there:
// with only the scroll offset kept, the view slid to other weeks.

const calendars = [{ id: 'cal-1', name: 'Work', color: '#123456' }] as unknown as Calendar[];

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('CalendarMonthView on a resized window', () => {
  it('keeps the same week at the top when the rows change height', () => {
    const observers: Array<() => void> = [];
    vi.stubGlobal('ResizeObserver', class {
      constructor(cb: () => void) { observers.push(cb); }
      observe() {}
      disconnect() {}
    });
    const notify = () => observers.forEach((cb) => cb());

    let clientHeight = 600;
    let rowHeight = 100;
    vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockImplementation(() => clientHeight);
    const rows = () => Array.from(document.querySelectorAll<HTMLElement>('[data-week]'));
    const scroller = () => document.querySelector<HTMLElement>('.overflow-y-auto')!;
    // A small layout engine: rows stacked at their height, moved by scrollTop.
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
      const index = rows().indexOf(this);
      const top = index < 0 ? 0 : index * rowHeight - scroller().scrollTop;
      const height = index < 0 ? clientHeight : rowHeight;
      return { top, bottom: top + height, height, left: 0, right: 100, width: 100, x: 0, y: top, toJSON: () => ({}) } as DOMRect;
    });

    render(
      <CalendarMonthView
        focus={{ date: new Date(2026, 8, 9), nonce: 0 }}
        windowKey="month:2026-09-09"
        rangeStart={new Date(2026, 7, 3)}
        rangeEnd={new Date(2026, 10, 1)}
        selectedDate={new Date(2026, 8, 9)}
        events={[]}
        calendars={calendars}
        onSelectDate={vi.fn()}
        onSelectEvent={vi.fn()}
      />,
    );

    const el = scroller();
    const third = rows()[2];
    act(() => notify()); // the first sighting of each row's height
    act(() => {
      el.scrollTop = 200;
      el.dispatchEvent(new Event('scroll'));
    });
    return new Promise<void>((resolve) => requestAnimationFrame(() => {
      act(() => {
        clientHeight = 1800;
        rowHeight = 300;
        notify();
      });
      expect(third.getBoundingClientRect().top).toBe(0);
      resolve();
    }));
  });
});
