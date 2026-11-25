import { describe, it, expect } from 'vitest';
import type { CalendarTask } from '@/lib/jmap/types';
import { createRecurrenceRule } from '@/lib/recurrence-rule';
import { filterTasksForList } from '@/components/calendar/task-list-view';

// The task list shows a series as the occurrence a tick completes, its first
// open one, under the series' id: selecting, deleting and the plugin API keep
// meaning the series.
const series = (overrides: Partial<CalendarTask> = {}) => ({
  id: 's1',
  '@type': 'Task',
  calendarIds: { c1: true },
  title: 'Bins',
  due: '2026-09-20T00:00:00',
  showWithoutTime: true,
  progress: 'needs-action',
  recurrenceRules: [createRecurrenceRule('weekly')],
  ...overrides,
}) as CalendarTask;

describe('filterTasksForList with a series', () => {
  it('shows a series at its first open occurrence, under the series id', () => {
    const [listed] = filterTasksForList([series({
      recurrenceOverrides: { '2026-09-20T00:00:00': { progress: 'completed' } } as CalendarTask['recurrenceOverrides'],
    })], [], 'all');
    expect(listed).toMatchObject({ id: 's1', seriesId: 's1', recurrenceId: '2026-09-27T00:00:00', due: '2026-09-27', progress: 'needs-action' });
  });

  it('shows a series with nothing left open as it is', () => {
    const done = series({ progress: 'completed' });
    expect(filterTasksForList([done], [], 'all')).toEqual([done]);
  });
});
