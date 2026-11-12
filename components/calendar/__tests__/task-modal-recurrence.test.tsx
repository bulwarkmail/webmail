import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { describe, it, expect, vi } from 'vitest';
import { TaskModal } from '../task-modal';
import type { CalendarTask, Calendar } from '@/lib/jmap/types';
import { createRecurrenceRule } from '@/lib/recurrence-rule';

const calendars = [{ id: 'cal-1', name: 'Tasks', isShared: false }] as unknown as Calendar[];

function makeTask(overrides: Partial<CalendarTask> = {}): CalendarTask {
  return {
    id: 'task-1',
    '@type': 'Task',
    uid: 'uid-1',
    title: 'Lauf 🚶',
    description: '',
    due: '2026-09-21',
    showWithoutTime: true,
    priority: 0,
    progress: 'needs-action',
    progressUpdated: null,
    calendarIds: { 'cal-1': true },
    recurrenceRules: null,
    alerts: null,
    ...overrides,
  } as unknown as CalendarTask;
}

describe('TaskModal recurrence handling', () => {
  it('renders recurrence selector defaulting to none for non-recurring task', () => {
    render(<TaskModal task={makeTask()} calendars={calendars} onSave={vi.fn()} onClose={vi.fn()} />);

    const recurrenceSelect = screen.getByLabelText(/recurrence\.title/i);
    expect(recurrenceSelect).toBeInTheDocument();
    expect((recurrenceSelect as HTMLSelectElement).value).toBe('none');
  });

  it('selects daily recurrence when editing a recurring task', () => {
    const task = makeTask({
      recurrenceRules: [createRecurrenceRule('daily')],
    });
    render(<TaskModal task={task} calendars={calendars} onSave={vi.fn()} onClose={vi.fn()} />);

    const recurrenceSelect = screen.getByLabelText(/recurrence\.title/i);
    expect((recurrenceSelect as HTMLSelectElement).value).toBe('daily');
  });

  it('saves recurrenceRules when user selects daily recurrence on new task', async () => {
    const onSave = vi.fn().mockResolvedValue(undefined);
    render(<TaskModal calendars={calendars} onSave={onSave} onClose={vi.fn()} />);

    fireEvent.change(screen.getByPlaceholderText('tasks.title_placeholder'), { target: { value: 'Daily Jog' } });
    fireEvent.change(screen.getByLabelText(/recurrence\.title/i), { target: { value: 'daily' } });
    fireEvent.click(screen.getByText('tasks.save'));

    await waitFor(() => expect(onSave).toHaveBeenCalledTimes(1));
    const patch = onSave.mock.calls[0][0] as Partial<CalendarTask>;
    expect(patch.title).toBe('Daily Jog');
    expect(patch.recurrenceRules).toHaveLength(1);
    expect(patch.recurrenceRules![0]).toMatchObject({
      '@type': 'RecurrenceRule',
      frequency: 'daily',
    });
  });

  it('does not touch recurrenceRules or start when only editing title or due date of an existing recurring task', async () => {
    const onSave = vi.fn().mockResolvedValue(undefined);
    const rule1 = createRecurrenceRule('daily');
    const rule2 = createRecurrenceRule('weekly');
    const task = makeTask({
      due: '2026-09-21',
      start: '2026-09-21T08:00:00',
      recurrenceRules: [rule1, rule2],
    });
    render(<TaskModal task={task} calendars={calendars} onSave={onSave} onClose={vi.fn()} />);

    // Change only due date
    const dueDateInput = screen.getByDisplayValue('2026-09-21');
    fireEvent.change(dueDateInput, { target: { value: '2026-10-01' } });
    fireEvent.click(screen.getByText('tasks.save'));

    await waitFor(() => expect(onSave).toHaveBeenCalledTimes(1));
    const patch = onSave.mock.calls[0][0] as Partial<CalendarTask>;
    expect(patch.due).toBe('2026-10-01');
    // recurrence was not touched: recurrenceRules is omitted so multiple rules remain on server
    expect(patch.recurrenceRules).toBeUndefined();
    // start was not in the modal: start is omitted so server start is untouched
    expect(patch).not.toHaveProperty('start');
  });

  it('anchors start at due when an existing task without start is made recurring', async () => {
    const onSave = vi.fn().mockResolvedValue(undefined);
    const task = makeTask({
      due: '2026-09-21',
      start: null,
      recurrenceRules: null,
    });
    render(<TaskModal task={task} calendars={calendars} onSave={onSave} onClose={vi.fn()} />);

    fireEvent.change(screen.getByLabelText(/recurrence\.title/i), { target: { value: 'weekly' } });
    fireEvent.click(screen.getByText('tasks.save'));

    await waitFor(() => expect(onSave).toHaveBeenCalledTimes(1));
    const patch = onSave.mock.calls[0][0] as Partial<CalendarTask>;
    expect(patch.recurrenceRules).toHaveLength(1);
    expect(patch.recurrenceRules![0]).toMatchObject({ frequency: 'weekly' });
    expect(patch.start).toBe('2026-09-21');
  });

  it('sets recurrenceRules to null when user removes recurrence from recurring task', async () => {
    const onSave = vi.fn().mockResolvedValue(undefined);
    const task = makeTask({
      recurrenceRules: [createRecurrenceRule('daily')],
    });
    render(<TaskModal task={task} calendars={calendars} onSave={onSave} onClose={vi.fn()} />);

    fireEvent.change(screen.getByLabelText(/recurrence\.title/i), { target: { value: 'none' } });
    fireEvent.click(screen.getByText('tasks.save'));

    await waitFor(() => expect(onSave).toHaveBeenCalledTimes(1));
    const patch = onSave.mock.calls[0][0] as Partial<CalendarTask>;
    expect(patch.recurrenceRules).toBeNull();
  });

  it('saves weekly recurrence when selected on new task', async () => {
    const onSave = vi.fn().mockResolvedValue(undefined);
    render(<TaskModal calendars={calendars} onSave={onSave} onClose={vi.fn()} />);

    fireEvent.change(screen.getByPlaceholderText('tasks.title_placeholder'), { target: { value: 'Weekly Review' } });
    fireEvent.change(screen.getByLabelText(/recurrence\.title/i), { target: { value: 'weekly' } });
    fireEvent.click(screen.getByText('tasks.save'));

    await waitFor(() => expect(onSave).toHaveBeenCalledTimes(1));
    const patch = onSave.mock.calls[0][0] as Partial<CalendarTask>;
    expect(patch.title).toBe('Weekly Review');
    expect(patch.recurrenceRules).toHaveLength(1);
    expect(patch.recurrenceRules![0]).toMatchObject({
      '@type': 'RecurrenceRule',
      frequency: 'weekly',
    });
  });

  it('keeps the modal open when onSave returns false (save failed)', async () => {
    const onSave = vi.fn().mockResolvedValue(false);
    const onClose = vi.fn();
    render(<TaskModal calendars={calendars} onSave={onSave} onClose={onClose} />);

    fireEvent.change(screen.getByPlaceholderText('tasks.title_placeholder'), { target: { value: 'Failing Task' } });
    fireEvent.click(screen.getByText('tasks.save'));

    await waitFor(() => expect(onSave).toHaveBeenCalledTimes(1));
    expect(onClose).not.toHaveBeenCalled();
    expect(screen.getByDisplayValue('Failing Task')).toBeInTheDocument();
  });
});
