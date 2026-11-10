import { describe, it, expect, beforeEach, vi } from 'vitest';
import { useTaskStore } from '../task-store';
import type { CalendarTask } from '@/lib/jmap/types';
import type { IJMAPClient } from '@/lib/jmap/client-interface';
import { createRecurrenceRule } from '@/lib/recurrence-rule';
import { groupTasksByDueDay } from '@/lib/calendar-tasks';

function makeTask(overrides: Partial<CalendarTask> = {}): CalendarTask {
  return {
    id: 'task-1',
    calendarIds: { 'cal-1': true },
    '@type': 'Task',
    uid: 'task-uid-1',
    title: 'Test task',
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
    created: '2026-09-01T10:00:00Z',
    updated: '2026-09-01T10:00:00Z',
    recurrenceRules: null,
    alerts: null,
    relatedTo: null,
    ...overrides,
  };
}

describe('task-store recurring toggleTaskComplete', () => {
  let mockClient: Partial<IJMAPClient>;

  beforeEach(() => {
    useTaskStore.setState({
      tasks: [],
      selectedTaskId: null,
      filter: 'all',
      showCompleted: false,
      isLoading: false,
      error: null,
    });

    mockClient = {
      updateCalendarTask: vi.fn().mockResolvedValue(undefined),
    };
  });

  it('advances due date to next occurrence and keeps progress as needs-action for recurring tasks', async () => {
    const task = makeTask({
      id: 't-walk',
      title: 'Lauf 🚶',
      due: '2026-09-20',
      showWithoutTime: true,
      progress: 'needs-action',
      recurrenceRules: [createRecurrenceRule('daily')],
    });
    useTaskStore.setState({ tasks: [task] });

    await useTaskStore.getState().toggleTaskComplete(mockClient as IJMAPClient, task);

    expect(mockClient.updateCalendarTask).toHaveBeenCalledTimes(1);
    const [calledId, calledUpdates] = (mockClient.updateCalendarTask as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(calledId).toBe('t-walk');
    expect(calledUpdates).toMatchObject({
      due: '2026-09-21T00:00:00',
      progress: 'needs-action',
    });

    const updatedTask = useTaskStore.getState().tasks.find((t) => t.id === 't-walk');
    expect(updatedTask?.due).toBe('2026-09-21T00:00:00');
    expect(updatedTask?.progress).toBe('needs-action');
  });

  it('preserves due time when advancing timed recurring tasks', async () => {
    const task = makeTask({
      id: 't-timed',
      title: 'Weekly Standup',
      due: '2026-09-21T09:30:00',
      showWithoutTime: false,
      progress: 'needs-action',
      recurrenceRules: [createRecurrenceRule('weekly')],
    });
    useTaskStore.setState({ tasks: [task] });

    await useTaskStore.getState().toggleTaskComplete(mockClient as IJMAPClient, task);

    const [calledId, calledUpdates] = (mockClient.updateCalendarTask as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(calledId).toBe('t-timed');
    expect(calledUpdates).toMatchObject({
      due: '2026-09-28T09:30:00',
      progress: 'needs-action',
    });
  });

  it('uses up one occurrence of a counted series per completion, so the series still ends', async () => {
    const task = makeTask({
      id: 't-count',
      due: '2026-09-20T00:00:00',
      recurrenceRules: [createRecurrenceRule('daily', { count: 3 })],
    });
    useTaskStore.setState({ tasks: [task] });

    for (let i = 0; i < 3; i++) {
      const current = useTaskStore.getState().tasks[0];
      await useTaskStore.getState().toggleTaskComplete(mockClient as IJMAPClient, current);
    }

    const calls = (mockClient.updateCalendarTask as ReturnType<typeof vi.fn>).mock.calls.map((c) => c[1]);
    expect(calls[0]).toMatchObject({ due: '2026-09-21T00:00:00', recurrenceRules: [expect.objectContaining({ count: 2 })] });
    expect(calls[1]).toMatchObject({ due: '2026-09-22T00:00:00', recurrenceRules: [expect.objectContaining({ count: 1 })] });
    expect(calls[2]).toEqual({ progress: 'completed' });
    expect(useTaskStore.getState().tasks[0]).toMatchObject({ due: '2026-09-22T00:00:00', progress: 'completed' });
  });

  it('sets progress to completed when the final recurrence occurrence is completed', async () => {
    const task = makeTask({
      id: 't-final',
      title: 'Final task',
      due: '2026-09-20',
      showWithoutTime: true,
      progress: 'needs-action',
      recurrenceRules: [createRecurrenceRule('daily', { count: 1 })],
    });
    useTaskStore.setState({ tasks: [task] });

    await useTaskStore.getState().toggleTaskComplete(mockClient as IJMAPClient, task);

    const [calledId, calledUpdates] = (mockClient.updateCalendarTask as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(calledId).toBe('t-final');
    expect(calledUpdates).toEqual({
      progress: 'completed',
    });
  });

  it('completes an individual occurrence with recurrenceOverrides without mutating master series interval', async () => {
    const master = makeTask({
      id: 't-walk',
      title: 'Lauf 🚶',
      due: '2026-09-20T07:00:00',
      showWithoutTime: false,
      progress: 'needs-action',
      recurrenceRules: [createRecurrenceRule('weekly')],
    });
    useTaskStore.setState({ tasks: [master] });

    const occurrence: CalendarTask = {
      ...master,
      id: 't-walk:2026-09-27T07:00:00',
      originalId: 't-walk',
      recurrenceId: '2026-09-27T07:00:00',
      due: '2026-09-27T07:00:00',
    };

    await useTaskStore.getState().toggleTaskComplete(mockClient as IJMAPClient, occurrence);

    expect(mockClient.updateCalendarTask).toHaveBeenCalledTimes(1);
    const [calledId, calledUpdates] = (mockClient.updateCalendarTask as ReturnType<typeof vi.fn>).mock.calls[0];
    // Master task must be targeted, NEVER the synthetic occurrence ID!
    expect(calledId).toBe('t-walk');
    expect(calledUpdates).toMatchObject({
      recurrenceOverrides: {
        '2026-09-27T07:00:00': {
          progress: 'completed',
        },
      },
    });

    const updatedMaster = useTaskStore.getState().tasks.find((t) => t.id === 't-walk');
    expect(updatedMaster?.recurrenceOverrides?.['2026-09-27T07:00:00']).toMatchObject({
      progress: 'completed',
    });
  });

  it('uncompletes an occurrence if it was already completed', async () => {
    const master = makeTask({
      id: 't-walk',
      title: 'Lauf 🚶',
      due: '2026-09-20T07:00:00',
      showWithoutTime: false,
      progress: 'needs-action',
      recurrenceRules: [createRecurrenceRule('weekly')],
      recurrenceOverrides: {
        '2026-09-27T07:00:00': { progress: 'completed' },
      },
    });
    useTaskStore.setState({ tasks: [master] });

    const occurrence: CalendarTask = {
      ...master,
      id: 't-walk:2026-09-27T07:00:00',
      originalId: 't-walk',
      recurrenceId: '2026-09-27T07:00:00',
      due: '2026-09-27T07:00:00',
      progress: 'completed',
    };

    await useTaskStore.getState().toggleTaskComplete(mockClient as IJMAPClient, occurrence);

    expect(mockClient.updateCalendarTask).toHaveBeenCalledTimes(1);
    const [calledId, calledUpdates] = (mockClient.updateCalendarTask as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(calledId).toBe('t-walk');
    expect(calledUpdates).toMatchObject({
      'recurrenceOverrides/2026-09-27T07:00:00': {
        progress: 'needs-action',
      },
    });
  });

  it('completes an occurrence of an all-day series with a recurrence override', async () => {
    const master = makeTask({
      id: 't-bin',
      due: '2026-09-20',
      showWithoutTime: true,
      recurrenceRules: [createRecurrenceRule('weekly')],
    });
    useTaskStore.setState({ tasks: [master] });
    const occurrence: CalendarTask = {
      ...master,
      id: 't-bin:2026-09-27T00:00:00',
      originalId: 't-bin',
      recurrenceId: '2026-09-27T00:00:00',
      due: '2026-09-27',
    };

    await useTaskStore.getState().toggleTaskComplete(mockClient as IJMAPClient, occurrence);

    expect(mockClient.updateCalendarTask).toHaveBeenCalledWith('t-bin', {
      recurrenceOverrides: {
        '2026-09-27T00:00:00': expect.objectContaining({ progress: 'completed' }),
      },
    });
    expect(useTaskStore.getState().tasks[0].recurrenceOverrides?.['2026-09-27T00:00:00']).toMatchObject({
      progress: 'completed',
    });
  });

  it('completes the first occurrence of an all-day series with an override when passed as occurrence', async () => {
    const master = makeTask({
      id: 't-bin',
      due: '2026-09-20',
      showWithoutTime: true,
      recurrenceRules: [createRecurrenceRule('weekly')],
    });
    useTaskStore.setState({ tasks: [master] });
    const current: CalendarTask = {
      ...master,
      id: 't-bin:2026-09-20T00:00:00',
      originalId: 't-bin',
      recurrenceId: '2026-09-20T00:00:00',
    };

    await useTaskStore.getState().toggleTaskComplete(mockClient as IJMAPClient, current);

    expect(mockClient.updateCalendarTask).toHaveBeenCalledWith('t-bin', {
      recurrenceOverrides: {
        '2026-09-20T00:00:00': expect.objectContaining({ progress: 'completed' }),
      },
    });
    expect(useTaskStore.getState().tasks[0].recurrenceOverrides?.['2026-09-20T00:00:00']).toMatchObject({
      progress: 'completed',
    });
  });
});

describe('task-store updateTask with override patch paths', () => {
  it('removes an override patched to null, so the reloaded view does not break', async () => {
    const master = makeTask({
      id: 't-split',
      due: '2026-10-07T09:00:00',
      showWithoutTime: false,
      recurrenceRules: [createRecurrenceRule('weekly')],
      recurrenceOverrides: { '2026-10-21T09:00:00': { progress: 'completed' }, '2026-10-07T09:00:00': { title: 'early' } },
    });
    useTaskStore.setState({ tasks: [master] });
    const client = { updateCalendarTask: vi.fn().mockResolvedValue(undefined) } as Partial<IJMAPClient>;

    await useTaskStore.getState().updateTask(client as IJMAPClient, 't-split', { 'recurrenceOverrides/2026-10-21T09:00:00': null } as never);

    const task = useTaskStore.getState().tasks[0];
    expect(task.recurrenceOverrides).toEqual({ '2026-10-07T09:00:00': { title: 'early' } });
    expect(() => groupTasksByDueDay([task], { start: new Date('2026-10-01'), end: new Date('2026-10-31') })).not.toThrow();
  });
});
