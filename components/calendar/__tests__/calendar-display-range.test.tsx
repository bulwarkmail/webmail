import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { CalendarWeekView } from '../calendar-week-view';
import { CalendarDayView } from '../calendar-day-view';
import { useSettingsStore } from '@/stores/settings-store';
import type { CalendarEvent, Calendar } from '@/lib/jmap/types';

const calendars = [{ id: 'cal-1', name: 'Work', color: '#123456' }] as unknown as Calendar[];

function makeEvent(id: string, start: string, duration: string, showWithoutTime = false): CalendarEvent {
  return {
    id,
    '@type': 'Event',
    uid: id,
    title: 'Event ' + id,
    start,
    duration,
    showWithoutTime,
    calendarIds: { 'cal-1': true },
  } as unknown as CalendarEvent;
}

type WeekProps = React.ComponentProps<typeof CalendarWeekView>;

function renderWeek(overrides: Partial<WeekProps> = {}) {
  const props: WeekProps = {
    focus: { date: new Date(2026, 8, 9), nonce: 0 },
    windowKey: 'week:2026-09-07',
    // Monday 7 Sep to Sunday 13 Sep 2026
    rangeStart: new Date(2026, 8, 7),
    rangeEnd: new Date(2026, 8, 13),
    selectedDate: new Date(2026, 8, 9),
    events: [],
    calendars,
    onSelectDate: vi.fn(),
    onSelectEvent: vi.fn(),
    onCreateAtTime: vi.fn(),
    ...overrides,
  };
  return render(<CalendarWeekView {...props} />);
}

function eventBlock(id: string): HTMLElement | null {
  // The positioned wrapper around the card, not the card itself
  return screen.queryByText('Event ' + id)?.closest<HTMLElement>('[class*="group/event"]') ?? null;
}

const initialSettings = useSettingsStore.getState();

describe('calendar display hours and working days (#1164)', () => {
  beforeEach(() => {
    useSettingsStore.setState(initialSettings, true);
  });

  afterEach(() => {
    cleanup();
  });

  it('shows 08:00 to 20:00 by default', () => {
    renderWeek();
    expect(screen.getAllByRole('gridcell')).toHaveLength(7 * 12);
    expect(screen.getByText('08:00')).toBeInTheDocument();
    expect(screen.queryByText('07:00')).toBeNull();
    expect(screen.queryByText('20:00')).toBeNull();
  });

  it('shows the whole day when the limit is off', () => {
    useSettingsStore.setState({ calendarLimitHours: false });
    renderWeek();
    expect(screen.getAllByRole('gridcell')).toHaveLength(7 * 24);
    expect(document.querySelector('[data-all-hours-toggle]')).toBeNull();
  });

  it('positions events from the first visible hour and cuts them at the edges', () => {
    renderWeek({
      events: [
        makeEvent('morning', '2026-09-09T07:00:00', 'PT2H'),
        makeEvent('noon', '2026-09-09T12:00:00', 'PT1H'),
      ],
    });
    // 07:00-09:00 shows as 08:00-09:00 at the top of the grid
    expect(eventBlock('morning')?.style.top).toBe('0px');
    expect(eventBlock('morning')?.style.height).toBe('60px');
    expect(eventBlock('noon')?.style.top).toBe('240px');
  });

  it('marks hidden events and shows the whole day from the marker', () => {
    renderWeek({
      events: [
        makeEvent('early', '2026-09-09T06:00:00', 'PT1H'),
        makeEvent('late', '2026-09-09T21:00:00', 'PT1H'),
        makeEvent('later', '2026-09-09T22:00:00', 'PT1H'),
      ],
    });
    expect(eventBlock('early')).toBeNull();
    const before = document.querySelector<HTMLElement>('[data-hidden-events="before"]');
    const after = document.querySelector<HTMLElement>('[data-hidden-events="after"]');
    expect(before).toHaveTextContent('1');
    expect(after).toHaveTextContent('2');

    fireEvent.click(before!);

    expect(screen.getAllByRole('gridcell')).toHaveLength(7 * 24);
    expect(eventBlock('early')?.style.top).toBe('360px');
    expect(document.querySelector('[data-hidden-events]')).toBeNull();
    // ...and back to the configured hours
    const toggle = document.querySelector<HTMLElement>('[data-all-hours-toggle]')!;
    expect(toggle).toHaveAttribute('aria-pressed', 'true');
    fireEvent.click(toggle);
    expect(screen.getAllByRole('gridcell')).toHaveLength(7 * 12);
  });

  it('leaves non-working days out of the week view', () => {
    useSettingsStore.setState({ calendarHideNonWorkingDays: true, calendarWorkingDays: [1, 2, 3, 4, 5] });
    renderWeek({
      events: [
        makeEvent('weekend', '2026-09-12T10:00:00', 'PT1H'),
        // Friday to Monday, all day: still drawn on the Friday column
        makeEvent('trip', '2026-09-11', 'P4D', true),
      ],
      rangeEnd: new Date(2026, 8, 14),
    });
    const headers = screen.getAllByRole('columnheader');
    expect(headers.map((h) => h.getAttribute('data-day'))).toEqual([
      '2026-09-07', '2026-09-08', '2026-09-09', '2026-09-10', '2026-09-11', '2026-09-14',
    ]);
    expect(eventBlock('weekend')).toBeNull();
    const trip = screen.getByText('Event trip').closest<HTMLElement>('.absolute')!;
    // Column 5 of 6, two columns wide (jsdom rounds the percentages)
    expect(trip.style.left).toBe('calc(66.6667% + 1px)');
    expect(trip.style.width).toBe('calc(33.3333% - 2px)');
  });

  it('applies the visible hours to the day view too', () => {
    render(
      <CalendarDayView
        focus={{ date: new Date(2026, 8, 9), nonce: 0 }}
        windowKey="day:2026-09-09"
        rangeStart={new Date(2026, 8, 9)}
        rangeEnd={new Date(2026, 8, 9)}
        selectedDate={new Date(2026, 8, 9)}
        events={[
          makeEvent('early', '2026-09-09T06:00:00', 'PT1H'),
          makeEvent('noon', '2026-09-09T12:00:00', 'PT1H'),
        ]}
        calendars={calendars}
        onSelectEvent={vi.fn()}
        onCreateAtTime={vi.fn()}
      />,
    );
    expect(screen.getAllByRole('gridcell')).toHaveLength(12);
    expect(eventBlock('early')).toBeNull();
    expect(eventBlock('noon')?.style.top).toBe(`${4 * 64}px`);
    expect(document.querySelector('[data-hidden-events="before"]')).toHaveTextContent('1');
  });
});
