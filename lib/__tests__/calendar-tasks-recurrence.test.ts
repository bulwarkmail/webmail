import { describe, it, expect } from 'vitest';
import { groupTasksByDueDay } from '../calendar-tasks';
import type { CalendarTask } from '@/lib/jmap/types';
import { createRecurrenceRule } from '@/lib/recurrence-rule';

function makeTask(id: string, overrides: Partial<CalendarTask> = {}): CalendarTask {
  return {
    id,
    '@type': 'Task',
    uid: id,
    title: 'Task ' + id,
    description: '',
    due: '2026-09-20',
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

describe('groupTasksByDueDay recurrence expansion', () => {
  it('expands a daily recurring task across the given date range', () => {
    const task = makeTask('walk', {
      title: 'Lauf 🚶',
      due: '2026-09-20',
      recurrenceRules: [createRecurrenceRule('daily')],
    });

    const range = {
      start: new Date('2026-09-20T00:00:00'),
      end: new Date('2026-09-23T23:59:59'),
    };

    const map = groupTasksByDueDay([task], range);
    expect([...map.keys()].sort()).toEqual([
      '2026-09-20',
      '2026-09-21',
      '2026-09-22',
      '2026-09-23',
    ]);

    // Check each day has the task instance with matching due date and occurrence metadata
    const day21 = map.get('2026-09-21');
    expect(day21).toHaveLength(1);
    expect(day21![0].id).toBe('walk:2026-09-21T00:00:00');
    expect(day21![0].originalId).toBe('walk');
    expect(day21![0].recurrenceId).toBe('2026-09-21T00:00:00');
    expect(day21![0].due).toBe('2026-09-21');
  });

  it('respects recurrenceOverrides by excluding and modifying occurrences', () => {
    const task = makeTask('walk', {
      title: 'Lauf 🚶',
      due: '2026-09-20',
      recurrenceRules: [createRecurrenceRule('daily')],
      recurrenceOverrides: {
        '2026-09-21': { excluded: true },
        '2026-09-22': { title: 'Lauf mit Hund 🐕' },
      },
    });

    const range = {
      start: new Date('2026-09-20T00:00:00'),
      end: new Date('2026-09-23T23:59:59'),
    };

    const map = groupTasksByDueDay([task], range);
    // 2026-09-21 is excluded
    expect([...map.keys()].sort()).toEqual([
      '2026-09-20',
      '2026-09-22',
      '2026-09-23',
    ]);

    // 2026-09-22 has overridden title
    const day22 = map.get('2026-09-22');
    expect(day22).toHaveLength(1);
    expect(day22![0].id).toBe('walk:2026-09-22T00:00:00');
    expect(day22![0].title).toBe('Lauf mit Hund 🐕');
  });

  it('respects until parameter in recurrence rule', () => {
    const task = makeTask('walk', {
      title: 'Lauf 🚶',
      due: '2026-09-20',
      recurrenceRules: [createRecurrenceRule('daily', { until: '2026-09-21T23:59:59' })],
    });

    const range = {
      start: new Date('2026-09-20T00:00:00'),
      end: new Date('2026-09-25T23:59:59'),
    };

    const map = groupTasksByDueDay([task], range);
    expect([...map.keys()].sort()).toEqual([
      '2026-09-20',
      '2026-09-21',
    ]);
  });

  it('renders completed occurrences from recurrenceOverrides including past dates', () => {
    const task = makeTask('weekly', {
      title: 'Weekly Review',
      due: '2026-09-28', // series was advanced to 28th
      recurrenceRules: [createRecurrenceRule('weekly')],
      recurrenceOverrides: {
        '2026-09-21': { progress: 'completed' },
      },
    });

    const range = {
      start: new Date('2026-09-20T00:00:00'),
      end: new Date('2026-10-05T23:59:59'),
    };

    const map = groupTasksByDueDay([task], range);
    // 2026-09-21 must be present because of the completed override!
    expect(map.has('2026-09-21')).toBe(true);
    const occ21 = map.get('2026-09-21')![0];
    expect(occ21.progress).toBe('completed');
    expect(occ21.id).toBe('weekly:2026-09-21T00:00:00');

    // 2026-09-28 must be present as pending
    expect(map.has('2026-09-28')).toBe(true);
    const occ28 = map.get('2026-09-28')![0];
    expect(occ28.progress).toBe('needs-action');
  });

  it('applies overrides keyed by JSCalendar LocalDateTime for all-day tasks (as stored by the server)', () => {
    const task = makeTask('walk', {
      due: '2026-09-20',
      recurrenceRules: [createRecurrenceRule('daily')],
      recurrenceOverrides: {
        '2026-09-21T00:00:00': { excluded: true },
        '2026-09-22T00:00:00': { title: 'Lauf mit Hund 🐕', due: '2026-09-23' },
      },
    });
    const range = { start: new Date('2026-09-20T00:00:00'), end: new Date('2026-09-23T23:59:59') };

    const map = groupTasksByDueDay([task], range);

    expect(map.has('2026-09-21')).toBe(false);
    expect(map.has('2026-09-22')).toBe(false);
    const moved = map.get('2026-09-23')!.find((t) => t.recurrenceId === '2026-09-22T00:00:00');
    expect(moved?.title).toBe('Lauf mit Hund 🐕');
  });
});
