import { render, screen, cleanup } from '@testing-library/react';
import { describe, it, expect, vi, afterEach } from 'vitest';
import { CalendarMonthView } from '../calendar-month-view';
import { CalendarWeekView } from '../calendar-week-view';
import type { Calendar, CalendarTask } from '@/lib/jmap/types';
import { createRecurrenceRule } from '@/lib/recurrence-rule';

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

describe('Calendar views recurring tasks expansion', () => {
  afterEach(() => {
    cleanup();
  });

  it('renders recurring tasks across multiple days in CalendarMonthView', () => {
    const recurringTask = makeTask('daily-task', '2026-09-14', {
      title: 'Daily Standup',
      recurrenceRules: [createRecurrenceRule('daily')],
    });

    render(
      <CalendarMonthView
        focus={{ date: new Date(2026, 8, 14), nonce: 0 }}
        windowKey="month:2026-09-14"
        rangeStart={new Date(2026, 7, 31)}
        rangeEnd={new Date(2026, 9, 4)}
        selectedDate={new Date(2026, 8, 14)}
        events={[]}
        calendars={calendars}
        tasks={[recurringTask]}
        onSelectDate={vi.fn()}
        onSelectEvent={vi.fn()}
        onToggleTaskComplete={vi.fn()}
        onSelectTask={vi.fn()}
      />
    );

    // Occurrences should be rendered across the month
    const taskChips = screen.getAllByText('Daily Standup');
    expect(taskChips.length).toBeGreaterThan(10);
  });

  it('renders recurring tasks across days in CalendarWeekView', () => {
    const recurringTask = makeTask('weekly-task', '2026-09-07', {
      title: 'Daily Review',
      recurrenceRules: [createRecurrenceRule('daily')],
    });

    render(
      <CalendarWeekView
        focus={{ date: new Date(2026, 8, 9), nonce: 0 }}
        windowKey="week:2026-09-07"
        rangeStart={new Date(2026, 8, 7)}
        rangeEnd={new Date(2026, 8, 13)}
        selectedDate={new Date(2026, 8, 9)}
        events={[]}
        calendars={calendars}
        tasks={[recurringTask]}
        onSelectDate={vi.fn()}
        onSelectEvent={vi.fn()}
        onToggleTaskComplete={vi.fn()}
        onSelectTask={vi.fn()}
        onCreateAtTime={vi.fn()}
      />
    );

    // In a 7-day week view, daily task should appear 7 times
    const taskChips = screen.getAllByText('Daily Review');
    expect(taskChips.length).toBe(7);
  });
});
