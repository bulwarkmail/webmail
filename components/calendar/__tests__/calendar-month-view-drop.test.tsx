import { render, fireEvent, cleanup } from '@testing-library/react';
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { CalendarMonthView } from '../calendar-month-view';
import { useCalendarStore } from '@/stores/calendar-store';
import { useAuthStore } from '@/stores/auth-store';
import type { CalendarEvent, Calendar } from '@/lib/jmap/types';

// #1119: dropping an event on another day of the month grid moves it there
// at the same time of day. An all-day event keeps a full LocalDateTime
// start - Stalwart drops a date-only one and leaves the event without a
// start, so it vanished from the calendar.

const calendars = [{ id: 'cal-1', name: 'Work', color: '#123456' }] as unknown as Calendar[];

function makeEvent(id: string, overrides: Partial<CalendarEvent>): CalendarEvent {
  return {
    id,
    '@type': 'Event',
    uid: id,
    title: 'Event ' + id,
    calendarIds: { 'cal-1': true },
    ...overrides,
  } as unknown as CalendarEvent;
}

function renderView(events: CalendarEvent[]) {
  return render(
    <CalendarMonthView
      focus={{ date: new Date(2026, 8, 9), nonce: 0 }}
      windowKey="month:2026-09-09"
      // Monday 28 Sep to Sunday 4 Oct.
      rangeStart={new Date(2026, 8, 28)}
      rangeEnd={new Date(2026, 9, 4)}
      selectedDate={new Date(2026, 8, 30)}
      events={events}
      calendars={calendars}
      onSelectDate={vi.fn()}
      onSelectEvent={vi.fn()}
    />,
  );
}

function dropOn(dayIndex: number, event: CalendarEvent) {
  const cell = document.querySelectorAll<HTMLElement>('[data-week="2026-09-28"] [role="gridcell"]')[dayIndex];
  const json = JSON.stringify({ type: 'calendar-event', eventId: event.id, originalStart: event.start });
  fireEvent.drop(cell, {
    dataTransfer: { types: ['application/x-calendar-event'], getData: () => json },
  });
}

describe('CalendarMonthView drop', () => {
  const updateEvent = vi.fn().mockResolvedValue(undefined);

  beforeEach(() => {
    updateEvent.mockClear();
    useAuthStore.setState({ client: {} as never });
  });

  afterEach(() => {
    cleanup();
    useCalendarStore.setState({ events: [] });
  });

  it('moves an all-day event with a full start, not a bare date', () => {
    const event = makeEvent('a', { start: '2026-10-02T00:00:00', duration: 'P1D', showWithoutTime: true });
    useCalendarStore.setState({ events: [event], updateEvent });
    renderView([event]);

    dropOn(3, event); // Thursday 1 Oct

    expect(updateEvent).toHaveBeenCalledWith(expect.anything(), 'a', { start: '2026-10-01T00:00:00' }, undefined);
  });

  it('leaves an all-day event dropped on its own day alone', () => {
    const event = makeEvent('a', { start: '2026-10-02T00:00:00', duration: 'P1D', showWithoutTime: true });
    useCalendarStore.setState({ events: [event], updateEvent });
    renderView([event]);

    dropOn(4, event); // Friday 2 Oct

    expect(updateEvent).not.toHaveBeenCalled();
  });

  it('keeps the time of day of a timed event', () => {
    const event = makeEvent('t', { start: '2026-10-02T17:30:00', duration: 'PT1H', timeZone: 'Europe/Berlin' });
    useCalendarStore.setState({ events: [event], updateEvent });
    renderView([event]);

    dropOn(3, event);

    expect(updateEvent).toHaveBeenCalledWith(expect.anything(), 't', { start: '2026-10-01T17:30:00' }, undefined);
  });
});
