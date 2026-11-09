import { render, screen, fireEvent, within } from '@testing-library/react';
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { TaskListView, defaultTaskList, taskListsOf } from '../task-list-view';
import { CalendarSidebarPanel } from '../calendar-sidebar-panel';
import { TaskModal } from '../task-modal';
import { useCalendarStore } from '@/stores/calendar-store';
import { useSettingsStore } from '@/stores/settings-store';
import { useTaskStore } from '@/stores/task-store';
import type { Calendar, CalendarTask } from '@/lib/jmap/types';
import type { IJMAPClient } from '@/lib/jmap/client-interface';

// pim-1: tasks in a task-only list ("To-do", as Thunderbird, Apple Reminders
// and DAVx⁵ make them) never showed, while the sidebar counted them: the
// list filtered by the grid's calendar selection, which leaves task-only
// lists out. A task moved into To-do vanished on save.

function cal(id: string, name: string, extra: Partial<Calendar> = {}): Calendar {
  return {
    id, name, color: '#3b82f6', sortOrder: 0, isSubscribed: true, isVisible: true, isDefault: false,
    includeInAvailability: 'all', timeZone: null, shareWith: null,
    myRights: { mayReadItems: true, mayWriteAll: true, mayWriteOwn: true, mayUpdatePrivate: true, mayRSVP: true, mayShare: true, mayDelete: true },
    ...extra,
  } as unknown as Calendar;
}

function task(id: string, calendarId: string, extra: Partial<CalendarTask> = {}): CalendarTask {
  return {
    id, calendarIds: { [calendarId]: true }, '@type': 'Task', uid: id, title: id, description: '',
    due: null, start: null, duration: null, timeZone: null, showWithoutTime: true, progress: 'needs-action',
    priority: 0, privacy: 'public', keywords: null, categories: null, color: null, created: null,
    updated: '2026-11-01T00:00:00Z', recurrenceRules: null, alerts: null, relatedTo: null,
    ...extra,
  } as CalendarTask;
}

const home = cal('home', 'Home', { isDefault: true });
const todo = cal('todo', 'To-do', { isTasksOnly: true });
const work = cal('work', 'Work');

beforeEach(() => {
  // The grid shows Home and Work, as fetchCalendars leaves it: never To-do.
  useCalendarStore.setState({ calendars: [home, todo, work], selectedCalendarIds: ['home', 'work'], hiddenTaskListIds: [], viewMode: 'tasks' } as never);
  useSettingsStore.setState({ enableCalendarTasks: true, showTasksOnCalendar: true } as never);
  useTaskStore.setState({ tasks: [] } as never);
});

const listed = () => Array.from(document.querySelectorAll('span[title^="t-"]')).map((el) => el.getAttribute('title'));

describe('the task list (pim-1)', () => {
  const tasks = [
    task('t-open', 'todo', { due: '2020-01-01T10:00:00' }),
    task('t-done', 'todo', { progress: 'completed' }),
    task('t-work', 'work'),
  ];

  it('lists tasks of a task-only list in every filter', () => {
    const { rerender } = render(<TaskListView tasks={tasks} calendars={[home, todo, work]} filter="all" onSelectTask={() => {}} onToggleComplete={() => {}} />);
    expect(listed()).toEqual(expect.arrayContaining(['t-open', 't-done', 't-work']));
    rerender(<TaskListView tasks={tasks} calendars={[home, todo, work]} filter="pending" onSelectTask={() => {}} onToggleComplete={() => {}} />);
    expect(listed()).toEqual(expect.arrayContaining(['t-open', 't-work']));
    rerender(<TaskListView tasks={tasks} calendars={[home, todo, work]} filter="overdue" onSelectTask={() => {}} onToggleComplete={() => {}} />);
    expect(listed()).toEqual(['t-open']);
    rerender(<TaskListView tasks={tasks} calendars={[home, todo, work]} filter="completed" onSelectTask={() => {}} onToggleComplete={() => {}} />);
    expect(listed()).toEqual(['t-done']);
  });

  it('keeps a task moved into To-do in the list', () => {
    const { rerender } = render(<TaskListView tasks={[task('t-moved', 'work')]} calendars={[home, todo, work]} filter="all" onSelectTask={() => {}} onToggleComplete={() => {}} />);
    expect(listed()).toEqual(['t-moved']);
    rerender(<TaskListView tasks={[task('t-moved', 'todo')]} calendars={[home, todo, work]} filter="all" onSelectTask={() => {}} onToggleComplete={() => {}} />);
    expect(listed()).toEqual(['t-moved']);
  });

  it('leaves out the lists the user unticked, not the calendars the grid hides', () => {
    useCalendarStore.setState({ hiddenTaskListIds: ['todo'], selectedCalendarIds: [] } as never);
    render(<TaskListView tasks={tasks} calendars={[home, todo, work]} filter="all" onSelectTask={() => {}} onToggleComplete={() => {}} />);
    expect(listed()).toEqual(['t-work']);
  });

  it('offers task-only lists and calendars holding tasks as task lists', () => {
    expect(taskListsOf([home, todo, work], tasks).map((c) => c.id)).toEqual(['todo', 'work']);
  });
});

describe('the sidebar in the tasks view (pim-1)', () => {
  const client = { getAccountId: () => 'a' } as unknown as IJMAPClient;

  it('lists the task lists, ticked, and unticking one hides its tasks', () => {
    useTaskStore.setState({ tasks: [task('t-open', 'todo')] } as never);
    render(<CalendarSidebarPanel calendars={[home, todo, work]} selectedCalendarIds={['home', 'work']} onToggleVisibility={() => {}} client={client} />);
    const section = screen.getByTestId('task-lists-section');
    const item = within(section).getByRole('checkbox', { name: /To-do/ });
    expect(item).toHaveAttribute('aria-checked', 'true');
    // The event calendars aren't offered here: they only steer the grid.
    expect(screen.queryByTestId('calendar-item')).toBeNull();
    fireEvent.click(item);
    expect(useCalendarStore.getState().hiddenTaskListIds).toEqual(['todo']);
    expect(useCalendarStore.getState().selectedCalendarIds).toEqual(['home', 'work']);
  });

  // Outside the tasks view a task-only list has no calendar tick, so it stays
  // in the sidebar below the calendars with its task list tick; a calendar
  // holding tasks keeps its calendar tick there.
  it('shows the event calendars again outside the tasks view, the task-only lists below them', () => {
    useCalendarStore.setState({ viewMode: 'month' } as never);
    render(<CalendarSidebarPanel calendars={[home, todo, work]} selectedCalendarIds={['home', 'work']} onToggleVisibility={() => {}} client={client} />);
    const taskLists = screen.getByTestId('task-lists-section');
    const items = screen.getAllByTestId('calendar-item');
    expect(items.filter((el) => !taskLists.contains(el)).map((el) => el.dataset.calendarName)).toEqual(['Home', 'Work']);
    expect(within(taskLists).getAllByRole('checkbox').map((el) => el.textContent?.trim())).toEqual(['To-do']);
  });

  it('hides a task-only list with its task list tick in the day view', () => {
    useCalendarStore.setState({ viewMode: 'day' } as never);
    render(<CalendarSidebarPanel calendars={[home, todo, work]} selectedCalendarIds={['home', 'work']} onToggleVisibility={() => {}} client={client} />);
    fireEvent.click(within(screen.getByTestId('task-lists-section')).getByRole('checkbox', { name: /To-do/ }));
    expect(useCalendarStore.getState().hiddenTaskListIds).toEqual(['todo']);
    expect(useCalendarStore.getState().selectedCalendarIds).toEqual(['home', 'work']);
  });

  it('leaves the task-only lists out of the calendar views when tasks are not shown on the calendar', () => {
    useSettingsStore.setState({ showTasksOnCalendar: false } as never);
    useCalendarStore.setState({ viewMode: 'week' } as never);
    render(<CalendarSidebarPanel calendars={[home, todo, work]} selectedCalendarIds={['home', 'work']} onToggleVisibility={() => {}} client={client} />);
    expect(screen.queryByTestId('task-lists-section')).toBeNull();
  });
});

describe('where a new task goes (pim-8)', () => {
  it('picks the first task-only list, else the default calendar', () => {
    expect(defaultTaskList([home, work, todo])?.id).toBe('todo');
    expect(defaultTaskList([work, home])?.id).toBe('home');
    expect(defaultTaskList([work])?.id).toBe('work');
  });

  // A colleague's shared to-do list, or another login's, came before the
  // user's own default calendar.
  it("never picks someone else's or another login's list over the user's own", () => {
    const shared = { ...todo, id: 'shared-todo', isShared: true } as Calendar;
    const otherLogin = { ...todo, id: 'b:todo', localAccountId: 'login-b' } as Calendar;
    expect(defaultTaskList([shared, otherLogin, work, home])?.id).toBe('home');
    expect(defaultTaskList([shared, otherLogin])?.id).toBe('shared-todo');
  });

  it('opens the task form on the task-only list', () => {
    // The select lists task lists only (pim-p2-13), so a second one makes it show.
    const errands = { ...todo, id: 'errands', name: 'Errands' } as Calendar;
    render(<TaskModal calendars={[home, work, todo, errands]} onSave={vi.fn()} onClose={() => {}} />);
    expect((screen.getByLabelText('task_list_label') as HTMLSelectElement).value).toBe('todo');
  });
});

describe('task status words (pim-19)', () => {
  it('says "Not started" and "In progress" and keeps the stored values', () => {
    render(<TaskModal calendars={[home]} onSave={vi.fn()} onClose={() => {}} />);
    const select = screen.getByLabelText('tasks.progress') as HTMLSelectElement;
    const options = Array.from(select.options).map((o) => [o.value, o.textContent]);
    expect(options.slice(0, 2)).toEqual([['needs-action', 'task_status_not_started'], ['in-process', 'task_status_in_progress']]);
  });
});
