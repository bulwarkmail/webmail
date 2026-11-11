import { create } from 'zustand';
import { format, parseISO } from 'date-fns';
import type { CalendarTask } from '@/lib/jmap/types';
import type { IJMAPClient } from '@/lib/jmap/client-interface';
import { debug } from '@/lib/debug';
import { taskHooks } from '@/lib/plugin-hooks';
import { taskToView } from '@/lib/plugin-projection';
import { applyPatchObject, patchedProperties } from '@/lib/jmap/patch-object';
import { getClientByLocalAccountId } from './client-registry';
import { getNextRecurrenceDate } from '@/lib/recurrence-expansion';
import { findTaskOverride, occurrenceRecurrenceId, overridePatch, taskSeriesId } from '@/lib/calendar-tasks';

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

/** The client of the login an id names, else `client`. */
function clientOf(client: IJMAPClient, localAccountId: string | null): IJMAPClient {
  if (!localAccountId) return client;
  return getClientByLocalAccountId(localAccountId) ?? client;
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
    // Expanded occurrences carry recurrenceId and their master's id in
    // seriesId; a `:` in the id is no sign of one, other logins' and shared
    // accounts' ids have it. originalId is a shared task's id in its account.
    const isOccurrence = !!task.recurrenceId && !!task.seriesId;
    const masterId = taskSeriesId(task);
    const master = get().tasks.find((t) => t.id === masterId) || task;
    const recurrenceId = occurrenceRecurrenceId(task);

    if (isOccurrence && recurrenceId) {
      const isCompleted = task.progress === 'completed';
      const newProgress: CalendarTask['progress'] = isCompleted ? 'needs-action' : 'completed';
      const existingEntry = findTaskOverride(master.recurrenceOverrides, recurrenceId) || {};
      const overrideEntry: Partial<CalendarTask> & { excluded?: boolean } = {
        ...existingEntry,
        progress: newProgress,
      };
      delete (overrideEntry as Record<string, unknown>).id;
      delete (overrideEntry as Record<string, unknown>).uid;
      delete (overrideEntry as Record<string, unknown>)['@type'];
      delete (overrideEntry as Record<string, unknown>).calendarIds;
      delete (overrideEntry as Record<string, unknown>).recurrenceRules;
      delete (overrideEntry as Record<string, unknown>).recurrenceOverrides;

      const target = splitLoginId(masterId);
      await clientOf(client, target.localAccountId).updateCalendarTask(target.raw, overridePatch(master, recurrenceId, overrideEntry as Record<string, unknown>));
      set({
        tasks: get().tasks.map((t) => {
          if (t.id !== masterId) return t;
          const current = t.recurrenceOverrides || {};
          return {
            ...t,
            recurrenceOverrides: { ...current, [recurrenceId]: overrideEntry },
            updated: new Date().toISOString(),
          };
        }),
      });
      // Plugins know the series' id, not the occurrence's.
      void taskHooks.onTaskToggleComplete.emit({ taskId: masterId, complete: newProgress === 'completed' });
      return;
    }

    let updates: Partial<CalendarTask>;

    if (task.progress !== 'completed' && task.recurrenceRules?.length) {
      const refDateStr = task.due || task.start;
      const refDate = refDateStr ? parseISO(refDateStr) : new Date();
      const nextDate = !isNaN(refDate.getTime())
        ? getNextRecurrenceDate(refDate, task.recurrenceRules[0])
        : null;

      if (nextDate) {
        // LocalDateTime also for all-day tasks: keeps consistency across serializations
        const dateFormat = task.showWithoutTime ? "yyyy-MM-dd'T'00:00:00" : "yyyy-MM-dd'T'HH:mm:ss";
        const newDue = task.due ? format(nextDate, dateFormat) : null;
        let newStart = task.start;
        if (task.start && task.due) {
          const oldDue = parseISO(task.due);
          const oldStart = parseISO(task.start);
          if (!isNaN(oldDue.getTime()) && !isNaN(oldStart.getTime())) {
            const shiftMs = nextDate.getTime() - oldDue.getTime();
            const shiftedStart = new Date(oldStart.getTime() + shiftMs);
            newStart = format(shiftedStart, dateFormat);
          }
        }
        // Moving the anchor restarts the count, so the completed occurrence is used up here.
        const [rule, ...otherRules] = task.recurrenceRules;
        updates = {
          progress: 'needs-action',
          ...(newDue ? { due: newDue } : {}),
          ...(newStart ? { start: newStart } : {}),
          ...(rule.count != null ? { recurrenceRules: [{ ...rule, count: rule.count - 1 }, ...otherRules] } : {}),
        };
      } else {
        updates = { progress: 'completed' };
      }
    } else {
      const newProgress = task.progress === 'completed' ? 'needs-action' : 'completed';
      updates = { progress: newProgress };
    }

    const target = splitLoginId(masterId);
    await clientOf(client, target.localAccountId).updateCalendarTask(target.raw, updates);
    set({
      tasks: get().tasks.map(t => t.id === masterId ? { ...t, ...updates, updated: new Date().toISOString() } : t),
    });
    // A toggle is reported as onTaskToggleComplete only, not also as
    // onTaskUpdate, so a plugin that listens to both sees each change once.
    void taskHooks.onTaskToggleComplete.emit({ taskId: task.id, complete: task.progress !== 'completed' });
  },

  clearTasks: () => {
    latestFetch += 1;
    set({ tasks: [], selectedTaskId: null, error: null, isLoading: false });
  },
}));
