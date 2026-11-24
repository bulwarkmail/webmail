// Berlin leaves summer time on 2026-10-25; pinned so the DST case is real.
process.env.TZ = 'Europe/Berlin';

import { describe, it, expect } from 'vitest';
import { groupTasksByDueDay } from '../calendar-tasks';
import type { CalendarTask } from '@/lib/jmap/types';
import { createRecurrenceRule } from '@/lib/recurrence-rule';

// RFC 5545 repeats a VTODO from DTSTART (JSCalendar `start`), and each
// occurrence is due at the same distance after its start. Stalwart and
// CalDAV clients key an occurrence (RECURRENCE-ID) by its start too.

function series(overrides: Partial<CalendarTask>): CalendarTask {
  return {
    id: 'series',
    '@type': 'Task',
    uid: 'series',
    title: 'Take out the bins',
    description: '',
    due: null,
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
    updated: '2026-11-01T00:00:00Z',
    recurrenceRules: [createRecurrenceRule('weekly')],
    alerts: null,
    relatedTo: null,
    calendarIds: { 'cal-1': true },
    ...overrides,
  } as CalendarTask;
}

const mondays = [{ ...createRecurrenceRule('weekly'), byDay: [{ day: 'mo' as const }] }];
const november = { start: new Date(2026, 10, 16), end: new Date(2026, 10, 30) };

describe('groupTasksByDueDay repeats a series from its start', () => {
  it('shows a task starting Monday, due Wednesday, repeating on Mondays as due on Wednesdays', () => {
    const task = series({ start: '2026-11-16T00:00:00', due: '2026-11-18T00:00:00', recurrenceRules: mondays });

    const map = groupTasksByDueDay([task], november);

    expect([...map.keys()].sort()).toEqual(['2026-11-18', '2026-11-25']);
    const next = map.get('2026-11-25')![0];
    expect(next.due).toBe('2026-11-25');
    expect(next.recurrenceId).toBe('2026-11-23T00:00:00');
  });

  it('applies an override keyed by the occurrence start, as Stalwart stores RECURRENCE-ID', () => {
    const task = series({
      start: '2026-11-16T00:00:00',
      due: '2026-11-18T00:00:00',
      recurrenceRules: mondays,
      recurrenceOverrides: { '2026-11-23T00:00:00': { progress: 'completed' } },
    });

    const map = groupTasksByDueDay([task], november);

    expect(map.get('2026-11-25')![0].progress).toBe('completed');
    expect(map.get('2026-11-18')![0].progress).toBe('needs-action');
  });

  it('leaves a series whose start equals its due date as it was', () => {
    const task = series({ start: '2026-11-17T00:00:00', due: '2026-11-17T00:00:00' });

    const map = groupTasksByDueDay([task], november);

    expect([...map.keys()].sort()).toEqual(['2026-11-17', '2026-11-24']);
    expect(map.get('2026-11-24')![0].recurrenceId).toBe('2026-11-24T00:00:00');
  });

  it('keeps the due time on the wall clock when a DST switch lies between start and due', () => {
    const task = series({
      showWithoutTime: false,
      timeZone: 'Europe/Berlin',
      start: '2026-10-23T10:00:00',
      due: '2026-10-26T10:00:00',
    });

    const map = groupTasksByDueDay([task], { start: new Date(2026, 9, 26), end: new Date(2026, 10, 3) });

    expect(map.get('2026-11-02')!.map((t) => t.due)).toEqual(['2026-11-02T10:00:00']);
    expect(map.get('2026-11-02')![0].recurrenceId).toBe('2026-10-30T10:00:00');
  });
});
