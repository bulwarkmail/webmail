import { render, fireEvent, cleanup, act } from '@testing-library/react';
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { CalendarWeekView } from '../calendar-week-view';
import { CalendarDayView } from '../calendar-day-view';
import type { Calendar } from '@/lib/jmap/types';

// #1874: a click in the lower half of an hour started the new event on the
// full hour all the same.

const calendars = [{ id: 'cal-1', name: 'Work', color: '#123456' }] as unknown as Calendar[];

/** The 11:00 slot of 9 September, laid out 60 px tall from y = 600. */
function slotAt11(): HTMLElement {
  const slot = document.querySelector<HTMLElement>('[data-slot="2026-09-09T11"]');
  if (!slot) throw new Error('no 11:00 slot');
  slot.getBoundingClientRect = () => ({ top: 600, bottom: 660, height: 60, left: 0, right: 100, width: 100, x: 0, y: 600, toJSON: () => ({}) });
  return slot;
}

function renderWeek(onCreateAtTime = vi.fn()) {
  render(
    <CalendarWeekView
      focus={{ date: new Date(2026, 8, 9), nonce: 0 }}
      windowKey="week:2026-09-07"
      rangeStart={new Date(2026, 8, 7)}
      rangeEnd={new Date(2026, 8, 13)}
      selectedDate={new Date(2026, 8, 9)}
      events={[]}
      calendars={calendars}
      onSelectDate={vi.fn()}
      onSelectEvent={vi.fn()}
      onCreateAtTime={onCreateAtTime}
    />,
  );
  return onCreateAtTime;
}

function renderDay(onCreateAtTime = vi.fn()) {
  render(
    <CalendarDayView
      focus={{ date: new Date(2026, 8, 9), nonce: 0 }}
      windowKey="day:2026-09-09"
      rangeStart={new Date(2026, 8, 9)}
      rangeEnd={new Date(2026, 8, 9)}
      selectedDate={new Date(2026, 8, 9)}
      events={[]}
      calendars={calendars}
      onSelectEvent={vi.fn()}
      onCreateAtTime={onCreateAtTime}
    />,
  );
  return onCreateAtTime;
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => {
  vi.useRealTimers();
  cleanup();
});

describe('clicking an empty hour (#1874)', () => {
  it('starts the event at half past in the lower half of the hour, in the week view', () => {
    const onCreateAtTime = renderWeek();
    fireEvent.click(slotAt11(), { clientY: 645 });
    act(() => vi.advanceTimersByTime(300));
    expect(onCreateAtTime).toHaveBeenCalledTimes(1);
    expect(onCreateAtTime.mock.calls[0][0]).toEqual(new Date(2026, 8, 9, 11, 30));
  });

  it('keeps the full hour in the upper half', () => {
    const onCreateAtTime = renderWeek();
    fireEvent.click(slotAt11(), { clientY: 610 });
    act(() => vi.advanceTimersByTime(300));
    expect(onCreateAtTime.mock.calls[0][0]).toEqual(new Date(2026, 8, 9, 11, 0));
  });

  it('starts at half past on a double click in the lower half, in the day view', () => {
    const onCreateAtTime = renderDay();
    const slot = slotAt11();
    fireEvent.click(slot, { clientY: 650 });
    fireEvent.click(slot, { clientY: 650 });
    fireEvent.doubleClick(slot, { clientY: 650 });
    act(() => vi.advanceTimersByTime(300));
    expect(onCreateAtTime).toHaveBeenCalledTimes(1);
    expect(onCreateAtTime.mock.calls[0][0]).toEqual(new Date(2026, 8, 9, 11, 30));
  });
});
