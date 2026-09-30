import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import { describe, it, expect, vi, afterEach } from 'vitest';
import { CalendarWeekView } from '../calendar-week-view';
import type { CalendarEvent, Calendar, CalendarTask } from '@/lib/jmap/types';

const calendars = [{ id: 'cal-1', name: 'Work', color: '#123456' }] as unknown as Calendar[];

function makeTask(id: string, due: string, overrides: Partial<CalendarTask> = {}): CalendarTask {
  return {
    id,
    '@type': 'Task',
    uid: id,
    title: 'Task ' + id,
    description: '',
    due,
    start: null,
    duration: null,
    timeZone: null,
    showWithoutTime: true,
    progress: 'needs-action',
    priority: 0,
    privacy: 'public',
    keywords: null,
    categories: null,
    color: null,
    created: null,
    updated: '2026-09-01T00:00:00Z',
    recurrenceRules: null,
    alerts: null,
    relatedTo: null,
    calendarIds: { 'cal-1': true },
    ...overrides,
  };
}

function makeAllDayEvent(id: string, start: string): CalendarEvent {
  return {
    id,
    '@type': 'Event',
    uid: id,
    title: 'Event ' + id,
    start,
    duration: 'P1D',
    showWithoutTime: true,
    calendarIds: { 'cal-1': true },
  } as unknown as CalendarEvent;
}

type Props = React.ComponentProps<typeof CalendarWeekView>;

function renderView(overrides: Partial<Props> = {}) {
  const props: Props = {
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
  return { props, ...render(<CalendarWeekView {...props} />) };
}

function chipSlot(taskId: string): HTMLElement {
  const chip = document.querySelector<HTMLElement>(`[data-calendar-task="${taskId}"]`);
  if (!chip?.parentElement) throw new Error(`no chip for ${taskId}`);
  return chip.parentElement;
}

describe('CalendarWeekView all-day and tasks height cap', () => {
  afterEach(() => {
    cleanup();
  });

  it('stacks tasks directly below events of their own day instead of global allDayRowCount', () => {
    // Monday 2026-09-07 has 2 all-day events
    // Tuesday 2026-09-08 has NO events, but 1 task
    renderView({
      events: [
        makeAllDayEvent('e1', '2026-09-07'),
        makeAllDayEvent('e2', '2026-09-07'),
      ],
      tasks: [
        makeTask('t-tue', '2026-09-08'),
      ],
    });

    // Tuesday's task must start at row 0 (top: 2px), NOT pushed down to row 2 (top: 50px)
    const tueSlot = chipSlot('t-tue');
    expect(tueSlot.style.top).toBe('2px');
  });

  it('caps all-day height to default max rows (3 rows = 76px) and provides an expand toggle when crowded', () => {
    // Monday 2026-09-07 has 5 tasks (rows 0..4)
    renderView({
      tasks: [
        makeTask('t1', '2026-09-07'),
        makeTask('t2', '2026-09-07'),
        makeTask('t3', '2026-09-07'),
        makeTask('t4', '2026-09-07'),
        makeTask('t5', '2026-09-07'),
      ],
    });

    const toggle = screen.getByRole('button', { name: /all-day-expand/i });
    expect(toggle).toBeInTheDocument();
    expect(toggle).toHaveAttribute('aria-expanded', 'false');

    // Default height is capped to 3 rows (3 * 24 + 4 = 76px)
    const allDayGrid = document.querySelector<HTMLElement>('[data-testid="all-day-grid"]');
    expect(allDayGrid).toBeInTheDocument();
    expect(allDayGrid?.style.height).toBe('76px');

    // Click toggle to expand
    fireEvent.click(toggle);
    expect(toggle).toHaveAttribute('aria-expanded', 'true');
    expect(allDayGrid?.style.height).toBe('124px'); // 5 * 24 + 4
  });

  it('sizes the all-day area from the visible week, not from other loaded weeks (#1293)', () => {
    // Three weeks loaded (free scrolling), the focused first week is empty;
    // a crowded day two weeks later must not add height or a toggle here.
    renderView({
      rangeStart: new Date(2026, 8, 7),
      rangeEnd: new Date(2026, 8, 27),
      windowKey: 'week:2026-09-07:3w',
      events: [
        makeAllDayEvent('e1', '2026-09-23'),
        makeAllDayEvent('e2', '2026-09-23'),
        makeAllDayEvent('e3', '2026-09-23'),
        makeAllDayEvent('e4', '2026-09-23'),
      ],
    });

    expect(screen.queryByRole('button', { name: /all-day-expand/i })).toBeNull();
    expect(document.querySelector('[data-testid="all-day-grid"]')).toBeNull();
  });

  it('still sizes the all-day area from entries in the visible week (#1293)', () => {
    renderView({
      rangeStart: new Date(2026, 8, 7),
      rangeEnd: new Date(2026, 8, 27),
      windowKey: 'week:2026-09-07:3w',
      events: [
        makeAllDayEvent('e1', '2026-09-08'),
        makeAllDayEvent('e2', '2026-09-23'),
        makeAllDayEvent('e3', '2026-09-23'),
        makeAllDayEvent('e4', '2026-09-23'),
      ],
    });

    const allDayGrid = document.querySelector<HTMLElement>('[data-testid="all-day-grid"]');
    expect(allDayGrid?.style.height).toBe('28px');
    expect(screen.queryByRole('button', { name: /all-day-expand/i })).toBeNull();
  });

  it('resizes the all-day area when scrolling to a crowded week (#1293)', async () => {
    renderView({
      rangeStart: new Date(2026, 8, 7),
      rangeEnd: new Date(2026, 8, 27),
      windowKey: 'week:2026-09-07:3w',
      events: [
        makeAllDayEvent('e1', '2026-09-23'),
        makeAllDayEvent('e2', '2026-09-23'),
        makeAllDayEvent('e3', '2026-09-23'),
        makeAllDayEvent('e4', '2026-09-23'),
      ],
    });
    expect(document.querySelector('[data-testid="all-day-grid"]')).toBeNull();

    // Scroll the strip to Monday 21 Sep: 14 columns of the measured width
    const strip = document.querySelector<HTMLElement>('[role="grid"]')!;
    const columns = document.querySelector<HTMLElement>('[style*="grid-template-columns"]')!;
    const colWidth = parseInt(/(\d+)px/.exec(columns.style.gridTemplateColumns)![1], 10);
    strip.scrollLeft = 14 * colWidth;
    fireEvent.scroll(strip);
    await new Promise((r) => requestAnimationFrame(() => r(null)));

    const allDayGrid = await screen.findByTestId('all-day-grid');
    expect(allDayGrid.style.height).toBe('76px');
    expect(screen.getByRole('button', { name: /all-day-expand/i })).toBeInTheDocument();
  });
});
