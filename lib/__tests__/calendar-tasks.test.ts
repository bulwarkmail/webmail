import { describe, it, expect } from 'vitest';
import { filterTasksByCalendars, groupTasksByDueDay, taskDueDayKey } from '../calendar-tasks';
import type { CalendarTask } from '@/lib/jmap/types';

// #1107: the month, week and day views place tasks on their due day and
// hide tasks from calendars switched off in the sidebar.

function makeTask(id: string, overrides: Partial<CalendarTask> = {}): CalendarTask {
  return {
    id,
    '@type': 'Task',
    uid: id,
    title: 'Task ' + id,
    description: '',
    due: '2026-09-10',
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

describe('filterTasksByCalendars', () => {
  it('keeps tasks in at least one visible calendar', () => {
    const tasks = [
      makeTask('a', { calendarIds: { 'cal-1': true } }),
      makeTask('b', { calendarIds: { 'cal-2': true } }),
      makeTask('c', { calendarIds: { 'cal-2': true, 'cal-3': true } }),
    ];
    expect(filterTasksByCalendars(tasks, ['cal-1', 'cal-3']).map((t) => t.id)).toEqual(['a', 'c']);
    expect(filterTasksByCalendars(tasks, [])).toEqual([]);
  });
});

describe('taskDueDayKey', () => {
  it('is the local day of the due date, with or without a time', () => {
    expect(taskDueDayKey(makeTask('a', { due: '2026-09-10' }))).toBe('2026-09-10');
    expect(taskDueDayKey(makeTask('a', { due: '2026-09-10T23:30:00', showWithoutTime: false }))).toBe('2026-09-10');
  });

  it('is null for tasks without a usable due date', () => {
    expect(taskDueDayKey(makeTask('a', { due: null }))).toBeNull();
    expect(taskDueDayKey(makeTask('a', { due: 'not a date' }))).toBeNull();
  });
});

describe('groupTasksByDueDay', () => {
  it('groups by due day and skips tasks without one', () => {
    const map = groupTasksByDueDay([
      makeTask('a', { due: '2026-09-10' }),
      makeTask('b', { due: '2026-09-11' }),
      makeTask('c', { due: null }),
      makeTask('d', { due: '2026-09-10T09:00:00', showWithoutTime: false }),
    ]);
    expect([...map.keys()].sort()).toEqual(['2026-09-10', '2026-09-11']);
    expect(map.get('2026-09-10')?.map((t) => t.id).sort()).toEqual(['a', 'd']);
  });

  it('orders a day by untimed first, then due time, then title', () => {
    const map = groupTasksByDueDay([
      makeTask('late', { due: '2026-09-10T17:00:00', showWithoutTime: false, title: 'A' }),
      makeTask('early', { due: '2026-09-10T08:00:00', showWithoutTime: false, title: 'Z' }),
      makeTask('allday-b', { due: '2026-09-10', title: 'B' }),
      makeTask('allday-a', { due: '2026-09-10', title: 'A' }),
    ]);
    expect(map.get('2026-09-10')?.map((t) => t.id)).toEqual(['allday-a', 'allday-b', 'early', 'late']);
  });

  it('is empty for no tasks', () => {
    expect(groupTasksByDueDay(undefined).size).toBe(0);
    expect(groupTasksByDueDay([]).size).toBe(0);
  });
});
