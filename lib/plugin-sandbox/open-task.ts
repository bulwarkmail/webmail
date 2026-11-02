// A plugin opening one of the user's tasks in Bulwark's task editor
// (api.ui.openTask): what a click on a task in the calendar's task list
// does. A plugin drawing the task view itself (the calendar-task-view slot)
// lists the tasks but cannot open one otherwise. The calendar opens it
// through the handler it sets while it is on screen; without one (another
// page) the request resolves to false. A task the calendar has not loaded
// resolves to false too.

import type { InstalledPlugin, Permission } from '../plugin-types';
import { readId, withinRate } from './host-api-input';
import { pluginHasPermission } from './permissions';

const METHOD = 'ui.openTask';

/** Either one lets a plugin open a task. */
export const OPEN_TASK_PERMISSIONS: readonly Permission[] = ['ui:tasks', 'tasks:read'];

/** At most this many a minute. */
export const TASK_OPENS_PER_MINUTE = 20;

/** Opens the task in the editor: true when it opened, false when the calendar does not have it. */
export type OpenTaskHandler = (taskId: string) => boolean;

// The calendars on screen, the latest mounted last; it takes the request.
const handlers: OpenTaskHandler[] = [];

export function onOpenTask(handler: OpenTaskHandler): () => void {
  handlers.push(handler);
  return () => {
    const at = handlers.lastIndexOf(handler);
    if (at >= 0) handlers.splice(at, 1);
  };
}

/** Checks the request and opens the task: true when the editor opened, else false. */
export function requestOpenTask(plugin: InstalledPlugin, taskId: unknown): boolean {
  if (!OPEN_TASK_PERMISSIONS.some((perm) => pluginHasPermission(plugin, perm))) {
    throw new Error(`Plugin "${plugin.id}" lacks permission "${OPEN_TASK_PERMISSIONS.join('" or "')}"`);
  }
  const id = readId(taskId, METHOD, 'taskId');
  const handler = handlers.at(-1);
  if (!handler) return false;
  if (!withinRate('open-task', plugin.id, TASK_OPENS_PER_MINUTE)) {
    throw new Error(`${METHOD}: at most ${TASK_OPENS_PER_MINUTE} a minute`);
  }
  return handler(id);
}

/** Test helper. */
export function resetOpenTask(): void {
  handlers.length = 0;
}
