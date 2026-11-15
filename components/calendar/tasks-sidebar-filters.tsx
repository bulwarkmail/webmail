"use client";

import { useMemo } from "react";
import { useTranslations } from "next-intl";
import { ListTodo, Circle, AlertCircle, CheckCircle2 } from "@/components/icons";
import { cn } from "@/lib/utils";
import type { CalendarTask } from "@/lib/jmap/types";
import type { TaskViewFilter } from "@/stores/task-store";
import { filterTasksForList } from "@/components/calendar/task-list-view";

interface TasksSidebarFiltersProps {
  tasks: CalendarTask[];
  /** Task lists the user unticked: their tasks count nowhere, as they show nowhere. */
  hiddenTaskListIds: string[];
  filter: TaskViewFilter;
  onFilterChange: (filter: TaskViewFilter) => void;
}

const ENTRIES: { filter: TaskViewFilter; icon: typeof ListTodo }[] = [
  { filter: "all", icon: ListTodo },
  { filter: "pending", icon: Circle },
  { filter: "overdue", icon: AlertCircle },
  { filter: "completed", icon: CheckCircle2 },
];

/**
 * The Tasks app's sidebar entries (#1698): the task list's filters as
 * places, each with the number of tasks it lists, in the shape of the
 * contacts sidebar's "All contacts".
 */
export function TasksSidebarFilters({ tasks, hiddenTaskListIds, filter, onFilterChange }: TasksSidebarFiltersProps) {
  const t = useTranslations("calendar");
  const counts = useMemo(() => {
    const result = {} as Record<TaskViewFilter, number>;
    for (const { filter: f } of ENTRIES) result[f] = filterTasksForList(tasks, hiddenTaskListIds, f).length;
    return result;
  }, [tasks, hiddenTaskListIds]);

  return (
    <nav aria-label={t("tasks.label")} className="mb-3" data-testid="tasks-sidebar-filters">
      {ENTRIES.map(({ filter: f, icon: Icon }) => {
        const active = f === filter;
        const count = counts[f];
        return (
          <button
            key={f}
            type="button"
            onClick={() => onFilterChange(f)}
            aria-current={active ? "true" : undefined}
            className={cn(
              "w-full flex items-center gap-2 px-3 text-sm transition-colors min-h-8 pointer-coarse:min-h-11",
              active ? "bg-accent text-accent-foreground font-medium" : "text-foreground hover:bg-muted",
            )}
            style={{ paddingBlock: "var(--density-sidebar-py, 4px)" }}
          >
            <Icon className={cn("w-4 h-4 flex-shrink-0", f === "overdue" && count > 0 && !active && "text-destructive")} />
            <span className="truncate">{t(`tasks.filter_${f}`)}</span>
            {count > 0 && (
              <span className={cn(
                "ms-auto text-xs tabular-nums",
                f === "overdue" ? "text-destructive font-medium" : "text-muted-foreground",
              )}>
                {count}
              </span>
            )}
          </button>
        );
      })}
    </nav>
  );
}
