import { create } from 'zustand';
import type { CalendarTask } from '@/lib/jmap/types';
import type { IJMAPClient } from '@/lib/jmap/client-interface';
import { debug } from '@/lib/debug';

export type TaskViewFilter = 'all' | 'pending' | 'completed' | 'overdue';

interface TaskStore {
  tasks: CalendarTask[];
  selectedTaskId: string | null;
  filter: TaskViewFilter;
  showCompleted: boolean;
  isLoading: boolean;
  error: string | null;
  setTasks: (tasks: CalendarTask[]) => void;
  setSelectedTaskId: (id: string | null) => void;
  setFilter: (filter: TaskViewFilter) => void;
  setShowCompleted: (show: boolean) => void;
  fetchTasks: (client: IJMAPClient, calendarIds?: string[]) => Promise<void>;
  createTask: (client: IJMAPClient, task: Partial<CalendarTask>) => Promise<CalendarTask>;
  updateTask: (client: IJMAPClient, id: string, updates: Partial<CalendarTask>) => Promise<void>;
  deleteTask: (client: IJMAPClient, id: string) => Promise<void>;
  toggleTaskComplete: (client: IJMAPClient, task: CalendarTask) => Promise<void>;
  clearTasks: () => void;
}

export const useTaskStore = create<TaskStore>((set, get) => ({
  tasks: [],
  selectedTaskId: null,
  filter: 'all',
  showCompleted: false,
  isLoading: false,
  error: null,
  setTasks: (tasks) => set({ tasks }),
  setSelectedTaskId: (id) => set({ selectedTaskId: id }),
  setFilter: (filter) => set({ filter }),
  setShowCompleted: (show) => set({ showCompleted: show }),

  fetchTasks: async (client, calendarIds) => {
    debug.log('TaskStore/fetchTasks start', { calendarIds: calendarIds || 'all' });
    set({ isLoading: true, error: null });
    try {
      const tasks = await client.getCalendarTasks(calendarIds);
      debug.log('TaskStore/fetchTasks received', tasks.length, 'tasks');
      tasks.forEach((t, i) => {
        debug.log(`TaskStore/fetchTasks [${i}]`, {
          id: t.id, uid: t.uid, '@type': t['@type'],
          title: t.title, due: t.due, progress: t.progress,
          showWithoutTime: t.showWithoutTime, calendarIds: t.calendarIds,
        });
      });
      set({ tasks, isLoading: false });
    } catch (error) {
      debug.error('TaskStore/fetchTasks failed', error);
      set({ isLoading: false, error: 'Failed to fetch tasks' });
    }
  },

  createTask: async (client, task) => {
    debug.log('TaskStore/createTask', task);
    const created = await client.createCalendarTask(task);
    debug.log('TaskStore/createTask result', { id: created.id, uid: created.uid, title: created.title });
    set({ tasks: [...get().tasks, created] });
    return created;
  },

  updateTask: async (client, id, updates) => {
    await client.updateCalendarTask(id, updates);
    set({
      tasks: get().tasks.map(t => t.id === id ? { ...t, ...updates, updated: new Date().toISOString() } : t),
    });
  },

  deleteTask: async (client, id) => {
    await client.deleteCalendarTask(id);
    set({
      tasks: get().tasks.filter(t => t.id !== id),
      selectedTaskId: get().selectedTaskId === id ? null : get().selectedTaskId,
    });
  },

  toggleTaskComplete: async (client, task) => {
    const newProgress = task.progress === 'completed' ? 'needs-action' : 'completed';
    const updates: Partial<CalendarTask> = {
      progress: newProgress,
      progressUpdated: new Date().toISOString(),
    };
    await client.updateCalendarTask(task.id, updates);
    set({
      tasks: get().tasks.map(t => t.id === task.id ? { ...t, ...updates, updated: new Date().toISOString() } : t),
    });
  },

  clearTasks: () => set({ tasks: [], selectedTaskId: null, error: null }),
}));
