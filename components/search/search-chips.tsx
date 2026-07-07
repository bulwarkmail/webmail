"use client";

import { useTranslations } from "next-intl";
import { X } from "lucide-react";
import { cn } from "@/lib/utils";
import { SearchFilters } from "@/lib/jmap/search-utils";

interface SearchChipsProps {
  filters: SearchFilters;
  onRemoveFilter: (key: keyof SearchFilters) => void;
  onClearAll: () => void;
  className?: string;
}

export function SearchChips({
  filters,
  onRemoveFilter,
  onClearAll,
  className,
}: SearchChipsProps) {
  const t = useTranslations("advanced_search");

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

  if (chips.length === 0) return null;

  return (
    <div className={cn("px-4 py-2 border-b border-border bg-muted/20 flex items-center gap-2 flex-wrap", className)}>
      {chips.map((chip) => (
        <span
          key={chip.key}
          className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs bg-primary/10 text-primary border border-primary/20"
        >
          <span className="font-medium">{chip.label}</span>
          {chip.value && (
            <>
              <span className="text-primary/60">:</span>
              <span className="max-w-24 truncate">{chip.value}</span>
            </>
          )}
          <button
            type="button"
            onClick={() => onRemoveFilter(chip.key)}
            className="ms-0.5 p-0.5 rounded-full hover:bg-primary/20 transition-colors"
          >
            <X className="w-3 h-3" />
          </button>
        </span>
      ))}
      {chips.length > 1 && (
        <button
          type="button"
          onClick={onClearAll}
          className="text-xs text-muted-foreground hover:text-foreground transition-colors"
        >
          {t("clear_all")}
        </button>
      )}
    </div>
  );
}
