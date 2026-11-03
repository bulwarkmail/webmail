"use client";

import { useMemo, useCallback, useState } from "react";
import { useTranslations } from "next-intl";
import { parseISO, isBefore, isTomorrow } from "date-fns";
import { displayNow, isDisplayToday } from "@/lib/timezone";
import { Check, Flag, CalendarDays, ListTodo, Plus } from "@/components/icons";
import { cn } from "@/lib/utils";
import type { CalendarTask, Calendar } from "@/lib/jmap/types";
import type { TaskViewFilter } from "@/stores/task-store";
import { useSettingsStore } from "@/stores/settings-store";
import { useDisplayDateFormatter } from "@/hooks/use-display-date-formatter";
import { useCvdColor } from "@/hooks/use-cvd-color";

interface TaskListViewProps {
  tasks: CalendarTask[];
  calendars: Calendar[];
  selectedCalendarIds: string[];
  filter: TaskViewFilter;
  onSelectTask: (task: CalendarTask) => void;
  onToggleComplete: (task: CalendarTask) => void;
  selectedTaskId?: string | null;
  onQuickCreate?: (title: string) => void;
}

function getTaskPriorityIcon(priority: number) {
  if (priority >= 1 && priority <= 4) return <Flag className="h-3.5 w-3.5 text-red-600 dark:text-red-400" />;
  if (priority === 5) return <Flag className="h-3.5 w-3.5 text-amber-600 dark:text-amber-400" />;
  if (priority >= 6 && priority <= 9) return <Flag className="h-3.5 w-3.5 text-muted-foreground" />;
  return null;
}

type FormatDate = ReturnType<typeof useDisplayDateFormatter>["dateTime"];

function getDueDateLabel(due: string, showWithoutTime: boolean, t: ReturnType<typeof useTranslations>, timeFormat: string, formatDate: FormatDate): { label: string; className: string } {
  const dueDate = parseISO(due);
  const overdue = isBefore(dueDate, displayNow()) && !isDisplayToday(dueDate);

  if (isDisplayToday(dueDate)) {
    return {
      label: t("tasks.due_today"),
      className: "text-primary",
    };
  }
  if (isTomorrow(dueDate)) {
    return {
      label: t("tasks.due_tomorrow"),
      className: "text-muted-foreground",
    };
  }
  if (overdue) {
    return {
      label: t("tasks.overdue"),
      className: "text-red-600 dark:text-red-400",
    };
  }

  // In the app's language, like every other date (R10).
  const formatted = showWithoutTime
    ? formatDate(dueDate, { month: "short", day: "numeric" })
    : formatDate(dueDate, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit", hour12: timeFormat === "12h" });

  return {
    label: formatted,
    className: "text-muted-foreground",
  };
}

/** The tasks the list shows, in its order: filtered by calendar and status. "All" is all of them. */
export function filterTasksForList(
  tasks: CalendarTask[],
  selectedCalendarIds: string[],
  filter: TaskViewFilter,
): CalendarTask[] {
  let result = tasks.filter(task => {
    const calIds = Object.keys(task.calendarIds);
    return calIds.some(id => selectedCalendarIds.includes(id));
  });

  switch (filter) {
    case "pending":
      result = result.filter(task => task.progress === "needs-action" || task.progress === "in-process");
      break;
    case "completed":
      result = result.filter(task => task.progress === "completed");
      break;
    case "overdue":
      result = result.filter(task => {
        if (!task.due || task.progress === "completed" || task.progress === "cancelled") return false;
        return isBefore(parseISO(task.due), displayNow()) && !isDisplayToday(parseISO(task.due));
      });
      break;
  }

  // Sort: overdue first, then by due date (no due date last), then by priority
  result.sort((a, b) => {
    // Completed tasks at the bottom
    if (a.progress === "completed" && b.progress !== "completed") return 1;
    if (a.progress !== "completed" && b.progress === "completed") return -1;

    // Tasks with due dates before those without
    if (a.due && !b.due) return -1;
    if (!a.due && b.due) return 1;
    if (a.due && b.due) {
      const dateCompare = new Date(a.due).getTime() - new Date(b.due).getTime();
      if (dateCompare !== 0) return dateCompare;
    }

    // Higher priority first (lower number = higher priority, but 0 = no priority goes last)
    const aPri = a.priority || 10;
    const bPri = b.priority || 10;
    return aPri - bPri;
  });

  return result;
}

export function TaskListView({
  tasks,
  calendars,
  selectedCalendarIds,
  filter,
  onSelectTask,
  onToggleComplete,
  selectedTaskId,
  onQuickCreate,
}: TaskListViewProps) {
  const t = useTranslations("calendar");
  const paint = useCvdColor();
  const timeFormat = useSettingsStore((s) => s.timeFormat);
  const { dateTime: formatDate } = useDisplayDateFormatter();
  const [quickAddTitle, setQuickAddTitle] = useState("");

  const filteredTasks = useMemo(
    () => filterTasksForList(tasks, selectedCalendarIds, filter),
    [tasks, selectedCalendarIds, filter],
  );

  const handleToggle = useCallback((e: React.MouseEvent, task: CalendarTask) => {
    e.stopPropagation();
    onToggleComplete(task);
  }, [onToggleComplete]);

  if (filteredTasks.length === 0) {
    return (
      <div className="flex flex-col flex-1">
        {onQuickCreate && (
          <div className="px-4 py-2 border-b border-border">
            <div className="flex items-center gap-2">
              <Plus className="h-4 w-4 text-muted-foreground flex-shrink-0" />
              <input
                type="text"
                value={quickAddTitle}
                onChange={(e) => setQuickAddTitle(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && quickAddTitle.trim()) {
                    onQuickCreate(quickAddTitle.trim());
                    setQuickAddTitle("");
                  }
                }}
                placeholder={t("tasks.quick_add_placeholder")}
                aria-label={t("tasks.quick_add_placeholder")}
                className="flex-1 bg-transparent text-sm outline-none placeholder:text-muted-foreground"
              />
            </div>
          </div>
        )}
        <div className="flex flex-col items-center justify-center flex-1 text-muted-foreground py-12">
          <ListTodo className="h-12 w-12 mb-3 opacity-30" />
          <p className="text-sm">{t("tasks.no_tasks")}</p>
        </div>
      </div>
    );
  }

  return (
    <div className="flex-1 overflow-y-auto max-md:pb-20">
      {onQuickCreate && (
        <div className="px-4 py-2 border-b border-border">
          <div className="flex items-center gap-2">
            <Plus className="h-4 w-4 text-muted-foreground flex-shrink-0" />
            <input
              type="text"
              value={quickAddTitle}
              onChange={(e) => setQuickAddTitle(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && quickAddTitle.trim()) {
                  onQuickCreate(quickAddTitle.trim());
                  setQuickAddTitle("");
                }
              }}
              placeholder={t("tasks.quick_add_placeholder")}
              aria-label={t("tasks.quick_add_placeholder")}
              className="flex-1 bg-transparent text-sm outline-none placeholder:text-muted-foreground"
            />
          </div>
        </div>
      )}
      <div className="divide-y divide-border">
        {filteredTasks.map(task => {
          const cal = calendars.find(c => task.calendarIds[c.id]);
          const isCompleted = task.progress === "completed";
          const priorityIcon = getTaskPriorityIcon(task.priority);
          const dueDateInfo = task.due ? getDueDateLabel(task.due, task.showWithoutTime, t, timeFormat, formatDate) : null;

          return (
            <div
              key={task.id}
              onClick={() => onSelectTask(task)}
              className={cn(
                "flex items-start gap-3 px-4 py-3 cursor-pointer hover:bg-muted/50 transition-colors",
                selectedTaskId === task.id && "bg-muted",
              )}
            >
              {/* Checkbox */}
              <button
                onClick={(e) => handleToggle(e, task)}
                className={cn(
                  "mt-0.5 flex-shrink-0 w-5 h-5 rounded-full border-2 flex items-center justify-center transition-colors",
                  isCompleted
                    ? "bg-success border-success text-success-foreground"
                    : "border-muted-foreground/40 hover:border-primary"
                )}
                aria-label={isCompleted ? t("tasks.mark_incomplete") : t("tasks.mark_complete")}
              >
                {isCompleted && <Check className="h-3 w-3" />}
              </button>

              {/* Content: a button, so Tab reaches the task and Enter opens it. */}
              <button
                type="button"
                onClick={(e) => { e.stopPropagation(); onSelectTask(task); }}
                className="flex-1 min-w-0 text-start rounded-sm focus-visible:outline-hidden"
              >
                <span className="flex items-center gap-1.5">
                  <span className={cn(
                    "text-sm font-medium truncate",
                    isCompleted && "line-through text-muted-foreground"
                  )} title={task.title || t("tasks.no_title")}>
                    {task.title || t("tasks.no_title")}
                  </span>
                  {priorityIcon}
                </span>

                <span className="flex items-center gap-2 mt-0.5">
                  {dueDateInfo && (
                    <span className={cn("text-xs flex items-center gap-1", dueDateInfo.className)}>
                      <CalendarDays className="h-3 w-3" />
                      {dueDateInfo.label}
                    </span>
                  )}
                  {cal && (
                    <span className="text-xs text-muted-foreground flex items-center gap-1">
                      <span className="w-2 h-2 rounded-full flex-shrink-0" style={{ backgroundColor: paint(cal.color || "#3b82f6") }} />
                      {cal.name}
                    </span>
                  )}
                </span>
              </button>
            </div>
          );
        })}
      </div>
    </div>
  );
}
