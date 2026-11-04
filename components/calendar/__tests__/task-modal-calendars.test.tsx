import { render, screen, within } from '@testing-library/react';
import { describe, it, expect, vi } from 'vitest';
import { TaskModal } from '../task-modal';
import type { Calendar, CalendarTask } from '@/lib/jmap/types';

// The task editor's Calendar select offered the read-only Birthdays
// calendar, which the event editor leaves out. Since pim-p2-13 it is "List"
// and offers task lists only.

const writable = { mayReadItems: true, mayWriteAll: true, mayWriteOwn: true, mayDelete: true };
const readOnly = { mayReadItems: true, mayWriteAll: false, mayWriteOwn: false, mayDelete: false };
const calendars = [
  { id: 'work', name: 'Work', isShared: false, isTasksOnly: true, myRights: writable },
  { id: 'personal', name: 'Personal', isShared: false, isTasksOnly: true, myRights: writable },
  { id: 'events', name: 'Events', isShared: false, isDefault: true, myRights: writable },
  { id: 'birthdays', name: 'Birthdays', isShared: false, myRights: readOnly },
  { id: 'feed', name: 'Holidays feed', isShared: false, isTasksOnly: true, myRights: writable },
] as unknown as Calendar[];
const isSubscriptionCalendar = (id: string) => id === 'feed';

describe('task editor calendar select', () => {
  it('lists only the task lists a task can go into', () => {
    render(<TaskModal calendars={calendars} isSubscriptionCalendar={isSubscriptionCalendar} onSave={vi.fn()} onClose={vi.fn()} />);
    const select = screen.getByLabelText('task_list_label');
    const names = within(select).getAllByRole('option').map((o) => o.textContent);
    expect(names).toEqual(['Work', 'Personal']);
  });

  it('keeps the calendar of a task that is already in a read-only one', () => {
    const task = {
      id: 't1', '@type': 'Task', title: 'Card for Ann', calendarIds: { birthdays: true },
      progress: 'needs-action', priority: 0, due: null, showWithoutTime: true, alerts: null,
    } as unknown as CalendarTask;
    render(<TaskModal task={task} calendars={calendars} onSave={vi.fn()} onClose={vi.fn()} />);
    const select = screen.getByLabelText('task_list_label') as HTMLSelectElement;
    expect(select.value).toBe('birthdays');
  });
});

// The desktop task panel had no dialog role, unlike the event editor.
describe('task editor panel', () => {
  it('is a dialog named by its title on wide screens', () => {
    render(<TaskModal calendars={calendars} onSave={vi.fn()} onClose={vi.fn()} />);
    expect(screen.getByRole('dialog', { name: 'tasks.create' })).toBeInTheDocument();
  });

  it('leaves the role to the full-screen wrapper on a phone', () => {
    render(<TaskModal calendars={calendars} onSave={vi.fn()} onClose={vi.fn()} isMobile />);
    expect(screen.queryByRole('dialog')).toBeNull();
  });
});
