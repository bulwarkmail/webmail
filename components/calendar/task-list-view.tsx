"use client";

import { useMemo, useCallback, useState } from "react";
import { useTranslations } from "next-intl";
import { format, parseISO, isBefore, isTomorrow } from "date-fns";
import { displayNow, isDisplayToday } from "@/lib/timezone";
import { Check, Flag, CalendarDays, ListTodo, Plus } from "@/components/icons";
import { cn } from "@/lib/utils";
import type { CalendarTask, Calendar } from "@/lib/jmap/types";
import type { TaskViewFilter } from "@/stores/task-store";
import { useSettingsStore } from "@/stores/settings-store";

interface TaskListViewProps {
  tasks: CalendarTask[];
  calendars: Calendar[];
  selectedCalendarIds: string[];
  filter: TaskViewFilter;
  showCompleted: boolean;
  onSelectTask: (task: CalendarTask) => void;
  onToggleComplete: (task: CalendarTask) => void;
  selectedTaskId?: string | null;
  onQuickCreate?: (title: string) => void;
}

function getTaskPriorityIcon(priority: number) {
  if (priority >= 1 && priority <= 4) return <Flag className="h-3.5 w-3.5 text-red-500" />;
  if (priority === 5) return <Flag className="h-3.5 w-3.5 text-orange-500" />;
  if (priority >= 6 && priority <= 9) return <Flag className="h-3.5 w-3.5 text-gray-400" />;
  return null;
}

function getDueDateLabel(due: string, showWithoutTime: boolean, t: ReturnType<typeof useTranslations>, timeFormat: string): { label: string; className: string } {
  const dueDate = parseISO(due);
  const overdue = isBefore(dueDate, displayNow()) && !isDisplayToday(dueDate);

  if (isDisplayToday(dueDate)) {
    return {
      label: t("tasks.due_today"),
      className: "text-blue-600 dark:text-blue-400",
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

  const formatted = showWithoutTime
    ? format(dueDate, "MMM d")
    : format(dueDate, timeFormat === "12h" ? "MMM d, h:mm a" : "MMM d, HH:mm");

  return {
    label: formatted,
    className: "text-muted-foreground",
  };
}

export function TaskListView({
  tasks,
  calendars,
  selectedCalendarIds,
  filter,
  showCompleted,
  onSelectTask,
  onToggleComplete,
  selectedTaskId,
  onQuickCreate,
}: TaskListViewProps) {
  const t = useTranslations("calendar");
  const timeFormat = useSettingsStore((s) => s.timeFormat);
  const [quickAddTitle, setQuickAddTitle] = useState("");

  const filteredTasks = useMemo(() => {
    let result = tasks.filter(task => {
      const calIds = Object.keys(task.calendarIds);
      return calIds.some(id => selectedCalendarIds.includes(id));
    });

    if (!showCompleted) {
      result = result.filter(task => task.progress !== "completed" && task.progress !== "cancelled");
    }

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
  }, [tasks, selectedCalendarIds, filter, showCompleted]);

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
    <div className="flex-1 overflow-y-auto">
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
          const dueDateInfo = task.due ? getDueDateLabel(task.due, task.showWithoutTime, t, timeFormat) : null;

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

              {/* Content */}
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-1.5">
                  <span className={cn(
                    "text-sm font-medium truncate",
                    isCompleted && "line-through text-muted-foreground"
                  )}>
                    {task.title || t("tasks.no_title")}
                  </span>
                  {priorityIcon}
                </div>

                <div className="flex items-center gap-2 mt-0.5">
                  {dueDateInfo && (
                    <span className={cn("text-xs flex items-center gap-1", dueDateInfo.className)}>
                      <CalendarDays className="h-3 w-3" />
                      {dueDateInfo.label}
                    </span>
                  )}
                  {cal && (
                    <span className="text-xs text-muted-foreground flex items-center gap-1">
                      <span className="w-2 h-2 rounded-full flex-shrink-0" style={{ backgroundColor: cal.color || "#3b82f6" }} />
                      {cal.name}
                    </span>
                  )}
                </div>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
