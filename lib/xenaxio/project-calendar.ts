// xenaxio step 124, part E: the person's project tasks with a due date as a layer on
// the calendar grid, drawn by the calendar's own task chips (Bulwark #1107). The
// layer follows the person's setting "tasks in the calendar" (notification settings).
// A click opens the task in Projects; the check box marks it done on the platform.
import { useCallback, useEffect, useState } from "react";
import type { CalendarTask } from "@/lib/jmap/types";
import { XENAXIO_BFF } from "@/lib/xenaxio/bff";
import { notificationsApi } from "@/lib/xenaxio/notifications";
import { type MyTask, projectHref, projectsApi } from "@/lib/xenaxio/projects";

const PREFIX = "xenaxio-task:";

export function isProjectTask(task: Pick<CalendarTask, "id">): boolean {
  return task.id.startsWith(PREFIX);
}

/** objectId and taskId of a layer task. */
export function projectTaskOf(task: Pick<CalendarTask, "id">): { objectId: string; taskId: string } | null {
  if (!isProjectTask(task)) return null;
  const [objectId, taskId] = task.id.slice(PREFIX.length).split(":");
  return objectId && taskId ? { objectId, taskId } : null;
}

export function toCalendarTask(t: MyTask): CalendarTask {
  return {
    id: `${PREFIX}${t.object.id}:${t.id}`,
    calendarIds: {},
    "@type": "Task",
    uid: t.id,
    title: `${t.ref} · ${t.title}`,
    description: t.object.title,
    due: t.dueOn ? `${t.dueOn}T00:00:00` : null,
    start: null,
    duration: null,
    timeZone: null,
    showWithoutTime: true,
    progress: t.done ? "completed" : "needs-action",
    priority: t.priority === "high" ? 1 : t.priority === "medium" ? 5 : t.priority === "low" ? 9 : 0,
    privacy: "public",
    keywords: null,
    categories: null,
    color: null,
    created: null,
    updated: t.updatedAt,
    recurrenceRules: null,
    alerts: null,
    relatedTo: null,
  };
}

const day = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;

/** The layer's tasks (two months back, a year ahead) and the two actions on them. */
export function useProjectCalendarTasks(): { tasks: CalendarTask[]; toggle: (task: CalendarTask) => void; href: (task: CalendarTask) => string | null } {
  const [tasks, setTasks] = useState<CalendarTask[]>([]);
  const load = useCallback(async () => {
    if (!XENAXIO_BFF) return;
    try {
      if (!(await notificationsApi.prefs()).calendarTasks) return setTasks([]);
      const now = new Date();
      const from = new Date(now.getFullYear(), now.getMonth() - 2, 1);
      const to = new Date(now.getFullYear() + 1, now.getMonth(), now.getDate());
      const r = await projectsApi.calendarTasks(day(from), day(to));
      setTasks(r.tasks.map(toCalendarTask));
    } catch {
      setTasks([]);
    }
  }, []);
  useEffect(() => {
    void load();
  }, [load]);
  const toggle = useCallback(
    (task: CalendarTask) => {
      const at = projectTaskOf(task);
      if (!at) return;
      void projectsApi
        .updateTask(at.objectId, at.taskId, { done: task.progress !== "completed" })
        .then(load)
        .catch(() => undefined);
    },
    [load],
  );
  const href = useCallback((task: CalendarTask) => {
    const at = projectTaskOf(task);
    return at ? projectHref(at.objectId, at.taskId) : null;
  }, []);
  return { tasks, toggle, href };
}
