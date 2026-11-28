import { describe, it, expect } from 'vitest';
import { addDays, format } from 'date-fns';
import type { CalendarTask } from '@/lib/jmap/types';
import { createRecurrenceRule } from '@/lib/recurrence-rule';
import { asListedTask, nextOpenOccurrence } from '@/lib/calendar-tasks';

// Ticking off a series completes one occurrence, the first one still open:
// which one is that?
function series(overrides: Partial<CalendarTask> = {}): CalendarTask {
  return {
    id: 's1',
    '@type': 'Task',
    calendarIds: { c1: true },
    title: 'Walk',
    due: '2026-09-20T00:00:00',
    showWithoutTime: true,
    progress: 'needs-action',
    recurrenceRules: [createRecurrenceRule('daily')],
    ...overrides,
  } as CalendarTask;
}

describe('nextOpenOccurrence', () => {
  it('is the first occurrence of a series nothing was done to', () => {
    expect(nextOpenOccurrence(series())).toMatchObject({ recurrenceId: '2026-09-20T00:00:00', seriesId: 's1', due: '2026-09-20' });
  });

  it('skips occurrences completed, cancelled or left out', () => {
    const next = nextOpenOccurrence(series({
      recurrenceOverrides: {
        '2026-09-20T00:00:00': { progress: 'completed' },
        '2026-09-21T00:00:00': { progress: 'cancelled' },
        '2026-09-22T00:00:00': { excluded: true },
      } as CalendarTask['recurrenceOverrides'],
    }));
    expect(next?.recurrenceId).toBe('2026-09-23T00:00:00');
  });

  it('keeps the due date an override moved the occurrence to', () => {
    const next = nextOpenOccurrence(series({
      recurrenceOverrides: { '2026-09-20T00:00:00': { due: '2026-09-25T00:00:00' } } as CalendarTask['recurrenceOverrides'],
    }));
    expect(next).toMatchObject({ recurrenceId: '2026-09-20T00:00:00', due: '2026-09-25T00:00:00' });
  });

  it('repeats from the start and is due as far after it as the series', () => {
    const next = nextOpenOccurrence(series({
      start: '2026-09-18T09:00:00',
      due: '2026-09-20T17:00:00',
      showWithoutTime: false,
      recurrenceRules: [createRecurrenceRule('weekly')],
      recurrenceOverrides: { '2026-09-18T09:00:00': { progress: 'completed' } } as CalendarTask['recurrenceOverrides'],
    }));
    expect(next).toMatchObject({ recurrenceId: '2026-09-25T09:00:00', due: '2026-09-27T17:00:00' });
  });

  it('repeats a series without a due date by its start, and leaves it without one', () => {
    const next = nextOpenOccurrence(series({ due: null, start: '2026-09-20T08:00:00', showWithoutTime: false }));
    expect(next).toMatchObject({ recurrenceId: '2026-09-20T08:00:00', due: null });
  });

  it('finds an open occurrence years after the start', () => {
    const done = Object.fromEntries(Array.from({ length: 400 }, (_, i) =>
      [format(addDays(new Date(2026, 8, 20), i), "yyyy-MM-dd'T'00:00:00"), { progress: 'completed' }]));
    const next = nextOpenOccurrence(series({ recurrenceOverrides: done as CalendarTask['recurrenceOverrides'] }));
    expect(next?.recurrenceId).toBe('2027-10-25T00:00:00');
  });

  it('is none when every occurrence of a counted series is done', () => {
    expect(nextOpenOccurrence(series({
      recurrenceRules: [createRecurrenceRule('daily', { count: 2 })],
      recurrenceOverrides: {
        '2026-09-20T00:00:00': { progress: 'completed' },
        '2026-09-21T00:00:00': { progress: 'completed' },
      } as CalendarTask['recurrenceOverrides'],
    }))).toBeNull();
  });

  it('is none for a series completed as a whole, and for a task that does not repeat', () => {
    expect(nextOpenOccurrence(series({ progress: 'completed' }))).toBeNull();
    expect(nextOpenOccurrence(series({ recurrenceRules: null }))).toBeNull();
  });
});

describe('asListedTask', () => {
  it('expands a series once per task object, and again once the store replaces it', () => {
    const task = series();
    const listed = asListedTask(task);
    expect(listed).toMatchObject({ id: 's1', recurrenceId: '2026-09-20T00:00:00' });
    // The list, its filter counts and the side panel all ask for it.
    expect(asListedTask(task)).toBe(listed);

    const ticked = { ...task, recurrenceOverrides: { '2026-09-20T00:00:00': { progress: 'completed' } } } as CalendarTask;
    expect(asListedTask(ticked)).toMatchObject({ id: 's1', recurrenceId: '2026-09-21T00:00:00' });
  });
});
