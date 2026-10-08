"use client";

import { useTranslations } from "next-intl";
import { cn } from "@/lib/utils";
import { ChevronDown, ChevronUp, FoldVertical, UnfoldVertical } from "@/components/icons";
import { formatDisplayHour, type DisplayHours } from "@/lib/calendar-display-range";

interface HiddenEventsIndicatorProps {
  count: number;
  direction: "before" | "after";
  onReveal: () => void;
}

/**
 * Marks a day column that has events above or below the visible hours
 * (#1164); clicking it shows the whole day at the first of them.
 */
export function HiddenEventsIndicator({ count, direction, onReveal }: HiddenEventsIndicatorProps) {
  const t = useTranslations("calendar.events");
  const label = direction === "before" ? t("hidden_before", { count }) : t("hidden_after", { count });
  const Icon = direction === "before" ? ChevronUp : ChevronDown;
  return (
    <button
      type="button"
      data-hidden-events={direction}
      title={label}
      aria-label={label}
      // The column starts drag-to-create on pointer down.
      onPointerDown={(e) => e.stopPropagation()}
      onClick={(e) => { e.stopPropagation(); onReveal(); }}
      className={cn(
        "absolute inset-x-0 mx-auto w-fit z-20 flex items-center gap-0.5 rounded-full",
        "bg-muted/90 px-1.5 py-0.5 text-[10px] leading-none text-muted-foreground",
        "hover:bg-accent hover:text-foreground transition-colors cursor-pointer",
        direction === "before" ? "top-0.5" : "bottom-0.5",
      )}
    >
      <Icon className="h-3 w-3" />
      <span>{count}</span>
    </button>
  );
}

interface AllHoursToggleProps {
  showAllHours: boolean;
  configured: DisplayHours;
  timeFormat: "12h" | "24h";
  onToggle: () => void;
  className?: string;
}

/** Switches a time grid between the configured hours and the whole day. */
export function AllHoursToggle({ showAllHours, configured, timeFormat, onToggle, className }: AllHoursToggleProps) {
  const t = useTranslations("calendar.events");
  const label = showAllHours
    ? t("show_display_hours", {
        start: formatDisplayHour(configured.startMinutes / 60, timeFormat),
        end: formatDisplayHour(configured.endMinutes / 60, timeFormat),
      })
    : t("show_all_hours");
  const Icon = showAllHours ? FoldVertical : UnfoldVertical;
  return (
    <button
      type="button"
      data-all-hours-toggle
      aria-pressed={showAllHours}
      aria-label={label}
      title={label}
      onClick={onToggle}
      className={cn(
        "flex items-center justify-center rounded p-1 text-muted-foreground hover:bg-muted hover:text-foreground transition-colors cursor-pointer",
        className,
      )}
    >
      <Icon className="h-3.5 w-3.5" />
    </button>
  );
}
