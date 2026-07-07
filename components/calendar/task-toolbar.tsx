"use client";

import { useTranslations } from "next-intl";
import { Plus } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import type { TaskViewFilter } from "@/stores/task-store";

interface TaskToolbarProps {
  filter: TaskViewFilter;
  showCompleted: boolean;
  onFilterChange: (filter: TaskViewFilter) => void;
  onShowCompletedChange: (show: boolean) => void;
  onCreateTask: () => void;
}

const FILTERS: TaskViewFilter[] = ["all", "pending", "completed", "overdue"];

export function TaskToolbar({
  filter,
  showCompleted,
  onFilterChange,
  onShowCompletedChange,
  onCreateTask,
}: TaskToolbarProps) {
  const t = useTranslations("calendar");

  return (
    <div className="flex items-center gap-2 px-4 py-2 border-b border-border flex-wrap">
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

      <label className="flex items-center gap-1.5 text-xs text-muted-foreground cursor-pointer select-none ms-2">
        <input
          type="checkbox"
          checked={showCompleted}
          onChange={(e) => onShowCompletedChange(e.target.checked)}
          className="rounded border-border"
        />
        {t("tasks.show_completed")}
      </label>

      <div className="flex-1" />

      <Button size="sm" onClick={onCreateTask}>
        <Plus className="w-4 h-4 me-1" />
        {t("tasks.create")}
      </Button>
    </div>
  );
}
