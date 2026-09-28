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

/**
 * Given every object in an account and the calendar ids under consideration,
 * return the ids of calendars that hold at least one object and whose objects
 * are ALL tasks (no event). Empty calendars are deliberately NOT included -
 * a brand-new event calendar with nothing in it must stay visible.
 */
export function findTasksOnlyCalendarIds(
  objects: ScannedCalendarObject[],
  calendarIds: string[],
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
  for (const id of calendarIds) {
    if (withAny.has(id) && !withEvent.has(id)) tasksOnly.add(id);
  }
  return tasksOnly;
}
