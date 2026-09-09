import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { CalendarAgendaView } from '../calendar-agenda-view';
import type { CalendarEvent, Calendar } from '@/lib/jmap/types';

// The agenda is an infinite list: a "show earlier" trigger at the top, a
// sentinel at the bottom that widens the window when it scrolls into view,
// and a "Today" anchor row only while today is part of the loaded window.

vi.mock('@/hooks/use-display-date-formatter', () => ({
  useDisplayDateFormatter: () => ({ dateTime: (d: Date) => d.toISOString().slice(0, 10) }),
}));

type IOCallback = (entries: Array<{ isIntersecting: boolean }>) => void;
let observerCallbacks: IOCallback[] = [];
let observed: Element[] = [];

class FakeIntersectionObserver {
  constructor(cb: IOCallback) { observerCallbacks.push(cb); }
  observe(el: Element) { observed.push(el); }
  disconnect() {}
  unobserve() {}
}

const calendars = [{ id: 'cal-1', name: 'Work', color: '#123456' }] as unknown as Calendar[];

function makeEvent(id: string, start: string): CalendarEvent {
  return {
    id,
    '@type': 'Event',
    uid: id,
    title: 'Event ' + id,
    start,
    duration: 'PT1H',
    showWithoutTime: false,
    calendarIds: { 'cal-1': true },
  } as unknown as CalendarEvent;
}

function renderView(overrides: Partial<React.ComponentProps<typeof CalendarAgendaView>> = {}) {
  const props: React.ComponentProps<typeof CalendarAgendaView> = {
    selectedDate: new Date(2026, 8, 9),
    events: [],
    calendars,
    rangeStart: new Date(2026, 8, 9),
    rangeEnd: new Date(2026, 9, 9),
    onSelectEvent: vi.fn(),
    ...overrides,
  };
  return render(<CalendarAgendaView {...props} />);
}

describe('CalendarAgendaView infinite scroll', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date(2026, 8, 9, 10, 0, 0));
    observerCallbacks = [];
    observed = [];
    vi.stubGlobal('IntersectionObserver', FakeIntersectionObserver);
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it('loads earlier days from the top button, once per fetch', () => {
    const onExtendPast = vi.fn();
    const { rerender } = renderView({ onExtendPast });

    fireEvent.click(screen.getByText('events.agenda_show_earlier'));
    expect(onExtendPast).toHaveBeenCalledTimes(1);

    // A second request while the first is still outstanding is ignored ...
    fireEvent.click(screen.getByText('events.agenda_show_earlier'));
    expect(onExtendPast).toHaveBeenCalledTimes(1);

    // ... until the fetch has come and gone.
    rerender(<CalendarAgendaView selectedDate={new Date(2026, 8, 9)} events={[]} calendars={calendars}
      rangeStart={new Date(2026, 7, 10)} rangeEnd={new Date(2026, 9, 9)} onSelectEvent={vi.fn()}
      onExtendPast={onExtendPast} isLoading />);
    rerender(<CalendarAgendaView selectedDate={new Date(2026, 8, 9)} events={[]} calendars={calendars}
      rangeStart={new Date(2026, 7, 10)} rangeEnd={new Date(2026, 9, 9)} onSelectEvent={vi.fn()}
      onExtendPast={onExtendPast} isLoading={false} />);
    fireEvent.click(screen.getByText('events.agenda_show_earlier'));
    expect(onExtendPast).toHaveBeenCalledTimes(2);
  });

  it('loads earlier days when wheeling up while already at the top', () => {
    const onExtendPast = vi.fn();
    const { container } = renderView({ onExtendPast });
    const scroller = container.firstElementChild as HTMLElement;

    fireEvent.wheel(scroller, { deltaY: 40 });
    expect(onExtendPast).not.toHaveBeenCalled();

    fireEvent.wheel(scroller, { deltaY: -40 });
    expect(onExtendPast).toHaveBeenCalledTimes(1);
  });

  it('shows the window start instead of the button once the past limit is reached', () => {
    renderView({ onExtendPast: undefined });
    expect(screen.queryByText('events.agenda_show_earlier')).toBeNull();
    expect(screen.getByText('events.agenda_range_start')).toBeInTheDocument();
  });

  it('widens the future when the bottom sentinel becomes visible, once per fetch', () => {
    const onExtendFuture = vi.fn();
    const base = {
      selectedDate: new Date(2026, 8, 9), events: [], calendars, onSelectEvent: vi.fn(),
      rangeStart: new Date(2026, 8, 9), onExtendFuture,
    };
    const { rerender } = render(<CalendarAgendaView {...base} rangeEnd={new Date(2026, 9, 9)} />);

    // Before the first fetch for this window has completed, the rows on
    // screen are stale (or absent) and a visible sentinel must not grow it.
    expect(observed).toHaveLength(0);
    rerender(<CalendarAgendaView {...base} rangeEnd={new Date(2026, 9, 9)} isLoading />);
    rerender(<CalendarAgendaView {...base} rangeEnd={new Date(2026, 9, 9)} isLoading={false} />);

    expect(observed).toContain(screen.getByTestId('agenda-bottom-sentinel'));
    observerCallbacks.at(-1)?.([{ isIntersecting: true }]);
    expect(onExtendFuture).toHaveBeenCalledTimes(1);

    // The window already grew but the fetch has not flipped the loading flag
    // yet: a re-created observer that still sees the sentinel must not
    // extend a second time.
    rerender(<CalendarAgendaView {...base} rangeEnd={new Date(2026, 10, 9)} />);
    observerCallbacks.at(-1)?.([{ isIntersecting: true }]);
    expect(onExtendFuture).toHaveBeenCalledTimes(1);

    // Once that fetch has finished, the next sighting extends again.
    rerender(<CalendarAgendaView {...base} rangeEnd={new Date(2026, 10, 9)} isLoading />);
    rerender(<CalendarAgendaView {...base} rangeEnd={new Date(2026, 10, 9)} isLoading={false} />);
    observerCallbacks.at(-1)?.([{ isIntersecting: true }]);
    expect(onExtendFuture).toHaveBeenCalledTimes(2);
  });

  it('does not observe the sentinel while a fetch is in flight or at the future limit', () => {
    renderView({ onExtendFuture: vi.fn(), isLoading: true });
    expect(observerCallbacks).toHaveLength(0);
    cleanup();

    renderView({ onExtendFuture: undefined });
    expect(observerCallbacks).toHaveLength(0);
    expect(screen.getByText('events.agenda_range_end')).toBeInTheDocument();
  });

  it('only anchors a "Today" row when today lies inside the loaded window', () => {
    renderView();
    expect(screen.getByText('events.today_header')).toBeInTheDocument();
    cleanup();

    renderView({
      selectedDate: new Date(2026, 0, 1),
      rangeStart: new Date(2026, 0, 1),
      rangeEnd: new Date(2026, 1, 1),
      events: [makeEvent('a', '2026-01-05T09:00:00')],
    });
    expect(screen.queryByText('events.today_header')).toBeNull();
    expect(screen.getByText('Event a')).toBeInTheDocument();
  });

  it('groups events by day in chronological order', () => {
    renderView({
      events: [makeEvent('later', '2026-09-20T09:00:00'), makeEvent('sooner', '2026-09-12T09:00:00')],
    });
    const titles = screen.getAllByText(/^Event /).map((el) => el.textContent);
    expect(titles).toEqual(['Event sooner', 'Event later']);
  });
});
