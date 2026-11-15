import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { CalendarAgendaView } from '../calendar-agenda-view';
import type { CalendarEvent, Calendar } from '@/lib/jmap/types';

// #1715: an agenda row spans the whole list. The event's card opens beside
// the rect it is given, and beside a full-width row there is no room on the
// right, so it opened over the date column on the far left. A click now hands
// the card the pointer's position; a key press the row's start, just below it.

vi.mock('@/hooks/use-display-date-formatter', () => ({
  useDisplayDateFormatter: () => ({ dateTime: (d: Date) => d.toISOString().slice(0, 10) }),
}));

class FakeIntersectionObserver {
  observe() {}
  disconnect() {}
  unobserve() {}
}

const calendars = [{ id: 'cal-1', name: 'Work', color: '#123456' }] as unknown as Calendar[];
const event = {
  id: 'e1', '@type': 'Event', uid: 'e1', title: 'Planning', start: '2026-09-09T14:00:00',
  duration: 'PT1H', showWithoutTime: false, calendarIds: { 'cal-1': true },
} as unknown as CalendarEvent;

// The row as wide as the list, from the date column to the window's edge.
const ROW = { x: 250, y: 100, left: 250, top: 100, right: 1400, bottom: 140, width: 1150, height: 40, toJSON: () => ({}) } as DOMRect;

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date(2026, 8, 9, 10, 0, 0));
  vi.stubGlobal('IntersectionObserver', FakeIntersectionObserver);
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

function renderRow() {
  const onSelectEvent = vi.fn();
  const onHoverEvent = vi.fn();
  render(
    <CalendarAgendaView
      focus={{ date: new Date(2026, 8, 9), nonce: 0 }}
      windowKey="agenda:2026-09-09"
      events={[event]}
      calendars={calendars}
      rangeStart={new Date(2026, 8, 9)}
      rangeEnd={new Date(2026, 9, 9)}
      onSelectEvent={onSelectEvent}
      onHoverEvent={onHoverEvent}
    />,
  );
  const row = screen.getByText('Planning').closest('button')!;
  vi.spyOn(row, 'getBoundingClientRect').mockReturnValue(ROW);
  return { row, onSelectEvent, onHoverEvent };
}

describe('agenda event card position (#1715)', () => {
  it('opens the card at the click, not beside the whole row', () => {
    const { row, onSelectEvent } = renderRow();
    fireEvent.click(row, { detail: 1, clientX: 700, clientY: 120 });
    const rect = onSelectEvent.mock.calls[0][1] as DOMRect;
    expect([rect.left, rect.top, rect.width, rect.height]).toEqual([700, 120, 0, 0]);
  });

  it('opens the hover preview at the pointer too', () => {
    const { row, onHoverEvent } = renderRow();
    fireEvent.mouseEnter(row, { clientX: 640, clientY: 110 });
    const rect = onHoverEvent.mock.calls[0][1] as DOMRect;
    expect([rect.left, rect.top]).toEqual([640, 110]);
  });

  it('opens it below the row’s start from the keyboard', () => {
    const { row, onSelectEvent } = renderRow();
    fireEvent.click(row, { detail: 0 });
    const rect = onSelectEvent.mock.calls[0][1] as DOMRect;
    expect([rect.left, rect.top, rect.width]).toEqual([250, 140, 0]);
  });
});
