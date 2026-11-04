import { fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Calendar, CalendarTask } from '@/lib/jmap/types';

// pim-p3-10: a right-click on a task did nothing, and Del did nothing either.

vi.mock('next-intl', () => ({
  useTranslations: () => (key: string) => key,
  useLocale: () => 'en',
  useFormatter: () => ({
    dateTime: (d: Date, options: Intl.DateTimeFormatOptions) => new Intl.DateTimeFormat('en-US', options).format(d),
  }),
}));

import { TaskListView } from '../task-list-view';
import { dueFor } from '../task-context-menu';

const calendars = [
  { id: 'home', name: 'Home', color: '#123456', isTasksOnly: true },
  { id: 'work', name: 'Work', color: '#654321', isTasksOnly: true },
] as unknown as Calendar[];

const task = {
  id: 't1', title: 'Pay the dentist invoice', calendarIds: { home: true }, progress: 'needs-action',
  priority: 0, due: null, showWithoutTime: true,
} as unknown as CalendarTask;

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date(2026, 10, 4, 15, 0)); // Wednesday
});
afterEach(() => vi.useRealTimers());

function renderList() {
  const props = {
    onSelectTask: vi.fn(), onToggleComplete: vi.fn(), onDeleteTask: vi.fn(), onSetDue: vi.fn(), onMoveTask: vi.fn(),
  };
  render(<TaskListView tasks={[task]} calendars={calendars} filter="all" moveLists={calendars} {...props} />);
  return props;
}

describe('the task menu (pim-p3-10)', () => {
  it('opens on right-click with Open, Mark as complete, Due date, Move to list and Delete', () => {
    const props = renderList();
    fireEvent.contextMenu(screen.getByText('Pay the dentist invoice'));
    const menu = screen.getByRole('menu');
    const labels = within(menu).getAllByRole('menuitem').map((i) => i.textContent ?? '');
    expect(labels[0]).toContain('task_open');
    expect(labels[1]).toBe('tasks.mark_complete');
    expect(labels).toEqual(expect.arrayContaining(['tasks.due_date', 'move_to_list']));
    expect(labels.at(-1)).toBe('tasks.deleteDel');

    fireEvent.click(within(menu).getByText('tasks.mark_complete'));
    expect(props.onToggleComplete).toHaveBeenCalledWith(task);
  });

  it('sets a due date and moves the task to another list from the submenus', () => {
    const props = renderList();
    fireEvent.contextMenu(screen.getByText('Pay the dentist invoice'));
    fireEvent.click(screen.getByTestId('task-menu-due'));
    fireEvent.click(screen.getByText('tasks.due_tomorrow'));
    expect(props.onSetDue).toHaveBeenCalledWith(task, 'tomorrow');

    fireEvent.contextMenu(screen.getByText('Pay the dentist invoice'));
    fireEvent.click(screen.getByTestId('task-menu-move'));
    fireEvent.click(screen.getByRole('menuitemradio', { name: 'Work' }));
    expect(props.onMoveTask).toHaveBeenCalledWith(task, 'work');
  });

  it('deletes the focused task with Del', () => {
    const props = renderList();
    const open = screen.getByText('Pay the dentist invoice').closest('button')!;
    open.focus();
    fireEvent.keyDown(open, { key: 'Delete' });
    expect(props.onDeleteTask).toHaveBeenCalledWith(task);
  });

  it('works out the new day, keeping a task\'s time', () => {
    expect(dueFor(task, 'today')).toEqual({ due: '2026-11-04', showWithoutTime: true });
    expect(dueFor(task, 'next-week')).toEqual({ due: '2026-11-09', showWithoutTime: true });
    expect(dueFor({ due: '2026-10-01T09:30:00', showWithoutTime: false }, 'tomorrow')).toEqual({ due: '2026-11-05T09:30:00', showWithoutTime: false });
    expect(dueFor({ due: '2026-10-01', showWithoutTime: true }, 'none')).toEqual({ due: null, showWithoutTime: true });
  });
});
