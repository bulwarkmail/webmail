import { render, cleanup } from '@testing-library/react';
import { describe, it, expect, vi, afterEach } from 'vitest';
import { CalendarMonthView } from '../calendar-month-view';
import type { Calendar, CalendarEvent } from '@/lib/jmap/types';

// A new event's dashed preview used to sit under the day's last entry. On a
// full day that is below the row of the week, on top of the next week's date.

const calendars = [{ id: 'cal-1', name: 'Work', color: '#123456' }] as unknown as Calendar[];

function events(count: number): CalendarEvent[] {
  return Array.from({ length: count }, (_, i) => ({
    id: `e${i}`,
    '@type': 'Event',
    uid: `e${i}`,
    title: `Event ${i}`,
    start: `2026-09-09T${String(8 + i).padStart(2, '0')}:00:00`,
    duration: 'PT30M',
    showWithoutTime: false,
    calendarIds: { 'cal-1': true },
  })) as unknown as CalendarEvent[];
}

function renderMonth(count: number) {
  return render(
    <CalendarMonthView
      focus={{ date: new Date(2026, 8, 9), nonce: 0 }}
      windowKey="month:2026-09-09"
      rangeStart={new Date(2026, 7, 31)}
      rangeEnd={new Date(2026, 9, 4)}
      selectedDate={new Date(2026, 8, 9)}
      events={events(count)}
      calendars={calendars}
      onSelectDate={vi.fn()}
      onSelectEvent={vi.fn()}
      pendingPreview={{ title: 'New event', start: new Date(2026, 8, 9, 15), end: new Date(2026, 8, 9, 16), allDay: false, calendarId: 'cal-1' }}
    />,
  );
}

describe('CalendarMonthView pending event preview', () => {
  afterEach(cleanup);

  it.each([1, 3, 6, 12])('stays inside its own week with %i events on the day', (count) => {
    renderMonth(count);
    const preview = document.querySelector<HTMLElement>('[data-pending-preview]');
    expect(preview).not.toBeNull();
    const slot = preview!.parentElement!;
    const week = preview!.closest<HTMLElement>('[data-week]')!;
    const bottom = parseFloat(slot.style.top) + parseFloat(slot.style.height);
    expect(bottom).toBeLessThanOrEqual(parseFloat(week.style.minHeight));
  });
});
