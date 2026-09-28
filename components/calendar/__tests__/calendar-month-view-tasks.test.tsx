import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import { describe, it, expect, vi, afterEach } from 'vitest';
import { CalendarMonthView } from '../calendar-month-view';
import type { CalendarEvent, Calendar, CalendarTask } from '@/lib/jmap/types';

// #1107: with "Show tasks on calendar" on, the month view shows each task
// on its due day, below that day's events, and lets it be completed or
// opened in the task editor.

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

type Props = React.ComponentProps<typeof CalendarMonthView>;

function renderView(overrides: Partial<Props> = {}) {
  const props: Props = {
    focus: { date: new Date(2026, 8, 9), nonce: 0 },
    windowKey: 'month:2026-09-09',
    // Monday 31 Aug to Sunday 4 Oct: the September grid.
    rangeStart: new Date(2026, 7, 31),
    rangeEnd: new Date(2026, 9, 4),
    selectedDate: new Date(2026, 8, 9),
    events: [],
    calendars,
    onSelectDate: vi.fn(),
    onSelectEvent: vi.fn(),
    ...overrides,
  };
  return { props, ...render(<CalendarMonthView {...props} />) };
}

function chipSlot(taskId: string): HTMLElement {
  const chip = document.querySelector<HTMLElement>(`[data-calendar-task="${taskId}"]`);
  if (!chip?.parentElement) throw new Error(`no chip for ${taskId}`);
  return chip.parentElement;
}

describe('CalendarMonthView tasks', () => {
  afterEach(() => {
    cleanup();
  });

  it('shows a task on its due day, below that day\'s events', () => {
    renderView({
      events: [makeAllDayEvent('e1', '2026-09-10')],
      tasks: [
        makeTask('thu', '2026-09-10'),
        makeTask('fri', '2026-09-11T09:00:00', { showWithoutTime: false }),
      ],
    });

    expect(screen.getByText('Task thu')).toBeInTheDocument();
    expect(screen.getByText('Task fri')).toBeInTheDocument();

    // Thursday is the fourth column of the week starting Monday 7 Sep and
    // already has an event in row 0; Friday has no events.
    // (jsdom rounds the calc() percentage.)
    const thu = chipSlot('thu');
    expect(thu.style.left).toMatch(/^calc\(42\.857\d*% \+ 1px\)$/);
    expect(thu.style.top).toBe('22px');
    const fri = chipSlot('fri');
    expect(fri.style.left).toMatch(/^calc\(57\.142\d*% \+ 1px\)$/);
    expect(fri.style.top).toBe('0px');
  });

  it('grows the week row to fit a crowded day', () => {
    renderView({
      events: [makeAllDayEvent('e1', '2026-09-10')],
      tasks: ['a', 'b', 'c'].map((id) => makeTask(id, '2026-09-10')),
    });
    const row = document.querySelector<HTMLElement>('[data-week="2026-09-07"]');
    // overlay offset 30 + 4, one event row and three task rows of 22px, 8 below.
    expect(row?.style.minHeight).toBe(`${30 + 4 + 4 * 22 + 8}px`);
    expect(chipSlot('c').style.top).toBe(`${3 * 22}px`);
  });

  it('toggles completion from the circle and opens the editor from the title', () => {
    const onToggleTaskComplete = vi.fn();
    const onSelectTask = vi.fn();
    const task = makeTask('t1', '2026-09-10');
    const { props } = renderView({ tasks: [task], onToggleTaskComplete, onSelectTask });

    fireEvent.click(screen.getByRole('button', { name: 'tasks.mark_complete' }));
    expect(onToggleTaskComplete).toHaveBeenCalledWith(task);
    expect(onSelectTask).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole('button', { name: 'Task t1' }));
    expect(onSelectTask).toHaveBeenCalledWith(task);
    expect(onToggleTaskComplete).toHaveBeenCalledTimes(1);
    expect(props.onSelectDate).not.toHaveBeenCalled();
  });

  it('marks completed tasks and offers to reopen them', () => {
    renderView({ tasks: [makeTask('done', '2026-09-10', { progress: 'completed' })] });
    expect(screen.getByRole('button', { name: 'tasks.mark_incomplete' })).toBeInTheDocument();
    expect(screen.getByText('Task done')).toHaveClass('line-through');
  });

  it('shows no task chips when no tasks are passed', () => {
    renderView({ events: [makeAllDayEvent('e1', '2026-09-10')] });
    expect(document.querySelector('[data-calendar-task]')).toBeNull();
  });

  it('shows tasks as rings next to the event dots on mobile', () => {
    renderView({
      isMobile: true,
      events: [makeAllDayEvent('e1', '2026-09-10')],
      tasks: [makeTask('t1', '2026-09-10')],
    });
    const ring = document.querySelector<HTMLElement>('[data-calendar-task="t1"]');
    expect(ring?.tagName).toBe('SPAN');
    expect(ring).toHaveClass('border');
    expect(screen.queryByText('Task t1')).toBeNull();
  });
});
