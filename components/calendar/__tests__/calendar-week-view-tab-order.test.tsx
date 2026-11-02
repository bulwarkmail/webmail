import { render, screen } from '@testing-library/react';
import { describe, it, expect, vi } from 'vitest';
import { CalendarWeekView } from '../calendar-week-view';
import { CalendarDayView } from '../calendar-day-view';
import type { Calendar, CalendarEvent } from '@/lib/jmap/types';

/** The empty hour slots of the time grid (buttons inside the day cells). */
const slots = () => Array.from(document.querySelectorAll<HTMLElement>('[role="button"][data-slot]'));

// Tab in the week view walked into the events of the weeks loaded on
// either side and scrolled the grid off its week.

const calendars = [{ id: 'cal-1', name: 'Work', color: '#123456' }] as unknown as Calendar[];

function makeEvent(id: string, title: string, start: string, extra: Partial<CalendarEvent> = {}): CalendarEvent {
  return {
    id, uid: id, '@type': 'Event', title, start, duration: 'PT1H', showWithoutTime: false,
    calendarIds: { 'cal-1': true }, ...extra,
  } as unknown as CalendarEvent;
}

const events = [
  makeEvent('before', 'Last week', '2026-09-02T10:00:00'),
  makeEvent('now', 'This week', '2026-09-09T10:00:00'),
  makeEvent('after', 'Next week', '2026-09-16T10:00:00'),
  makeEvent('trip', 'Trip', '2026-09-03T00:00:00', { showWithoutTime: true, duration: 'P1D' }),
  makeEvent('fair', 'Fair', '2026-09-08T00:00:00', { showWithoutTime: true, duration: 'P1D' }),
];

const tabbable = (name: RegExp) => screen.getByRole('button', { name }).tabIndex >= 0;

describe('tab order of the week view', () => {
  it('leaves the events of the weeks on either side out of the tab order', () => {
    render(
      <CalendarWeekView
        focus={{ date: new Date(2026, 8, 9), nonce: 0 }}
        windowKey="week:2026-08-31"
        // Three weeks loaded: 31 Aug to 20 Sep, the middle one in view.
        rangeStart={new Date(2026, 7, 31)}
        rangeEnd={new Date(2026, 8, 20)}
        selectedDate={new Date(2026, 8, 9)}
        events={events}
        calendars={calendars}
        onSelectDate={vi.fn()}
        onSelectEvent={vi.fn()}
        onCreateAtTime={vi.fn()}
      />,
    );
    expect(tabbable(/^This week/)).toBe(true);
    expect(tabbable(/^Fair/)).toBe(true);
    expect(tabbable(/^Last week/)).toBe(false);
    expect(tabbable(/^Next week/)).toBe(false);
    expect(tabbable(/^Trip/)).toBe(false);
  });

  it('keeps the grid tab stop on a day in view when the selected day is scrolled away', () => {
    render(
      <CalendarWeekView
        focus={{ date: new Date(2026, 8, 9), nonce: 0 }}
        windowKey="week:2026-08-31"
        rangeStart={new Date(2026, 7, 31)}
        rangeEnd={new Date(2026, 8, 20)}
        selectedDate={new Date(2026, 8, 2)}
        events={[]}
        calendars={calendars}
        onSelectDate={vi.fn()}
        onSelectEvent={vi.fn()}
        onCreateAtTime={vi.fn()}
      />,
    );
    const stops = slots().filter((cell) => cell.tabIndex === 0);
    expect(stops).toHaveLength(1);
    expect(stops[0].getAttribute('data-slot')).toMatch(/^2026-09-07T/);
  });

  it('does the same in the day view', () => {
    render(
      <CalendarDayView
        focus={{ date: new Date(2026, 8, 9), nonce: 0 }}
        windowKey="day:2026-09-08"
        rangeStart={new Date(2026, 8, 8)}
        rangeEnd={new Date(2026, 8, 10)}
        selectedDate={new Date(2026, 8, 9)}
        events={[makeEvent('mon', 'Monday', '2026-09-08T10:00:00'), makeEvent('tue', 'Tuesday', '2026-09-09T10:00:00')]}
        calendars={calendars}
        onSelectEvent={vi.fn()}
        onCreateAtTime={vi.fn()}
      />,
    );
    expect(tabbable(/^Tuesday/)).toBe(true);
    expect(tabbable(/^Monday/)).toBe(false);
  });
});
