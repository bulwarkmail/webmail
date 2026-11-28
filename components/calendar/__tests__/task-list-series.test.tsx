import { fireEvent, render, screen } from '@testing-library/react';
import { describe, it, expect, vi } from 'vitest';
import type { Calendar, CalendarTask } from '@/lib/jmap/types';
import { createRecurrenceRule } from '@/lib/recurrence-rule';

vi.mock('next-intl', () => ({
  useTranslations: () => (key: string) => key,
  useLocale: () => 'en',
  useFormatter: () => ({
    dateTime: (d: Date, options: Intl.DateTimeFormatOptions) => new Intl.DateTimeFormat('en-US', options).format(d),
  }),
}));

import { TaskListView, filterTasksForList } from '@/components/calendar/task-list-view';

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

const calendars = [{ id: 'c1', name: 'Tasks', color: '#123456', isTasksOnly: true }] as unknown as Calendar[];

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

describe('TaskListView actions on a listed series', () => {
  it('passes the raw master series on row click, button click, and Delete', () => {
    const raw = series({
      start: '2026-09-18T00:00:00',
      due: '2026-09-20T00:00:00',
      recurrenceOverrides: { '2026-09-18T00:00:00': { progress: 'completed' } } as CalendarTask['recurrenceOverrides'],
    });
    const onSelectTask = vi.fn();
    const onToggleComplete = vi.fn();
    const onDeleteTask = vi.fn();
    render(
      <TaskListView
        tasks={[raw]}
        calendars={calendars}
        filter="all"
        onSelectTask={onSelectTask}
        onToggleComplete={onToggleComplete}
        onDeleteTask={onDeleteTask}
      />,
    );

    const titleBtn = screen.getByText('Bins').closest('button')!;
    const row = titleBtn.closest('[data-task-id="s1"]')!;

    fireEvent.click(row);
    fireEvent.click(titleBtn);
    expect(onSelectTask).toHaveBeenNthCalledWith(1, raw);
    expect(onSelectTask).toHaveBeenNthCalledWith(2, raw);

    titleBtn.focus();
    fireEvent.keyDown(titleBtn, { key: 'Delete' });
    expect(onDeleteTask).toHaveBeenCalledWith(raw);
  });
});
