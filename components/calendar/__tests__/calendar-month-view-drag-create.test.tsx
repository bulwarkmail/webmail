import { render, fireEvent, cleanup, act, screen } from '@testing-library/react';
import { describe, it, expect, vi, afterEach, beforeEach, beforeAll } from 'vitest';
import type { CalendarEvent, Calendar } from '@/lib/jmap/types';

// Usability report 2026-11-04: in the month view a drag over the days did
// nothing. It now picks days, as in Google Calendar and Outlook, and opens
// the quick editor for an all-day event over them.

const announce = vi.hoisted(() => vi.fn());
vi.mock('@/lib/announce', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/announce')>()),
  announce,
}));

import { CalendarMonthView } from '../calendar-month-view';

const calendars = [{ id: 'cal-1', name: 'Work', color: '#123456' }] as unknown as Calendar[];
const standup = {
  id: 'e1', '@type': 'Event', uid: 'e1', title: 'Standup', start: '2026-11-05T00:00:00', duration: 'P1D',
  showWithoutTime: true, calendarIds: { 'cal-1': true },
} as unknown as CalendarEvent;

type Props = React.ComponentProps<typeof CalendarMonthView>;

function renderMonth(overrides: Partial<Props> = {}) {
  const props: Props = {
    focus: { date: new Date(2026, 10, 4), nonce: 0 },
    windowKey: 'month:2026-11-04',
    // Monday 2 Nov to Sunday 22 Nov 2026: three week rows.
    rangeStart: new Date(2026, 10, 2),
    rangeEnd: new Date(2026, 10, 22),
    selectedDate: new Date(2026, 10, 4),
    events: [standup],
    calendars,
    onSelectDate: vi.fn(),
    onSelectEvent: vi.fn(),
    onCreateAllDay: vi.fn(),
    onCreateRange: vi.fn(),
    onOpenDay: vi.fn(),
    onContextMenuEmpty: vi.fn(),
    ...overrides,
  };
  const view = render(<CalendarMonthView {...props} />);
  layOut(props.isMobile ? false : document.documentElement.dir === 'rtl');
  return { props, ...view };
}

/**
 * jsdom lays nothing out: give the week rows and day cells the boxes a
 * 700 px wide grid has (100 px per day and row), mirrored in a
 * right-to-left grid.
 */
function layOut(rtl: boolean) {
  const box = (left: number, top: number, width: number, height: number) =>
    () => ({ left, top, right: left + width, bottom: top + height, width, height, x: left, y: top, toJSON() {} }) as DOMRect;
  document.querySelectorAll<HTMLElement>('[data-week]').forEach((row, r) => {
    row.getBoundingClientRect = box(0, r * 100, 700, 100);
    row.querySelectorAll<HTMLElement>('[data-month-day]').forEach((cell, c) => {
      cell.getBoundingClientRect = box((rtl ? 6 - c : c) * 100, r * 100, 100, 100);
    });
  });
}

const cell = (key: string) => document.querySelector<HTMLElement>(`[data-month-day="${key}"]`)!;
/** The middle of a day's box, in the layout above. */
function pointOf(key: string) {
  const rect = cell(key).getBoundingClientRect();
  return { clientX: rect.left + 50, clientY: rect.top + 80 };
}
const picked = () => Array.from(document.querySelectorAll('[data-month-day][aria-selected="true"]')).map((el) => el.getAttribute('data-month-day'));

const mouse = { pointerId: 1, pointerType: 'mouse', isPrimary: true, button: 0 };
function drag(from: string, to: string, via: string[] = [], release = true) {
  const grid = cell(from);
  fireEvent.pointerDown(grid, { ...mouse, ...pointOf(from) });
  for (const key of [...via, to]) fireEvent.pointerMove(grid, { ...mouse, ...pointOf(key) });
  if (release) fireEvent.pointerUp(grid, { ...mouse, ...pointOf(to) });
}

beforeAll(() => {
  Element.prototype.setPointerCapture ??= () => {};
  Element.prototype.releasePointerCapture ??= () => {};
});
beforeEach(() => announce.mockClear());
afterEach(() => {
  cleanup();
  document.documentElement.dir = '';
  vi.useRealTimers();
});

describe('Month view: dragging over days', () => {
  it('picks the days in reading order across week rows and creates over them', () => {
    const { props } = renderMonth();
    drag('2026-11-05', '2026-11-10', ['2026-11-06', '2026-11-09'], false);
    // Thursday to next Tuesday, wrapping at the end of the row; the
    // selected day (Wednesday 4th) keeps its own mark.
    expect(picked()).toEqual(['2026-11-04', '2026-11-05', '2026-11-06', '2026-11-07', '2026-11-08', '2026-11-09', '2026-11-10']);
    expect(cell('2026-11-07').className).toContain('bg-primary/15');
    fireEvent.pointerUp(cell('2026-11-05'), { ...mouse, ...pointOf('2026-11-10') });

    expect(props.onCreateRange).toHaveBeenCalledTimes(1);
    expect(props.onCreateRange).toHaveBeenCalledWith(new Date(2026, 10, 5), new Date(2026, 10, 10));
    expect(props.onCreateAllDay).not.toHaveBeenCalled();
  });

  it('works backwards too', () => {
    const { props } = renderMonth();
    drag('2026-11-10', '2026-11-05', ['2026-11-09', '2026-11-06']);
    expect(props.onCreateRange).toHaveBeenCalledWith(new Date(2026, 10, 5), new Date(2026, 10, 10));
  });

  it('mirrors in a right-to-left grid: the day to the left is the next one', () => {
    document.documentElement.dir = 'rtl';
    const { props } = renderMonth();
    // Thursday 5th sits at x 200-300; Saturday 7th to its left at 0-100.
    expect(pointOf('2026-11-07').clientX).toBeLessThan(pointOf('2026-11-05').clientX);
    drag('2026-11-05', '2026-11-07');
    expect(props.onCreateRange).toHaveBeenCalledWith(new Date(2026, 10, 5), new Date(2026, 10, 7));
  });

  it('leaves a click on the empty space of a day to the click: one all-day event there', () => {
    const { props } = renderMonth();
    const day = cell('2026-11-12');
    fireEvent.pointerDown(day, { ...mouse, ...pointOf('2026-11-12') });
    fireEvent.pointerUp(day, { ...mouse, ...pointOf('2026-11-12') });
    fireEvent.click(day);
    expect(props.onCreateRange).not.toHaveBeenCalled();
    expect(props.onCreateAllDay).toHaveBeenCalledWith(new Date(2026, 10, 12));
  });

  it("doesn't count the click that ends a drag as a click on the last day", () => {
    const { props } = renderMonth();
    drag('2026-11-12', '2026-11-13');
    fireEvent.click(cell('2026-11-13'));
    expect(props.onCreateRange).toHaveBeenCalledTimes(1);
    expect(props.onCreateAllDay).not.toHaveBeenCalled();
  });

  it('starts nothing from an event bar, the date number or "+N more"', () => {
    // Six events on the 12th: some go under "+N more".
    const busy = Array.from({ length: 6 }, (_, i) => ({ ...standup, id: `b${i}`, uid: `b${i}`, title: `Busy ${i}`, start: '2026-11-12T00:00:00' }));
    const { props } = renderMonth({ events: [standup, ...busy] });
    const bar = screen.getByRole('button', { name: /Standup/ });
    const dateNumber = cell('2026-11-12').querySelector<HTMLElement>('[data-day-button]')!;
    const more = screen.getByText('events.more');
    for (const target of [bar, dateNumber, more]) {
      fireEvent.pointerDown(target, { ...mouse, ...pointOf('2026-11-05') });
      fireEvent.pointerMove(target, { ...mouse, ...pointOf('2026-11-06') });
      fireEvent.pointerUp(target, { ...mouse, ...pointOf('2026-11-06') });
    }
    expect(props.onCreateRange).not.toHaveBeenCalled();
    expect(picked()).toEqual(['2026-11-04']);
  });

  it('picks nothing where no calendar can take a new event', () => {
    const { props } = renderMonth({ onCreateRange: undefined, onCreateAllDay: undefined });
    drag('2026-11-05', '2026-11-10', ['2026-11-06'], false);
    expect(picked()).toEqual(['2026-11-04']);
    fireEvent.pointerUp(cell('2026-11-05'), { ...mouse, ...pointOf('2026-11-10') });
    expect(props.onOpenDay).not.toHaveBeenCalled();
  });

  it('reads the days out while they are picked', async () => {
    renderMonth();
    drag('2026-11-05', '2026-11-10', [], false);
    expect(announce).toHaveBeenLastCalledWith(
      expect.stringMatching(/^selected_range$/),
      expect.objectContaining({ key: 'calendar-month-selection' }),
    );
  });

  it('marks the days of the quick editor and spans its placeholder over them', () => {
    renderMonth({
      pendingPreview: { start: new Date(2026, 10, 5), end: new Date(2026, 10, 10), title: 'Trip', allDay: true, calendarId: 'cal-1' },
    });
    expect(picked()).toEqual(['2026-11-04', '2026-11-05', '2026-11-06', '2026-11-07', '2026-11-08', '2026-11-09', '2026-11-10']);
    const bars = Array.from(document.querySelectorAll<HTMLElement>('[data-pending-preview]'));
    // Thursday to Sunday in the first row, Monday and Tuesday in the next.
    expect(bars.map((bar) => bar.closest('[data-month-day]')!.getAttribute('data-month-day'))).toEqual(['2026-11-05', '2026-11-09']);
    expect(bars.map((bar) => (bar.parentElement as HTMLElement).style.width)).toEqual(['calc(400% + 2px)', 'calc(200% + 0px)']);
  });
});

describe('Month view: picking days by keyboard', () => {
  const key = (el: HTMLElement, k: string, shiftKey = false) => fireEvent.keyDown(el, { key: k, shiftKey });
  const dateButton = (day: string) => cell(day).querySelector<HTMLElement>('[data-day-button]')!;

  it('grows the selection with Shift+arrows and creates over it with Enter', () => {
    const { props } = renderMonth();
    key(dateButton('2026-11-04'), 'ArrowRight', true);
    key(dateButton('2026-11-05'), 'ArrowDown', true);
    expect(picked()).toEqual(expect.arrayContaining(['2026-11-04', '2026-11-05', '2026-11-08', '2026-11-12']));
    expect(announce).toHaveBeenLastCalledWith('selected_range enter_hint', expect.anything());
    key(dateButton('2026-11-12'), 'Enter');
    expect(props.onCreateRange).toHaveBeenCalledWith(new Date(2026, 10, 4), new Date(2026, 10, 12));
    expect(props.onOpenDay).not.toHaveBeenCalled();
  });

  it('keeps Enter opening the day without a selection, and Escape drops one', () => {
    const { props } = renderMonth();
    key(dateButton('2026-11-04'), 'ArrowRight', true);
    key(dateButton('2026-11-05'), 'Escape');
    expect(picked()).toEqual(['2026-11-04']);
    const enter = fireEvent.keyDown(dateButton('2026-11-05'), { key: 'Enter' });
    expect(enter).toBe(true);
    expect(props.onCreateRange).not.toHaveBeenCalled();
  });

  it('drops the selection on a plain arrow', () => {
    const { props } = renderMonth();
    key(dateButton('2026-11-04'), 'ArrowRight', true);
    key(dateButton('2026-11-05'), 'ArrowRight');
    key(dateButton('2026-11-06'), 'Enter');
    expect(props.onCreateRange).not.toHaveBeenCalled();
  });
});

describe('Month view: picking days on a touch screen', () => {
  const finger = { pointerId: 7, pointerType: 'touch', isPrimary: true, button: 0 };

  it('starts after a long press, then follows the finger', () => {
    vi.useFakeTimers();
    const { props } = renderMonth();
    const start = cell('2026-11-05');
    fireEvent.pointerDown(start, { ...finger, ...pointOf('2026-11-05') });
    act(() => { vi.advanceTimersByTime(500); });
    expect(picked()).toContain('2026-11-05');
    fireEvent.pointerMove(start, { ...finger, ...pointOf('2026-11-12') });
    // The grid doesn't scroll under a finger picking days.
    const move = new Event('touchmove', { cancelable: true, bubbles: true });
    start.dispatchEvent(move);
    expect(move.defaultPrevented).toBe(true);
    fireEvent.pointerUp(start, { ...finger, ...pointOf('2026-11-12') });
    expect(props.onCreateRange).toHaveBeenCalledWith(new Date(2026, 10, 5), new Date(2026, 10, 12));
    // The long press's own menu doesn't open over the new event.
    fireEvent.contextMenu(start);
    expect(props.onContextMenuEmpty).not.toHaveBeenCalled();
  });

  it('lets a swipe scroll: nothing is picked', () => {
    vi.useFakeTimers();
    const { props } = renderMonth();
    const start = cell('2026-11-05');
    fireEvent.pointerDown(start, { ...finger, ...pointOf('2026-11-05') });
    fireEvent.pointerMove(start, { ...finger, clientX: 150, clientY: 140 });
    act(() => { vi.advanceTimersByTime(500); });
    const move = new Event('touchmove', { cancelable: true, bubbles: true });
    start.dispatchEvent(move);
    expect(move.defaultPrevented).toBe(false);
    fireEvent.pointerUp(start, { ...finger, ...pointOf('2026-11-12') });
    expect(picked()).toEqual(['2026-11-04']);
    expect(props.onCreateRange).not.toHaveBeenCalled();
  });

  it('keeps the long-press menu of a single day', () => {
    vi.useFakeTimers();
    const { props } = renderMonth();
    const start = cell('2026-11-05');
    fireEvent.pointerDown(start, { ...finger, ...pointOf('2026-11-05') });
    act(() => { vi.advanceTimersByTime(500); });
    fireEvent.contextMenu(start);
    expect(props.onContextMenuEmpty).not.toHaveBeenCalled();
    fireEvent.pointerUp(start, { ...finger, ...pointOf('2026-11-05') });
    expect(props.onCreateRange).not.toHaveBeenCalled();
    expect(props.onContextMenuEmpty).toHaveBeenCalledWith(expect.anything(), new Date(2026, 10, 5), undefined, true);
  });
});
