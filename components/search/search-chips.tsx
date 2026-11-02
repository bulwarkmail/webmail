"use client";

import { useLayoutEffect, useRef } from "react";
import { TOUCH_HIT_AREA } from "@/components/ui/button";
import { useTranslations } from "next-intl";
import { X } from "@/components/icons";
import { cn } from "@/lib/utils";
import { SearchFilters, sizeFilterBytes } from "@/lib/jmap/search-utils";

interface SearchChipsProps {
  filters: SearchFilters;
  onRemoveFilter: (key: keyof SearchFilters) => void;
  onClearAll: () => void;
  onEmptyFocus?: () => void;
  className?: string;
}

export function SearchChips({
  filters,
  onRemoveFilter,
  onClearAll,
  onEmptyFocus,
  className,
}: SearchChipsProps) {
  const t = useTranslations("advanced_search");
  const tRemove = useTranslations("plugin_list");
  const controls = useRef<HTMLDivElement>(null);
  const pendingFocus = useRef<number | null>(null);

  const chips: { key: keyof SearchFilters; label: string; value: string }[] = [];

  if (filters.from) {
    chips.push({ key: "from", label: t("from"), value: filters.from });
  }
  if (filters.to) {
    chips.push({ key: "to", label: t("to"), value: filters.to });
  }
  if (filters.subject) {
    chips.push({ key: "subject", label: t("subject"), value: filters.subject });
  }
  if (filters.body) {
    chips.push({ key: "body", label: t("body"), value: filters.body });
  }
  if (filters.hasAttachment !== null) {
    chips.push({
      key: "hasAttachment",
      label: t("has_attachment"),
      value: filters.hasAttachment ? t("yes") : t("no"),
    });
  }
  if (filters.dateAfter) {
    chips.push({ key: "dateAfter", label: t("date_after"), value: filters.dateAfter });
  }
  if (filters.dateBefore) {
    chips.push({ key: "dateBefore", label: t("date_before"), value: filters.dateBefore });
  }
  if (filters.isUnread !== null) {
    chips.push({
      key: "isUnread",
      label: filters.isUnread ? t("unread") : t("read"),
      value: "",
    });
  }
  if (filters.isStarred !== null) {
    chips.push({
      key: "isStarred",
      label: t("starred"),
      value: filters.isStarred ? t("yes") : t("no"),
    });
  }
  if (sizeFilterBytes(filters.minSizeKb) !== null) {
    chips.push({ key: "minSizeKb", label: t("size_min"), value: `${filters.minSizeKb} KB` });
  }
  if (sizeFilterBytes(filters.maxSizeKb) !== null) {
    chips.push({ key: "maxSizeKb", label: t("size_max"), value: `${filters.maxSizeKb} KB` });
  }
  if (filters.pluginFilter) {
    chips.push({ key: "pluginFilter", label: filters.pluginFilter.label, value: "" });
  }

  useLayoutEffect(() => {
    if (pendingFocus.current === null) return;
    const buttons = controls.current?.querySelectorAll<HTMLButtonElement>('[data-filter-remove]');
    if (buttons?.length) buttons[Math.min(pendingFocus.current, buttons.length - 1)].focus();
    else onEmptyFocus?.();
    pendingFocus.current = null;
  });
  if (chips.length === 0) return null;

  return (
    <div ref={controls} data-memail-search-chips="" role="group" aria-label={t(chips.length === 1 ? "filters_active" : "filters_active_plural", {count:chips.length})} className={cn("px-4 py-2 border-b border-border bg-muted/20 flex items-center gap-2 flex-wrap", className)}>
      {chips.map((chip, index) => (
        <span
          key={chip.key}
          className="inline-flex min-w-0 max-w-full items-center gap-1 px-2 py-0.5 rounded-lg text-xs bg-primary/10 text-primary border border-primary/20"
        >
          <span title={chip.label} className="min-w-0 truncate font-medium">{chip.label}</span>
          {chip.value && (
            <>
              <span className="text-primary/60">:</span>
              <span dir="auto" title={chip.value} className="min-w-0 max-w-40 truncate">{chip.value}</span>
            </>
          )}
          <button
            type="button"
            data-filter-remove=""
            aria-label={tRemove("remove_filter", {label: `${chip.label}${chip.value ? `: ${chip.value}` : ""}`})}
            title={tRemove("remove_filter", {label: `${chip.label}${chip.value ? `: ${chip.value}` : ""}`})}
            onClick={() => {pendingFocus.current=index;onRemoveFilter(chip.key);}}
            className={cn("-my-1 -me-1 relative min-h-6 min-w-6 shrink-0 grid place-items-center rounded-md hover:bg-primary/20 transition-colors focus-visible:outline-2 focus-visible:outline-ring", TOUCH_HIT_AREA)}
          >
            <X className="w-3 h-3" aria-hidden="true" />
          </button>
        </span>
      ))}
      {chips.length > 1 && (
        <button
          type="button"
          onClick={() => {pendingFocus.current=0;onClearAll();}}
          className={cn("relative min-h-8 rounded-md px-2 text-xs text-muted-foreground hover:text-foreground hover:bg-accent transition-colors focus-visible:outline-2 focus-visible:outline-ring", TOUCH_HIT_AREA)}
        >
          {t("clear_all")}
        </button>
      )}
    </div>
  );
}
