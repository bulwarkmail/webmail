import { format, parseISO } from "date-fns";
import type { Calendar, CalendarTask } from "@/lib/jmap/types";

/**
 * Tasks shown on the calendar grid (#1107): only tasks with a due date, and
 * only those in a calendar the sidebar currently shows, the same rule the
 * events follow. A task-only list is never among the selected calendars, so
 * its tasks follow the task list tick (hiddenTaskListIds) instead.
 */
export function filterTasksByCalendars(
  tasks: CalendarTask[],
  selectedCalendarIds: string[],
  calendars: Pick<Calendar, "id" | "isTasksOnly">[] = [],
  hiddenTaskListIds: string[] = [],
): CalendarTask[] {
  const visible = new Set(selectedCalendarIds);
  const hidden = new Set(hiddenTaskListIds);
  for (const cal of calendars) {
    if (!cal.isTasksOnly) continue;
    if (hidden.has(cal.id)) visible.delete(cal.id);
    else visible.add(cal.id);
  }
  return tasks.filter((task) => Object.keys(task.calendarIds ?? {}).some((id) => visible.has(id)));
}

/** yyyy-MM-dd of the day a task is due, or null when it has no valid due date. */
export function taskDueDayKey(task: CalendarTask): string | null {
  if (!task.due) return null;
  const due = parseISO(task.due);
  if (Number.isNaN(due.getTime())) return null;
  return format(due, "yyyy-MM-dd");
}

/**
 * Tasks keyed by the day they are due. Within a day, tasks without a time
 * come first, then by due time and title, so the order does not depend on
 * the order the server returned them in.
 */
export function groupTasksByDueDay(tasks: CalendarTask[] | undefined): Map<string, CalendarTask[]> {
  const map = new Map<string, CalendarTask[]>();
  if (!tasks?.length) return map;
  for (const task of tasks) {
    const key = taskDueDayKey(task);
    if (!key) continue;
    const existing = map.get(key);
    if (existing) existing.push(task);
    else map.set(key, [task]);
  }
  for (const dayTasks of map.values()) {
    dayTasks.sort((a, b) => {
      const aTimed = a.showWithoutTime ? 0 : 1;
      const bTimed = b.showWithoutTime ? 0 : 1;
      if (aTimed !== bTimed) return aTimed - bTimed;
      const byDue = (a.due ?? "").localeCompare(b.due ?? "");
      if (byDue !== 0) return byDue;
      return (a.title ?? "").localeCompare(b.title ?? "");
    });
  }
  return map;
}
