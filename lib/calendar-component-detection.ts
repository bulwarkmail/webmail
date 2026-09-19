/**
 * Helpers for deciding whether a calendar holds only tasks (VTODO) and so
 * should be hidden from the *event* calendar UI (#761).
 *
 * JMAP's Calendar/get on Stalwart exposes no per-calendar supported-component
 * set, so "tasks-only" has to be derived from the objects a calendar contains,
 * mirroring how task objects are already told apart from events elsewhere.
 */

/**
 * A calendar object as seen with the minimal properties we scan. The index
 * signature keeps it tolerant of the other fields the server returns (id, etc.).
 */
export interface ScannedCalendarObject {
  '@type'?: string;
  due?: unknown;
  progress?: unknown;
  percentComplete?: unknown;
  calendarIds?: Record<string, boolean> | null;
  [key: string]: unknown;
}

/**
 * Is this calendar object a task rather than an event? Matches an explicit
 * `@type: "Task"`, and CalDAV-created tasks (which may lack the type) by the
 * presence of RFC 8984 §5.2 Task-only keys (`due` / `progress` /
 * `percentComplete`) - a VEVENT never carries those. Mirrors the existing
 * event/task split so classification stays consistent.
 */
export function isTaskLikeObject(obj: ScannedCalendarObject): boolean {
  const type = obj['@type'];
  if (typeof type === 'string' && type.toLowerCase() === 'task') return true;
  if (type !== 'Event' && (
    ('progress' in obj && typeof obj.progress === 'string') ||
    ('due' in obj && obj.due != null) ||
    ('percentComplete' in obj)
  )) return true;
  return false;
}

export interface CalendarDescriptor {
  id: string;
  name?: string | null;
}

/**
 * Checks if a calendar name strongly indicates a dedicated task list in
 * English or German (e.g. "Aufgaben", "Tasks", "To-Do", "Reminders").
 */
export function isTasksOnlyCalendarName(name?: string | null): boolean {
  if (!name || typeof name !== 'string') return false;
  const normalized = name.trim().toLowerCase();
  if (!normalized) return false;
  const taskNames = new Set([
    'aufgaben',
    'tasks',
    'task',
    'to-do',
    'to-dos',
    'todos',
    'todo',
    'to do',
    'erinnerungen',
    'reminders',
    'reminder',
  ]);
  return taskNames.has(normalized);
}

/**
 * Given every object in an account and the calendars under consideration,
 * return the ids of calendars that hold only tasks (no event), or that are
 * explicitly dedicated task lists by name/collection component type.
 */
export function findTasksOnlyCalendarIds(
  objects: ScannedCalendarObject[],
  calendars: (string | CalendarDescriptor)[],
): Set<string> {
  const withAny = new Set<string>();
  const withEvent = new Set<string>();
  for (const obj of objects) {
    const task = isTaskLikeObject(obj);
    const ids = obj.calendarIds ? Object.keys(obj.calendarIds) : [];
    for (const id of ids) {
      withAny.add(id);
      if (!task) withEvent.add(id);
    }
  }

  const tasksOnly = new Set<string>();
  for (const cal of calendars) {
    const id = typeof cal === 'string' ? cal : cal.id;
    const name = typeof cal === 'string' ? undefined : cal.name;

    if (isTasksOnlyCalendarName(name)) {
      tasksOnly.add(id);
    } else if (withAny.has(id) && !withEvent.has(id)) {
      tasksOnly.add(id);
    }
  }
  return tasksOnly;
}
