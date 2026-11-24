import { fireEvent, render, screen, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { Calendar, CalendarTask } from '@/lib/jmap/types';

// #1048: subtasks made in tasks.org or Nextcloud showed as unrelated tasks,
// and Bulwark had no way to make one.

vi.mock('next-intl', () => ({
  useTranslations: () => (key: string, values?: Record<string, unknown>) => (values ? `${key} ${JSON.stringify(values)}` : key),
  useLocale: () => 'en',
  useFormatter: () => ({
    dateTime: (d: Date, options: Intl.DateTimeFormatOptions) => new Intl.DateTimeFormat('en-US', options).format(d),
  }),
}));

import { TaskListView } from '../task-list-view';
import { TaskModal } from '../task-modal';

const writable = { mayReadItems: true, mayWriteAll: true, mayWriteOwn: true, mayDelete: true };
const calendars = [
  { id: 'home', name: 'Home', color: '#123456', isTasksOnly: true, myRights: writable },
  { id: 'work', name: 'Work', color: '#654321', isTasksOnly: true, myRights: writable },
] as unknown as Calendar[];

function task(id: string, title: string, extra: Partial<CalendarTask> = {}): CalendarTask {
  return {
    id, uid: `uid-${id}`, '@type': 'Task', title, calendarIds: { work: true }, progress: 'needs-action',
    priority: 0, due: null, showWithoutTime: true, alerts: null, relatedTo: null, ...extra,
  } as unknown as CalendarTask;
}

const parent = task('p', 'Move house');
// Due first, so the list's sort puts it above its parent.
const child = task('c', 'Book the van', {
  due: '2026-11-20', relatedTo: { 'uid-p': { '@type': 'Relation', relation: { parent: true } } },
});
const other = task('o', 'Call the bank', { due: '2026-11-25' });

function rowOrder() {
  return [...document.querySelectorAll('[data-task-id]')].map((row) => [row.getAttribute('data-task-id'), row.getAttribute('data-task-depth')]);
}

describe('subtasks in the task list', () => {
  it('shows a subtask under its parent, indented, and names the parent for screen readers', () => {
    render(<TaskListView tasks={[child, other, parent]} calendars={calendars} filter="all" onSelectTask={vi.fn()} onToggleComplete={vi.fn()} />);
    expect(rowOrder()).toEqual([['o', '0'], ['p', '0'], ['c', '1']]);
    const row = document.querySelector('[data-task-id="c"]')!;
    expect(row.className).toContain('ps-10');
    expect(within(row as HTMLElement).getByText(/tasks\.subtask_of/).textContent).toContain('Move house');
  });

  it('ticks off a subtask on its own', () => {
    const onToggleComplete = vi.fn();
    render(<TaskListView tasks={[parent, child]} calendars={calendars} filter="all" onSelectTask={vi.fn()} onToggleComplete={onToggleComplete} />);
    const row = document.querySelector('[data-task-id="c"]') as HTMLElement;
    fireEvent.click(within(row).getByRole('button', { name: 'tasks.mark_complete' }));
    expect(onToggleComplete).toHaveBeenCalledWith(child);
  });

  it('offers Add subtask in the right-click menu', () => {
    const onAddSubtask = vi.fn();
    render(<TaskListView tasks={[parent]} calendars={calendars} filter="all" moveLists={calendars} onSelectTask={vi.fn()} onToggleComplete={vi.fn()} onAddSubtask={onAddSubtask} />);
    fireEvent.contextMenu(screen.getByText('Move house'));
    fireEvent.click(screen.getByTestId('task-menu-add-subtask'));
    expect(onAddSubtask).toHaveBeenCalledWith(parent);
  });

  it('leaves Add subtask out for a task in a list the user may not write', () => {
    render(<TaskListView tasks={[parent]} calendars={calendars} filter="all" moveLists={[calendars[0]]} onSelectTask={vi.fn()} onToggleComplete={vi.fn()} onAddSubtask={vi.fn()} />);
    fireEvent.contextMenu(screen.getByText('Move house'));
    expect(screen.queryByTestId('task-menu-add-subtask')).toBeNull();
  });
});

describe('subtasks in the task editor', () => {
  it('makes a new subtask in its parent\'s list, linked to the parent', async () => {
    const onSave = vi.fn();
    render(<TaskModal calendars={calendars} parentTask={parent} onSave={onSave} onClose={vi.fn()} />);
    expect(screen.getByTestId('task-parent').textContent).toContain('Move house');
    fireEvent.change(screen.getByLabelText('tasks.title_placeholder'), { target: { value: 'Pack the books' } });
    fireEvent.click(screen.getByText('tasks.save'));
    await vi.waitFor(() => expect(onSave).toHaveBeenCalled());
    expect(onSave.mock.calls[0][0]).toMatchObject({
      title: 'Pack the books',
      calendarIds: { work: true },
      relatedTo: { 'uid-p': { '@type': 'Relation', relation: { parent: true } } },
    });
  });

  it('leaves the links of a task being edited as they are', async () => {
    const onSave = vi.fn();
    render(<TaskModal task={child} calendars={calendars} parentTask={other} onSave={onSave} onClose={vi.fn()} />);
    fireEvent.change(screen.getByLabelText('tasks.title_placeholder'), { target: { value: 'Book the big van' } });
    fireEvent.click(screen.getByText('tasks.save'));
    await vi.waitFor(() => expect(onSave).toHaveBeenCalled());
    expect(onSave.mock.calls[0][0]).not.toHaveProperty('relatedTo');
  });

  it('opens a new subtask from a task being edited', () => {
    const onAddSubtask = vi.fn();
    render(<TaskModal task={parent} calendars={calendars} onSave={vi.fn()} onClose={vi.fn()} onAddSubtask={onAddSubtask} />);
    fireEvent.click(screen.getByTestId('task-add-subtask'));
    expect(onAddSubtask).toHaveBeenCalledWith(parent);
  });
});
