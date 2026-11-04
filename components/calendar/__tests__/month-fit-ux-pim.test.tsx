import { render, screen, cleanup } from '@testing-library/react';
import { describe, it, expect, vi, afterEach } from 'vitest';
import { CalendarMonthView, fitMonthWeek, monthRowHeight } from '../calendar-month-view';
import type { Calendar, CalendarEvent } from '@/lib/jmap/types';

// pim-6: at 1366x768 the month showed 4½ weeks and at 150 % (911x512) 2½:
// every row kept a 146px minimum. The month's weeks now share the pane and
// a day shows what fits, then "+n more".

const calendars = [{ id: 'cal-1', name: 'Work', color: '#123456' }] as unknown as Calendar[];

function allDay(id: string, start: string): CalendarEvent {
  return {
    id, '@type': 'Event', uid: id, title: 'Event ' + id, start, duration: 'P1D', showWithoutTime: true,
    calendarIds: { 'cal-1': true },
  } as unknown as CalendarEvent;
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('monthRowHeight', () => {
  const metrics = { overlayTop: 30, rowHeight: 26, fallback: 146 };
  it('shares the pane between the weeks of the month', () => {
    expect(monthRowHeight(422, 6, metrics)).toBe(70);
    expect(monthRowHeight(422, 5, metrics)).toBe(84);
  });
  it('keeps the date and one entry in a tiny pane', () => {
    expect(monthRowHeight(120, 6, metrics)).toBe(64);
  });
  it('falls back where nothing was measured', () => {
    expect(monthRowHeight(0, 6, metrics)).toBe(146);
  });
});

describe('fitMonthWeek', () => {
  it('shows a full day whole and cuts only the fuller one', () => {
    // Monday has three events, Tuesday two, room for two rows.
    const segments = [
      { startIndex: 0, span: 1, row: 0 }, { startIndex: 0, span: 1, row: 1 }, { startIndex: 0, span: 1, row: 2 },
      { startIndex: 1, span: 1, row: 0 }, { startIndex: 1, span: 1, row: 1 },
    ];
    const rows = [3, 2, 0, 0, 0, 0, 0];
    const { limits, hidden } = fitMonthWeek(segments, rows, [0, 0, 0, 0, 0, 0, 0], 2);
    expect(limits.slice(0, 2)).toEqual([1, 2]);
    expect(hidden.slice(0, 2)).toEqual([2, 0]);
  });

  it('counts an event over several days as more where it doesn\'t fit', () => {
    // A two-day event in row 1 over Monday (full) and Tuesday.
    const segments = [
      { startIndex: 0, span: 1, row: 0 }, { startIndex: 0, span: 1, row: 2 },
      { startIndex: 0, span: 2, row: 1 },
    ];
    const { limits, hidden, isShown } = fitMonthWeek(segments, [3, 2, 0, 0, 0, 0, 0], [0, 0, 0, 0, 0, 0, 0], 2);
    expect(isShown(segments[2])).toBe(false);
    expect(hidden.slice(0, 2)).toEqual([2, 1]);
    expect(limits[1]).toBe(1);
  });

  it('keeps the one row for an entry when the link goes beside the date', () => {
    const segments = [{ startIndex: 2, span: 1, row: 0 }, { startIndex: 2, span: 1, row: 1 }];
    const { limits, hidden, isShown } = fitMonthWeek(segments, [0, 0, 2, 0, 0, 0, 0], [0, 0, 0, 0, 0, 0, 0], 1, true);
    expect(limits[2]).toBe(1);
    expect(hidden[2]).toBe(1);
    expect(isShown(segments[0])).toBe(true);
  });

  it('shows "+n more" alone where only one row fits', () => {
    const segments = [{ startIndex: 2, span: 1, row: 0 }, { startIndex: 2, span: 1, row: 1 }, { startIndex: 3, span: 1, row: 0 }];
    const { limits, hidden } = fitMonthWeek(segments, [0, 0, 2, 1, 0, 0, 0], [0, 0, 0, 0, 0, 0, 0], 1);
    expect(limits[2]).toBe(0);
    expect(hidden[2]).toBe(2);
    expect(limits[3]).toBe(1);
    expect(hidden[3]).toBe(0);
  });
});

describe('CalendarMonthView at 150 % (911x512)', () => {
  function renderAt(paneHeight: number, focus: Date, rangeStart: Date, rangeEnd: Date, events: CalendarEvent[] = []) {
    vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} });
    vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockReturnValue(paneHeight);
    vi.spyOn(HTMLElement.prototype, 'offsetHeight', 'get').mockReturnValue(33);
    render(
      <CalendarMonthView
        focus={{ date: focus, nonce: 0 }}
        windowKey={`month:${focus.toISOString().slice(0, 10)}`}
        rangeStart={rangeStart}
        rangeEnd={rangeEnd}
        selectedDate={focus}
        events={events}
        calendars={calendars}
        onSelectDate={vi.fn()}
        onSelectEvent={vi.fn()}
      />,
    );
    return Array.from(document.querySelectorAll<HTMLElement>('[data-week]'));
  }

  it('fits all five weeks of September in the pane', () => {
    // The pane under the toolbar: 455px, 33 of them the weekday header.
    const rows = renderAt(455, new Date(2026, 8, 9), new Date(2026, 7, 31), new Date(2026, 9, 4));
    expect(rows).toHaveLength(5);
    const heights = rows.map((row) => parseInt(row.style.minHeight, 10));
    expect(heights.every((h) => h === 84)).toBe(true);
    expect(heights.reduce((a, b) => a + b, 0)).toBeLessThanOrEqual(455 - 33);
  });

  it('fits six weeks of November and puts the "+n" of a full day beside its date', () => {
    const rows = renderAt(455, new Date(2026, 10, 4), new Date(2026, 9, 26), new Date(2026, 11, 6), [
      allDay('a', '2026-11-04T00:00:00'),
      allDay('b', '2026-11-04T00:00:00'),
      allDay('c', '2026-11-05T00:00:00'),
    ]);
    expect(rows).toHaveLength(6);
    expect(rows.every((row) => row.style.minHeight === '70px')).toBe(true);
    // One row fits: Wednesday shows its first event and "+1" beside the
    // date, Thursday its one event.
    expect(screen.getByText('Event a')).toBeTruthy();
    expect(screen.queryByText('Event b')).toBeNull();
    expect(screen.getByText('Event c')).toBeTruthy();
    const more = screen.getAllByRole('button', { name: 'events.more' });
    expect(more).toHaveLength(1);
    expect(more[0].textContent).toBe('+1');
    expect(more[0].parentElement?.style.top).toBe('4px');
  });
});
