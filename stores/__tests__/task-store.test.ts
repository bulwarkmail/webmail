import { describe, it, expect, beforeEach, vi } from 'vitest';
import { useTaskStore } from '../task-store';
import type { CalendarTask } from '@/lib/jmap/types';
import type { IJMAPClient } from '@/lib/jmap/client-interface';

function makeTask(overrides: Partial<CalendarTask> = {}): CalendarTask {
  return {
    id: 'task-1',
    calendarIds: { 'cal-1': true },
    '@type': 'Task',
    uid: 'task-uid-1',
    title: 'Test task',
    description: '',
    due: '2026-09-08T10:00:00',
    start: null,
    duration: null,
    timeZone: null,
    showWithoutTime: false,
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

describe('task-store', () => {
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
      getCalendarTasks: vi.fn().mockResolvedValue([makeTask()]),
      createCalendarTask: vi.fn().mockImplementation(async (t) => makeTask({ id: 'task-created', ...t })),
      updateCalendarTask: vi.fn().mockResolvedValue(undefined),
      deleteCalendarTask: vi.fn().mockResolvedValue(undefined),
    };
  });

  describe('toggleTaskComplete', () => {
    it('toggles needs-action to completed without sending progressUpdated in payload (#958)', async () => {
      const task = makeTask({ id: 't1', progress: 'needs-action' });
      useTaskStore.setState({ tasks: [task] });

      await useTaskStore.getState().toggleTaskComplete(mockClient as IJMAPClient, task);

      expect(mockClient.updateCalendarTask).toHaveBeenCalledTimes(1);
      const [calledId, calledUpdates] = (mockClient.updateCalendarTask as ReturnType<typeof vi.fn>).mock.calls[0];
      expect(calledId).toBe('t1');
      expect(calledUpdates).toEqual({
        progress: 'completed',
      });
      // Stalwart rejects progressUpdated with invalidProperties error
      expect(calledUpdates).not.toHaveProperty('progressUpdated');

      const updatedTask = useTaskStore.getState().tasks.find((t) => t.id === 't1');
      expect(updatedTask?.progress).toBe('completed');
    });

    it('toggles completed back to needs-action without sending progressUpdated in payload', async () => {
      const task = makeTask({ id: 't2', progress: 'completed' });
      useTaskStore.setState({ tasks: [task] });

      await useTaskStore.getState().toggleTaskComplete(mockClient as IJMAPClient, task);

      expect(mockClient.updateCalendarTask).toHaveBeenCalledTimes(1);
      const [calledId, calledUpdates] = (mockClient.updateCalendarTask as ReturnType<typeof vi.fn>).mock.calls[0];
      expect(calledId).toBe('t2');
      expect(calledUpdates).toEqual({
        progress: 'needs-action',
      });
      expect(calledUpdates).not.toHaveProperty('progressUpdated');

      const updatedTask = useTaskStore.getState().tasks.find((t) => t.id === 't2');
      expect(updatedTask?.progress).toBe('needs-action');
    });
  });

  describe('CRUD operations', () => {
    it('fetches tasks and updates store state', async () => {
      await useTaskStore.getState().fetchTasks(mockClient as IJMAPClient, ['cal-1']);

      expect(mockClient.getCalendarTasks).toHaveBeenCalledWith(['cal-1']);
      expect(useTaskStore.getState().tasks).toHaveLength(1);
      expect(useTaskStore.getState().isLoading).toBe(false);
      expect(useTaskStore.getState().error).toBeNull();
    });

    it('creates a task and appends to store', async () => {
      const created = await useTaskStore.getState().createTask(mockClient as IJMAPClient, { title: 'New Task' });

      expect(mockClient.createCalendarTask).toHaveBeenCalledWith({ title: 'New Task' });
      expect(created.id).toBe('task-created');
      expect(useTaskStore.getState().tasks).toContainEqual(created);
    });

    it('updates a task and preserves unchanged fields', async () => {
      const task = makeTask({ id: 't3', title: 'Original Title' });
      useTaskStore.setState({ tasks: [task] });

      await useTaskStore.getState().updateTask(mockClient as IJMAPClient, 't3', { title: 'Updated Title' });

      expect(mockClient.updateCalendarTask).toHaveBeenCalledWith('t3', { title: 'Updated Title' });
      const updated = useTaskStore.getState().tasks.find((t) => t.id === 't3');
      expect(updated?.title).toBe('Updated Title');
      expect(updated?.progress).toBe('needs-action');
    });

    it('deletes a task and resets selectedTaskId if selected', async () => {
      const task = makeTask({ id: 't4' });
      useTaskStore.setState({ tasks: [task], selectedTaskId: 't4' });

      await useTaskStore.getState().deleteTask(mockClient as IJMAPClient, 't4');

      expect(mockClient.deleteCalendarTask).toHaveBeenCalledWith('t4');
      expect(useTaskStore.getState().tasks).toHaveLength(0);
      expect(useTaskStore.getState().selectedTaskId).toBeNull();
    });
  });
});
