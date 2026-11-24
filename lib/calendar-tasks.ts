import { addDays, differenceInCalendarDays, format, parseISO, startOfDay, endOfDay } from "date-fns";
import type { Calendar, CalendarTask } from "@/lib/jmap/types";
import { generateDates } from "@/lib/recurrence-expansion";

export interface TaskDateRange {
  start: Date;
  end: Date;
}

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
 * Moves a LocalDateTime by the wall-clock distance between two others: whole
 * days plus minutes of the day. Milliseconds would turn 10:00 into 09:00 or
 * 11:00 when a DST switch lies between them.
 */
function shiftLocal(value: Date, from: Date, to: Date): Date {
  const minuteOfDay = (d: Date) => d.getHours() * 60 + d.getMinutes();
  const total = minuteOfDay(value) + minuteOfDay(to) - minuteOfDay(from);
  const carry = Math.floor(total / 1440);
  const minutes = total - carry * 1440;
  const day = addDays(value, differenceInCalendarDays(to, from) + carry);
  return new Date(day.getFullYear(), day.getMonth(), day.getDate(), Math.floor(minutes / 60), minutes % 60, value.getSeconds());
}

type TaskOverride = Partial<CalendarTask> & { excluded?: boolean };

/**
 * recurrenceOverrides key of a task occurrence. JSCalendar keys overrides by
 * LocalDateTime, also for all-day tasks (T00:00:00), as the event expansion does.
 */
export function taskRecurrenceId(task: Pick<CalendarTask, "showWithoutTime">, date: Date): string {
  return format(date, task.showWithoutTime ? "yyyy-MM-dd'T'00:00:00" : "yyyy-MM-dd'T'HH:mm:ss");
}

/** Override for an occurrence; also finds entries written under the former date-only key. */
export function findTaskOverride(
  overrides: Record<string, unknown> | null | undefined,
  recurrenceId: string,
): TaskOverride | undefined {
  if (!overrides) return undefined;
  return (overrides[recurrenceId] ?? (recurrenceId.endsWith("T00:00:00") ? overrides[recurrenceId.slice(0, 10)] : undefined)) as TaskOverride | undefined;
}

/** Adds one virtual occurrence of a recurring task, on the day it is (possibly overridden to be) due. `date` is its due date. */
function addOccurrence(
  map: Map<string, CalendarTask[]>,
  task: CalendarTask,
  date: Date,
  recurrenceId: string,
  override: TaskOverride | undefined,
): void {
  const key = format(date, "yyyy-MM-dd");
  const occTask: CalendarTask = {
    ...task,
    ...(override || {}),
    id: `${task.id}:${recurrenceId}`,
    // originalId stays the shared account's own id of the task (#1204).
    seriesId: task.id,
    recurrenceId,
    due: override?.due || (task.showWithoutTime ? key : format(date, "yyyy-MM-dd'T'HH:mm:ss")),
  };
  const dayKey = taskDueDayKey(occTask) || key;
  const existing = map.get(dayKey);
  if (existing) existing.push(occTask);
  else map.set(dayKey, [occTask]);
}

/** The id of the task an expanded occurrence repeats, else the task's own id. */
export function taskSeriesId(task: CalendarTask): string {
  return task.seriesId ?? task.id;
}

/** recurrenceOverrides key of an occurrence, or of the task's own due date when it is not an expanded occurrence. */
export function occurrenceRecurrenceId(task: CalendarTask): string | null {
  if (task.recurrenceId) return task.recurrenceId;
  if (!task.due) return null;
  const due = parseISO(task.due);
  return Number.isNaN(due.getTime()) ? null : taskRecurrenceId(task, due);
}

/**
 * JMAP patch setting one override on the master: a patch path into an existing
 * recurrenceOverrides map, the whole map when there is none yet.
 */
export function overridePatch(
  master: CalendarTask,
  recurrenceId: string,
  entry: Record<string, unknown>,
): Partial<CalendarTask> {
  const cleanEntry = { ...entry };
  if (typeof cleanEntry.due === 'string' && !cleanEntry.due.includes('T')) {
    cleanEntry.due = `${cleanEntry.due}T00:00:00`;
  }

  const hasOverrides = Object.keys(master.recurrenceOverrides ?? {}).length > 0;
  const patch: Record<string, unknown> = hasOverrides
    ? { [`recurrenceOverrides/${recurrenceId}`]: cleanEntry }
    : { recurrenceOverrides: { [recurrenceId]: cleanEntry } };

  return patch as Partial<CalendarTask>;
}

/**
 * Tasks keyed by the day they are due. When a range is provided, recurring
 * tasks are expanded into virtual occurrences for each due date falling
 * inside that range.
 *
 * Within a day, tasks without a time come first, then by due time and title,
 * so the order does not depend on the order the server returned them in.
 */
export function groupTasksByDueDay(
  tasks: CalendarTask[] | undefined,
  range?: TaskDateRange,
): Map<string, CalendarTask[]> {
  const map = new Map<string, CalendarTask[]>();
  if (!tasks?.length) return map;

  const rangeStart = range ? startOfDay(range.start) : null;
  const rangeEnd = range ? endOfDay(range.end) : null;

  for (const task of tasks) {
    if (!task.due) continue;
    const taskDue = parseISO(task.due);
    if (Number.isNaN(taskDue.getTime())) continue;

    if (rangeStart && rangeEnd && task.recurrenceRules?.length) {
      // Recurring task with date range: expand occurrences. RFC 5545 repeats
      // from DTSTART (`start`) and keys each occurrence by its start; it is due
      // at the same distance after it. Without a start, from due.
      const taskStart = task.start ? parseISO(task.start) : null;
      const anchor = taskStart && !Number.isNaN(taskStart.getTime()) ? taskStart : taskDue;
      const dueOf = (occurrenceStart: Date) => shiftLocal(occurrenceStart, anchor, taskDue);
      const startOf = (due: Date) => shiftLocal(due, taskDue, anchor);
      const startsFrom = startOf(rangeStart);
      const startsUntil = startOf(rangeEnd);
      const overrides = (task.recurrenceOverrides || {}) as Record<string, TaskOverride>;
      const seenDates = new Set<string>();
      for (const rule of task.recurrenceRules) {
        const starts = generateDates(anchor, rule, startsFrom, startsUntil, true);
        for (const occurrenceStart of starts) {
          const key = format(occurrenceStart, "yyyy-MM-dd");
          if (seenDates.has(key)) continue;
          seenDates.add(key);

          const recurrenceId = taskRecurrenceId(task, occurrenceStart);
          const override = findTaskOverride(overrides, recurrenceId);
          if (override?.excluded) continue;

          addOccurrence(map, task, dueOf(occurrenceStart), recurrenceId, override);
        }
      }

      // Add overrides that define dates not generated by rules (e.g. past completed occurrences or RDATE)
      for (const [overrideKey, override] of Object.entries(overrides)) {
        if (override.excluded) continue;
        const overrideStart = parseISO(overrideKey);
        if (isNaN(overrideStart.getTime())) continue;
        if (overrideStart < startsFrom || overrideStart > startsUntil) continue;

        const key = format(overrideStart, "yyyy-MM-dd");
        if (seenDates.has(key)) continue;
        seenDates.add(key);
        const recurrenceId = taskRecurrenceId(task, overrideStart);

        addOccurrence(map, task, dueOf(overrideStart), recurrenceId, override);
      }
    } else {
      // Non-recurring task, or no range provided
      const key = taskDueDayKey(task);
      if (!key) continue;
      const existing = map.get(key);
      if (existing) existing.push(task);
      else map.set(key, [task]);
    }
  }

  for (const dayTasks of map.values()) {
    dayTasks.sort((a, b) => {
      const aHasTime = !a.showWithoutTime && !a.due?.endsWith("T00:00:00");
      const bHasTime = !b.showWithoutTime && !b.due?.endsWith("T00:00:00");
      const aTimed = aHasTime ? 1 : 0;
      const bTimed = bHasTime ? 1 : 0;
      if (aTimed !== bTimed) return aTimed - bTimed;
      const byDue = (a.due ?? "").localeCompare(b.due ?? "");
      if (byDue !== 0) return byDue;
      return (a.title ?? "").localeCompare(b.title ?? "");
    });
  }

  return map;
}
