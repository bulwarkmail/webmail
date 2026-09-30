"use client";

import { useTranslations } from "next-intl";
import { cn } from "@/lib/utils";
import { Check } from "@/components/icons";
import type { Calendar, CalendarTask } from "@/lib/jmap/types";

interface CalendarTaskChipProps {
  task: CalendarTask;
  calendar?: Calendar;
  onToggleComplete?: (task: CalendarTask) => void;
  onSelect?: (task: CalendarTask) => void;
  className?: string;
}

/**
 * A task on its due day in the month and week grids (#1107). The circle
 * toggles completion; the title opens the task in the editor.
 */
export function CalendarTaskChip({ task, calendar, onToggleComplete, onSelect, className }: CalendarTaskChipProps) {
  const t = useTranslations("calendar");
  const isCompleted = task.progress === "completed";
  const color = calendar?.color || "#3b82f6";
  const title = task.title || t("tasks.no_title");

  return (
    <div
      data-calendar-task={task.id}
      className={cn("h-full rounded text-[10px] font-medium flex items-center overflow-hidden", className)}
      style={{ backgroundColor: `${color}20`, borderInlineStart: `3px solid ${color}` }}
    >
      <button
        type="button"
        onClick={(e) => { e.stopPropagation(); onToggleComplete?.(task); }}
        className="group h-full ps-1 pe-0.5 flex items-center flex-shrink-0"
        aria-label={isCompleted ? t("tasks.mark_incomplete") : t("tasks.mark_complete")}
      >
        <span
          className={cn(
            "w-2.5 h-2.5 rounded-full border flex items-center justify-center",
            isCompleted ? "bg-success border-success text-success-foreground" : "group-hover:bg-background",
          )}
          style={isCompleted ? undefined : { borderColor: color }}
        >
          {isCompleted && <Check className="h-2 w-2" />}
        </span>
      </button>
      <button
        type="button"
        onClick={(e) => { e.stopPropagation(); onSelect?.(task); }}
        className={cn(
          "h-full flex-1 min-w-0 truncate text-start pe-1 hover:opacity-80",
          isCompleted && "line-through text-muted-foreground",
        )}
        title={title}
      >
        {title}
      </button>
    </div>
  );
}
