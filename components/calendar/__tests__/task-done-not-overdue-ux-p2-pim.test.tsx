import { render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Calendar, CalendarTask } from '@/lib/jmap/types';
import type { IJMAPClient } from '@/lib/jmap/client-interface';
import { useSettingsStore } from '@/stores/settings-store';
import { useTaskStore } from '@/stores/task-store';

// pim-p2-12: a completed task still said "Overdue" in red, and the sidebar
// counted tasks due earlier today as overdue while the list didn't.

vi.mock('next-intl', () => ({
  useTranslations: () => (key: string) => key,
  useLocale: () => 'en',
  useFormatter: () => ({
    dateTime: (d: Date, options: Intl.DateTimeFormatOptions) => new Intl.DateTimeFormat('en-US', options).format(d),
  }),
}));

import { TaskListView, isTaskOverdue } from '../task-list-view';
import { CalendarSidebarPanel } from '../calendar-sidebar-panel';

const calendars = [{ id: 'cal', name: 'To-do', color: '#123456', isTasksOnly: true }] as unknown as Calendar[];

function task(overrides: Partial<CalendarTask>): CalendarTask {
  return {
    id: 't', title: 'Pay the dentist invoice', calendarIds: { cal: true }, progress: 'needs-action',
    priority: 0, due: '2026-10-20', showWithoutTime: true, ...overrides,
  } as unknown as CalendarTask;
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date(2026, 10, 4, 15, 0));
});
afterEach(() => {
  vi.useRealTimers();
  useTaskStore.setState({ tasks: [] } as never);
});

describe('done tasks are never overdue', () => {
  it('shows a completed task past its date with the plain date in grey', () => {
    render(<TaskListView tasks={[task({ progress: 'completed' })]} calendars={calendars} filter="all" onSelectTask={() => {}} onToggleComplete={() => {}} />);
    expect(screen.queryByText('tasks.overdue')).toBeNull();
    const date = screen.getByText('Oct 20');
    expect(date.className).toContain('text-muted-foreground');
    expect(date.className).not.toMatch(/text-red/);
  });

  it('still warns about an open task past its date', () => {
    render(<TaskListView tasks={[task({})]} calendars={calendars} filter="all" onSelectTask={() => {}} onToggleComplete={() => {}} />);
    expect(screen.getByText('tasks.overdue')).toBeInTheDocument();
  });

  it('says so for cancelled tasks too, and not for one due later today', () => {
    expect(isTaskOverdue(task({ progress: 'cancelled' }))).toBe(false);
    expect(isTaskOverdue(task({ progress: 'completed' }))).toBe(false);
    expect(isTaskOverdue(task({}))).toBe(true);
    expect(isTaskOverdue(task({ due: '2026-11-04T09:00:00', showWithoutTime: false }))).toBe(false);
  });

  it('counts overdue tasks in the sidebar by the same rule as the list', () => {
    useSettingsStore.setState({ enableCalendarTasks: true } as never);
    useTaskStore.setState({
      tasks: [
        task({ id: 'a' }),
        task({ id: 'b', progress: 'completed' }),
        // Due this morning: today, not overdue, as the list says.
        task({ id: 'c', due: '2026-11-04T09:00:00', showWithoutTime: false }),
      ],
    } as never);
    const client = { getAccountId: () => 'me' } as unknown as IJMAPClient;
    render(<CalendarSidebarPanel calendars={calendars} selectedCalendarIds={['cal']} onToggleVisibility={() => {}} client={client} />);
    expect(screen.getByText(/^1 tasks\.filter_overdue$/i)).toBeInTheDocument();
  });
});
