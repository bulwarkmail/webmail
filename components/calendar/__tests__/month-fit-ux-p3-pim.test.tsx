import { render, screen, cleanup } from '@testing-library/react';
import { describe, it, expect, vi, afterEach } from 'vitest';
import { CalendarMonthView } from '../calendar-month-view';
import type { Calendar, CalendarEvent } from '@/lib/jmap/types';

// pim-p3-3: a full day gave its last row to "+n more" though the row could
// hold an event, and an event over several days was hidden on every day
// when one of them was full, so a just-created three-day event showed
// nowhere. "+n more" now sits beside the date, every row holds an entry,
// and the event created last takes its week's top row and is marked.

const calendars = [{ id: 'cal-1', name: 'Work', color: '#123456' }] as unknown as Calendar[];

function allDay(id: string, start: string, days = 1): CalendarEvent {
  return {
    id, '@type': 'Event', uid: id, title: 'Event ' + id, start, duration: `P${days}D`, showWithoutTime: true,
    calendarIds: { 'cal-1': true },
  } as unknown as CalendarEvent;
}

type Props = React.ComponentProps<typeof CalendarMonthView>;

function renderView(overrides: Partial<Props> = {}) {
  // jsdom measures no pane: a week keeps its 146px minimum, room for four rows.
  return render(
    <CalendarMonthView
      focus={{ date: new Date(2026, 8, 9), nonce: 0 }}
      windowKey="month:2026-09-09"
      rangeStart={new Date(2026, 7, 31)}
      rangeEnd={new Date(2026, 9, 4)}
      selectedDate={new Date(2026, 8, 9)}
      events={[]}
      calendars={calendars}
      onSelectDate={vi.fn()}
      onSelectEvent={vi.fn()}
      {...overrides}
    />,
  );
}

afterEach(cleanup);

describe('month view: as many entries as fit (pim-p3-3)', () => {
  it('fills every row of a full day and puts "+n more" beside the date', () => {
    renderView({ events: ['a', 'b', 'c', 'd', 'e'].map((id) => allDay(id, '2026-09-10')) });
    for (const id of ['a', 'b', 'c', 'd']) expect(screen.getByText(`Event ${id}`)).toBeInTheDocument();
    expect(screen.queryByText('Event e')).toBeNull();
    const more = screen.getByRole('button', { name: 'events.more' });
    expect(more.parentElement?.style.top).toBe('4px');
  });

  it('shows a just-created event over several days, marked, though its first day is full', () => {
    // Four events from Monday to Thursday fill Thursday's rows; the new one runs Thursday to Saturday.
    const long = ['a', 'b', 'c', 'd'].map((id) => allDay(id, '2026-09-07', 4));
    const created = { ...allDay('n', '2026-09-10', 3), title: 'Just made' } as CalendarEvent;
    renderView({ events: [...long, created], recentEventId: 'n', highlightEventId: 'n' });
    const bar = screen.getByText('Just made');
    expect(bar.closest('[data-just-saved]')).not.toBeNull();
  });
});
