"use client";

import { useMemo } from "react";
import { useTranslations } from "next-intl";
import { Plus } from "@/components/icons";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { PluginActions } from "@/components/plugins/plugin-actions";
import type { TaskViewFilter } from "@/stores/task-store";

interface TaskToolbarProps {
  filter: TaskViewFilter;
  onFilterChange: (filter: TaskViewFilter) => void;
  onCreateTask: () => void;
  /** The tasks the list shows, in order: what plugin buttons here act on. */
  taskIds?: string[];
  /** Icon-only plugin buttons (phones). */
  compact?: boolean;
  /** The "New task" button; off where another one is on screen (the phone's floating "+"). */
  showCreate?: boolean;
}

const NO_IDS: string[] = [];

const FILTERS: TaskViewFilter[] = ["all", "pending", "completed", "overdue"];

export function TaskToolbar({
  filter,
  onFilterChange,
  onCreateTask,
  taskIds = NO_IDS,
  compact,
  showCreate = true,
}: TaskToolbarProps) {
  const t = useTranslations("calendar");
  const pluginContext = useMemo(() => ({ taskIds }), [taskIds]);

  return (
    <div className="flex items-center gap-2 px-4 min-h-14 box-content border-b border-border flex-wrap">
      <div className="flex border border-border rounded-md overflow-hidden">
        {FILTERS.map((f) => (
          <button
            key={f}
            onClick={() => onFilterChange(f)}
            className={cn(
              "px-3 py-1.5 text-xs font-medium transition-colors",
              f === filter
                ? "bg-primary text-primary-foreground"
                : "hover:bg-muted text-muted-foreground"
            )}
          >
            {t(`tasks.filter_${f}`)}
          </button>
        ))}
      </div>

      <div className="flex-1" />

      {showCreate && (
        <Button size="sm" onClick={onCreateTask}>
          <Plus className="w-4 h-4 me-1" />
          {t("tasks.create")}
        </Button>
      )}

      <PluginActions surface="task-list-actions" context={pluginContext} compact={compact} />
    </div>
  );
}
