"use client";

import { useTranslations } from "next-intl";
import { Calendar as CalendarIcon, CheckSquare, Layers } from "@/components/icons";
import { cn } from "@/lib/utils";
import type { CalendarComponentType } from "@/lib/jmap/types";

/**
 * What a new calendar is meant to hold. Maps onto the CalDAV
 * supported-calendar-component-set, which sync clients use to decide whether
 * to offer the calendar to calendar apps, todo apps, or both (#760).
 */
export type CalendarKind = "events" | "tasks" | "both";

export const CALENDAR_KIND_COMPONENTS: Record<CalendarKind, CalendarComponentType[]> = {
  events: ["VEVENT"],
  tasks: ["VTODO"],
  both: ["VEVENT", "VTODO"],
};

const KINDS: { kind: CalendarKind; icon: typeof CalendarIcon }[] = [
  { kind: "events", icon: CalendarIcon },
  { kind: "tasks", icon: CheckSquare },
  { kind: "both", icon: Layers },
];

export function CalendarKindPicker({
  value,
  onChange,
  disabled,
}: {
  value: CalendarKind;
  onChange: (kind: CalendarKind) => void;
  disabled?: boolean;
}) {
  const t = useTranslations("calendar.management");
  const labels: Record<CalendarKind, string> = {
    events: t("kind_events"),
    tasks: t("kind_tasks"),
    both: t("kind_both"),
  };

  return (
    <div>
      <label className="text-xs font-medium text-muted-foreground mb-1 block">
        {t("kind")}
      </label>
      <div role="radiogroup" aria-label={t("kind")} className="inline-flex gap-0.5 rounded-md border border-input p-0.5">
        {KINDS.map(({ kind, icon: Icon }) => (
          <button
            key={kind}
            type="button"
            role="radio"
            aria-checked={value === kind}
            disabled={disabled}
            onClick={() => onChange(kind)}
            className={cn(
              "flex items-center gap-1.5 px-2.5 py-1 text-xs rounded transition-colors disabled:opacity-50",
              value === kind
                ? "bg-primary text-primary-foreground"
                : "text-muted-foreground hover:text-foreground"
            )}
          >
            <Icon className="w-3.5 h-3.5" />
            {labels[kind]}
          </button>
        ))}
      </div>
      <p className="text-xs text-muted-foreground mt-1">{t("kind_hint")}</p>
    </div>
  );
}
