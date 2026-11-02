import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { CalendarWeekView } from '../calendar-week-view';
import { CalendarDayView } from '../calendar-day-view';
import { useSettingsStore } from '@/stores/settings-store';
import { fillHourHeight } from '@/hooks/use-display-hours';
import type { CalendarEvent, Calendar } from '@/lib/jmap/types';

/** The empty hour slots of the time grid (buttons inside the day cells). */
const slots = () => Array.from(document.querySelectorAll<HTMLElement>('[role="button"][data-slot]'));

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
    expect(slots()).toHaveLength(7 * 12);
    expect(screen.getByText('08:00')).toBeInTheDocument();
    expect(screen.queryByText('07:00')).toBeNull();
    expect(screen.queryByText('20:00')).toBeNull();
  });

  it('shows the whole day when the limit is off', () => {
    useSettingsStore.setState({ calendarLimitHours: false });
    renderWeek();
    expect(slots()).toHaveLength(7 * 24);
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

    expect(slots()).toHaveLength(7 * 24);
    expect(eventBlock('early')?.style.top).toBe('360px');
    expect(document.querySelector('[data-hidden-events]')).toBeNull();
    // ...and back to the configured hours
    const toggle = document.querySelector<HTMLElement>('[data-all-hours-toggle]')!;
    expect(toggle).toHaveAttribute('aria-pressed', 'true');
    fireEvent.click(toggle);
    expect(slots()).toHaveLength(7 * 12);
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
    // In the cell of column 5 of 6 (Friday), two columns wide
    const cell = trip.closest('[role="gridcell"]')!;
    expect(Array.from(cell.parentElement!.children).indexOf(cell)).toBe(4);
    expect(trip.style.width).toBe('calc(200% + 0px)');
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
    expect(slots()).toHaveLength(12);
    expect(eventBlock('early')).toBeNull();
    expect(eventBlock('noon')?.style.top).toBe(`${4 * 64}px`);
    expect(document.querySelector('[data-hidden-events="before"]')).toHaveTextContent('1');
  });
});

describe('time grid height (CAL-27)', () => {
  // A tablet-tall pane: the grid's scroll root reports 1100px of room and
  // its sticky header 100px, leaving 1000px for 12 hours.
  beforeEach(() => {
    useSettingsStore.setState(initialSettings, true);
    vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockImplementation(function (this: HTMLElement) {
      return this.getAttribute('role') === 'grid' ? 1100 : 0;
    });
    vi.spyOn(HTMLElement.prototype, 'offsetHeight', 'get').mockImplementation(function (this: HTMLElement) {
      return this.classList.contains('sticky') && this.classList.contains('top-0') ? 100 : 0;
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    cleanup();
  });

  it('stretches the hour rows to fill the pane below a short range', () => {
    renderWeek({ events: [makeEvent('noon', '2026-09-09T12:00:00', 'PT1H')] });
    // floor(1000 / 12) = 83px an hour instead of leaving 280px empty
    expect(slots()[0].style.height).toBe('83px');
    expect(eventBlock('noon')?.style.top).toBe(`${4 * 83}px`);
    expect(eventBlock('noon')?.style.height).toBe('83px');
  });

  it('fits the rows to the pane, shrinking them only a little', () => {
    expect(fillHourHeight(60, 1000, 12)).toBe(83);
    // 59px rows instead of 4px of scrolling
    expect(fillHourHeight(60, 716, 12)).toBe(59);
    // a whole day on a short pane scrolls at the normal height
    expect(fillHourHeight(60, 716, 24)).toBe(60);
    expect(fillHourHeight(60, 0, 12)).toBe(60);
  });

  it('keeps the normal row height when the whole day is shown', () => {
    useSettingsStore.setState({ calendarLimitHours: false });
    renderWeek();
    expect(slots()[0].style.height).toBe('60px');
  });

  it('marks events that run past the visible hours instead of cutting them silently', () => {
    renderWeek({
      events: [
        makeEvent('late', '2026-09-09T19:00:00', 'PT2H'),
        makeEvent('early', '2026-09-09T07:00:00', 'PT2H'),
        makeEvent('inside', '2026-09-09T12:00:00', 'PT1H'),
      ],
    });
    const card = (id: string) => screen.getByText('Event ' + id).closest('button')!;
    expect(card('late')).toHaveAttribute('data-continues-after');
    expect(card('late')).not.toHaveAttribute('data-continues-before');
    expect(card('early')).toHaveAttribute('data-continues-before');
    expect(card('inside')).not.toHaveAttribute('data-continues-after');
    expect(card('inside')).not.toHaveAttribute('data-continues-before');
  });

  it('fills the day view too', () => {
    render(
      <CalendarDayView
        focus={{ date: new Date(2026, 8, 9), nonce: 0 }}
        windowKey="day:2026-09-09"
        rangeStart={new Date(2026, 8, 9)}
        rangeEnd={new Date(2026, 8, 9)}
        selectedDate={new Date(2026, 8, 9)}
        events={[makeEvent('late', '2026-09-09T19:30:00', 'PT2H')]}
        calendars={calendars}
        onSelectEvent={vi.fn()}
        onCreateAtTime={vi.fn()}
      />,
    );
    expect(slots()[0].style.height).toBe('83px');
    expect(screen.getByText('Event late').closest('button')).toHaveAttribute('data-continues-after');
  });
});
