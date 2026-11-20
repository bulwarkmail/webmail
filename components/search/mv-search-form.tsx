"use client";

import type { ReactNode } from "react";
import { useTranslations } from "next-intl";
import type { SearchFilters } from "@/lib/jmap/search-utils";
import { cn } from "@/lib/utils";

interface MvSearchFormProps {
  filters: SearchFilters;
  onChange: (patch: Partial<SearchFilters>) => void;
  /** Runs the search and closes the panel. */
  onSearch: () => void;
  onClear: () => void;
  /** The folder picker, shared with the default layout's panel. */
  folderSelect?: ReactNode;
}

const FIELD = "w-full h-8 bg-transparent border-0 border-b border-border px-0 text-sm text-foreground placeholder:text-muted-foreground focus:outline-none focus:border-b-2 focus:border-primary";

/**
 * Mountain View's advanced search: Gmail's form under the search field, one
 * labelled row per criterion with underlined fields, the yes/no criteria as
 * checkboxes, and a Search button that runs it.
 */
export function MvSearchForm({ filters, onChange, onSearch, onClear, folderSelect }: MvSearchFormProps) {
  const t = useTranslations("advanced_search");

  const row = (label: string, field: ReactNode) => (
    <label className="grid grid-cols-[8rem_1fr] items-end gap-4 py-1">
      <span className="pb-1.5 text-sm text-muted-foreground">{label}</span>
      {field}
    </label>
  );

  const check = (label: string, value: boolean | null, key: "hasAttachment" | "isStarred" | "isUnread" | "untagged") => (
    <label className="inline-flex items-center gap-3 text-sm text-foreground cursor-pointer">
      <input
        type="checkbox"
        checked={value === true}
        // `untagged` is a plain yes/no; the others are unset when unchecked.
        onChange={(e) => onChange({ [key]: e.target.checked ? true : key === "untagged" ? false : null })}
        className="h-4 w-4 rounded-sm accent-[var(--color-primary)]"
      />
      {label}
    </label>
  );

  return (
    <form
      data-mv-search-form=""
      className="px-3 pb-1 pt-1"
      onSubmit={(e) => {
        e.preventDefault();
        onSearch();
      }}
    >
      {row(t("from"), <input className={FIELD} value={filters.from} onChange={(e) => onChange({ from: e.target.value })} />)}
      {row(t("to"), <input className={FIELD} value={filters.to} onChange={(e) => onChange({ to: e.target.value })} />)}
      {row(t("subject"), <input className={FIELD} value={filters.subject} onChange={(e) => onChange({ subject: e.target.value })} />)}
      {row(t("has_words"), <input className={FIELD} value={filters.body} onChange={(e) => onChange({ body: e.target.value })} />)}
      {row(t("size"), (
        <span className="grid grid-cols-2 gap-4">
          <input
            type="number"
            min={1}
            inputMode="numeric"
            className={FIELD}
            placeholder={t("size_min")}
            aria-label={t("size_min")}
            value={filters.minSizeKb}
            onChange={(e) => onChange({ minSizeKb: e.target.value })}
          />
          <input
            type="number"
            min={1}
            inputMode="numeric"
            className={FIELD}
            placeholder={t("size_max")}
            aria-label={t("size_max")}
            value={filters.maxSizeKb}
            onChange={(e) => onChange({ maxSizeKb: e.target.value })}
          />
        </span>
      ))}
      {row(t("date_within"), (
        <span className="grid grid-cols-2 gap-4">
          <input type="date" aria-label={t("date_after")} className={FIELD} value={filters.dateAfter} onChange={(e) => onChange({ dateAfter: e.target.value })} />
          <input type="date" aria-label={t("date_before")} className={FIELD} value={filters.dateBefore} onChange={(e) => onChange({ dateBefore: e.target.value })} />
        </span>
      ))}
      {folderSelect && row(t("search_in"), folderSelect)}

      <div className="flex flex-wrap items-center gap-x-6 gap-y-2 py-3">
        {check(t("has_attachment_check"), filters.hasAttachment, "hasAttachment")}
        {check(t("starred"), filters.isStarred, "isStarred")}
        {check(t("unread"), filters.isUnread, "isUnread")}
        {check(t("no_tags"), filters.untagged, "untagged")}
      </div>

      <div className="flex items-center justify-end gap-2 pb-2">
        <button
          type="button"
          onClick={onClear}
          className="h-9 rounded-full px-4 text-sm font-medium text-muted-foreground hover:bg-muted transition-colors"
        >
          {t("clear")}
        </button>
        <button
          type="submit"
          className={cn("h-9 rounded-full px-6 text-sm font-medium bg-primary text-primary-foreground hover:shadow-md transition-shadow")}
        >
          {t("search")}
        </button>
      </div>
    </form>
  );
}
