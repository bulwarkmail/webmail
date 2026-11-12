import { create } from 'zustand';
import type { CalendarTask } from '@/lib/jmap/types';
import type { IJMAPClient } from '@/lib/jmap/client-interface';
import { debug } from '@/lib/debug';
import { taskHooks } from '@/lib/plugin-hooks';
import { taskToView } from '@/lib/plugin-projection';
import { applyPatchObject, patchedProperties } from '@/lib/jmap/patch-object';
import { getClientByLocalAccountId } from './client-registry';

/**
 * One signed-in login whose tasks the list shows next to the others'
 * (pim-12). Same shape as the calendar store's CalendarAccountClient.
 */
export interface TaskAccountClient {
  localAccountId: string;
  client: IJMAPClient;
}

// Ids of a login's tasks and calendars when the calendar shows several
// logins: `<localAccountId>::<id>`, as the calendar store namespaces them.
const LOGIN_DELIMITER = '::';

function splitLoginId(id: string): { localAccountId: string | null; raw: string } {
  const idx = id.indexOf(LOGIN_DELIMITER);
  return idx >= 0
    ? { localAccountId: id.slice(0, idx), raw: id.slice(idx + LOGIN_DELIMITER.length) }
    : { localAccountId: null, raw: id };
}

function prefixTask(task: CalendarTask, localAccountId: string): CalendarTask {
  const prefix = `${localAccountId}${LOGIN_DELIMITER}`;
  return {
    ...task,
    id: `${prefix}${task.id}`,
    calendarIds: Object.fromEntries(Object.entries(task.calendarIds ?? {}).map(([id, v]) => [`${prefix}${id}`, v])),
    localAccountId,
  };
}

function stripCalendarIds(calendarIds: Record<string, boolean>): { localAccountId: string | null; calendarIds: Record<string, boolean> } {
  let localAccountId: string | null = null;
  const out: Record<string, boolean> = {};
  for (const [id, v] of Object.entries(calendarIds)) {
    const parts = splitLoginId(id);
    localAccountId = localAccountId ?? parts.localAccountId;
    out[parts.raw] = v;
  }
  return { localAccountId, calendarIds: out };
}

/**
 * The client of the login an id names, else `client` for an id that names
 * none. Throws "Not connected" while that login has no client: task ids
 * repeat across accounts, so through another login the same id is another task.
 */
function clientOf(client: IJMAPClient, localAccountId: string | null): IJMAPClient {
  if (!localAccountId) return client;
  const owner = getClientByLocalAccountId(localAccountId);
  if (!owner) throw new Error('Not connected');
  return owner;
}

export type TaskViewFilter = 'all' | 'pending' | 'completed' | 'overdue';

/**
 * The `error` a failed task load leaves. The tasks loaded before stay; the
 * task list shows a notice for it.
 */
export const TASKS_LOAD_ERROR = 'Failed to fetch tasks';

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
  /** Resolves to null when a plugin stopped the create. */
  createTask: (client: IJMAPClient, task: Partial<CalendarTask>) => Promise<CalendarTask | null>;
  /** false when a plugin stopped it (the plugin tells the user why). */
  /**
   * `updates` may name members by path (`alerts/<id>/acknowledged`). `base`
   * is the task as the caller read it, for a task the list does not hold
   * or holds in an older state.
   */
  updateTask: (client: IJMAPClient, id: string, updates: Partial<CalendarTask>, base?: CalendarTask) => Promise<boolean>;
  deleteTask: (client: IJMAPClient, id: string) => Promise<boolean>;
  toggleTaskComplete: (client: IJMAPClient, task: CalendarTask) => Promise<void>;
  clearTasks: () => void;
  /**
   * The logins whose tasks the list shows, set while the calendar shows
   * several logins; null for the active one only. Task and calendar ids
   * are then `<localAccountId>::<id>`, and each change goes through the
   * task's own login.
   */
  accountClients: TaskAccountClient[] | null;
  /** `refetchWith`: loads the list again in the new form when it was loaded. */
  setAccountClients: (accounts: TaskAccountClient[] | null, refetchWith?: IJMAPClient | null) => void;
}

// Each fetch gets a number: only the latest one's answer is kept, so an
// answer that comes late never puts an older list back.
let latestFetch = 0;

export const useTaskStore = create<TaskStore>((set, get) => ({
  tasks: [],
  selectedTaskId: null,
  filter: 'all',
  showCompleted: false,
  isLoading: false,
  error: null,
  accountClients: null,
  setAccountClients: (accounts, refetchWith) => {
    const before = get().accountClients;
    const same = before === accounts || (!!before && !!accounts && before.length === accounts.length
      && before.every((a, i) => a.localAccountId === accounts[i].localAccountId && a.client === accounts[i].client));
    if (same) return;
    const loaded = get().tasks.length > 0 || get().isLoading;
    // The ids change form: tasks of the old form must not stay.
    latestFetch += 1;
    set({ accountClients: accounts, tasks: [], selectedTaskId: null, isLoading: false });
    if (loaded && refetchWith) void get().fetchTasks(refetchWith);
  },
  setTasks: (tasks) => set({ tasks }),
  setSelectedTaskId: (id) => set({ selectedTaskId: id }),
  setFilter: (filter) => {
    if (get().filter === filter) return;
    set({ filter });
    void taskHooks.onTaskFilterChange.emit({ filter, showCompleted: get().showCompleted });
  },
  setShowCompleted: (show) => {
    if (get().showCompleted === show) return;
    set({ showCompleted: show });
    void taskHooks.onTaskFilterChange.emit({ filter: get().filter, showCompleted: show });
  },

  fetchTasks: async (client, calendarIds) => {
    debug.log('tasks', 'TaskStore/fetchTasks start', { calendarIds: calendarIds || 'all' });
    const fetch = ++latestFetch;
    const stillCurrent = () => fetch === latestFetch;
    set({ isLoading: true, error: null });
    try {
      const accounts = get().accountClients;
      const tasks = accounts
        ? (await Promise.all(accounts.map(async (a) => {
            const own = calendarIds
              ?.map(splitLoginId)
              .filter((parts) => parts.localAccountId === a.localAccountId)
              .map((parts) => parts.raw);
            if (own && own.length === 0) return [];
            const list = await a.client.getCalendarTasks(own);
            return list.map((task) => prefixTask(task, a.localAccountId));
          }))).flat()
        : await client.getCalendarTasks(calendarIds);
      // A fetch started later decides the list.
      if (!stillCurrent()) return;
      debug.log('tasks', 'TaskStore/fetchTasks received', tasks.length, 'tasks');
      tasks.forEach((t, i) => {
        debug.log('tasks', `TaskStore/fetchTasks [${i}]`, {
          id: t.id, uid: t.uid, '@type': t['@type'],
          title: t.title, due: t.due, progress: t.progress,
          showWithoutTime: t.showWithoutTime, calendarIds: t.calendarIds,
        });
      });
      set({ tasks, isLoading: false });
      if (taskHooks.onTasksLoaded.size > 0) void taskHooks.onTasksLoaded.emit(tasks.map(taskToView));
    } catch (error) {
      debug.error('TaskStore/fetchTasks failed', error);
      if (stillCurrent()) set({ isLoading: false, error: TASKS_LOAD_ERROR });
    }
  },

  createTask: async (client, task) => {
    debug.log('tasks', 'TaskStore/createTask', task);
    if (!(await taskHooks.onBeforeTaskCreate.intercept(taskToView({ id: '', ...task } as CalendarTask)))) return null;
    const target = stripCalendarIds(task.calendarIds ?? {});
    const created = target.localAccountId
      ? prefixTask(await clientOf(client, target.localAccountId).createCalendarTask({ ...task, calendarIds: target.calendarIds }), target.localAccountId)
      : await client.createCalendarTask(task);
    debug.log('tasks', 'TaskStore/createTask result', { id: created.id, uid: created.uid, title: created.title });
    set({ tasks: [...get().tasks, created] });
    void taskHooks.onTaskCreate.emit(taskToView(created));
    return created;
  },

  updateTask: async (client, id, updates, base) => {
    const before = base ?? get().tasks.find(t => t.id === id);
    // `updates` may name members by path (`alerts/<id>/acknowledged`);
    // plugins read the patch as whole properties.
    const patch = patchedProperties(before ?? { id }, updates);
    if (!(await taskHooks.onBeforeTaskUpdate.intercept({ taskId: id, patch }))) return false;
    const source = splitLoginId(id);
    let newId: string;
    if (source.localAccountId) {
      const dest = updates.calendarIds ? stripCalendarIds(updates.calendarIds) : null;
      const sourceClient = clientOf(client, source.localAccountId);
      if (dest?.localAccountId && dest.localAccountId !== source.localAccountId && before) {
        // Into a list of another login: make it there, then remove it here.
        // In that order, so a failed create leaves the task where it was.
        const { id: _id, localAccountId: _l, originalId: _o, accountId: _a, isShared: _s, ...rest } = before;
        const moved = applyPatchObject(rest, { ...updates, calendarIds: dest.calendarIds }) as Partial<CalendarTask>;
        const created = await clientOf(client, dest.localAccountId).createCalendarTask(moved);
        await sourceClient.deleteCalendarTask(source.raw);
        newId = prefixTask(created, dest.localAccountId).id;
      } else {
        const raw = await sourceClient.updateCalendarTask(source.raw, dest ? { ...updates, calendarIds: dest.calendarIds } : updates);
        newId = !raw || raw === source.raw ? id : `${source.localAccountId}${LOGIN_DELIMITER}${raw}`;
      }
    } else {
      newId = await client.updateCalendarTask(id, updates);
    }
    if (newId && newId !== id) {
      // Moved into a calendar of another account: the server recreated it
      // under a new id, so reload rather than patch the old entry. (#1204)
      set({ selectedTaskId: get().selectedTaskId === id ? newId : get().selectedTaskId });
      await get().fetchTasks(client);
      const moved = get().tasks.find(t => t.id === newId)
        ?? ({ ...applyPatchObject(before ?? {}, updates), id: newId } as CalendarTask);
      void taskHooks.onTaskUpdate.emit(taskToView(moved));
      return true;
    }
    // Applied to the task the caller read, else as the store holds it now:
    // another update may have finished meanwhile (two alerts acknowledged
    // at once).
    const current = base ?? get().tasks.find(t => t.id === id) ?? { id };
    const updated = { ...applyPatchObject(current, updates), updated: new Date().toISOString() } as CalendarTask;
    set({
      tasks: get().tasks.map(t => t.id === id ? updated : t),
    });
    void taskHooks.onTaskUpdate.emit(taskToView(updated));
    return true;
  },

  deleteTask: async (client, id) => {
    const title = get().tasks.find(t => t.id === id)?.title || '';
    if (!(await taskHooks.onBeforeTaskDelete.intercept({ taskId: id, title }))) return false;
    const target = splitLoginId(id);
    await clientOf(client, target.localAccountId).deleteCalendarTask(target.raw);
    set({
      tasks: get().tasks.filter(t => t.id !== id),
      selectedTaskId: get().selectedTaskId === id ? null : get().selectedTaskId,
    });
    void taskHooks.onTaskDelete.emit({ taskId: id, title });
    return true;
  },

  toggleTaskComplete: async (client, task) => {
    const newProgress = task.progress === 'completed' ? 'needs-action' : 'completed';
    const updates: Partial<CalendarTask> = {
      progress: newProgress,
    };
    const target = splitLoginId(task.id);
    await clientOf(client, target.localAccountId).updateCalendarTask(target.raw, updates);
    set({
      tasks: get().tasks.map(t => t.id === task.id ? { ...t, ...updates, updated: new Date().toISOString() } : t),
    });
    // A toggle is reported as onTaskToggleComplete only, not also as
    // onTaskUpdate, so a plugin that listens to both sees each change once.
    void taskHooks.onTaskToggleComplete.emit({ taskId: task.id, complete: newProgress === 'completed' });
  },

  clearTasks: () => {
    latestFetch += 1;
    set({ tasks: [], selectedTaskId: null, error: null, isLoading: false });
  },
}));

/**
 * Drops the tasks of login `localAccountId` (the calendar lists every
 * login's): it was removed, or has no client for longer, so nothing done to
 * them could reach its server.
 */
export function forgetLoginTasks(localAccountId: string): void {
  const ofLogin = (task: CalendarTask) => task.localAccountId === localAccountId;
  if (!useTaskStore.getState().tasks.some(ofLogin)) return;
  useTaskStore.setState((s) => {
    const gone = new Set(s.tasks.filter(ofLogin).map((task) => task.id));
    return {
      tasks: s.tasks.filter((task) => !ofLogin(task)),
      selectedTaskId: s.selectedTaskId && gone.has(s.selectedTaskId) ? null : s.selectedTaskId,
    };
  });
}
