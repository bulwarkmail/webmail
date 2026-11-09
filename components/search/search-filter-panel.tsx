"use client";

import { useId, useState, type ReactNode } from "react";
import { useTranslations } from "next-intl";
import { Check, Mail, MailOpen, Paperclip, RotateCcw, Star } from "@/components/icons";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { activeFilterCount, type SearchFilters } from "@/lib/jmap/search-utils";
import { cn } from "@/lib/utils";

/** How a change runs the search: straight away, or after typing pauses. */
export type FilterChangeMode = "now" | "debounced";

interface SearchFilterPanelProps {
  filters: SearchFilters;
  onChange: (patch: Partial<SearchFilters>, mode: FilterChangeMode) => void;
  onClearAll: () => void;
  /** Runs any pending search and closes the panel (Search, or Enter in a field). */
  onDone: () => void;
  /** The folder picker, shared with Mountain View's form. */
  folderSelect?: ReactNode;
}

const DATE_PRESETS = [
  { key: "past_week", days: 7 },
  { key: "past_month", days: 30 },
  { key: "past_year", days: 365 },
] as const;

const SIZE_PRESETS_MB = [1, 5, 10, 25] as const;

export const SELECT_CLASS =
  "w-full h-8 text-sm rounded-md border border-input bg-background px-2 text-foreground focus:outline-hidden";

/** `days` before today as the yyyy-mm-dd a date input holds, in local time. */
export function daysAgo(days: number, now = new Date()): string {
  const d = new Date(now.getFullYear(), now.getMonth(), now.getDate() - days);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function datePresetOf(filters: SearchFilters): string {
  if (!filters.dateAfter && !filters.dateBefore) return "any";
  if (!filters.dateBefore) {
    const preset = DATE_PRESETS.find((p) => daysAgo(p.days) === filters.dateAfter);
    if (preset) return preset.key;
  }
  return "custom";
}

function sizePresetOf(filters: SearchFilters): string {
  if (!filters.minSizeKb && !filters.maxSizeKb) return "any";
  if (!filters.maxSizeKb) {
    const mb = SIZE_PRESETS_MB.find((m) => String(m * 1024) === filters.minSizeKb);
    if (mb) return `mb${mb}`;
  }
  return "custom";
}

/**
 * The default layout's filter panel, under the list header's search field.
 * Every criterion is in view at once, labelled on the left; the yes/no ones
 * are on/off chips, the date and size offer the usual ranges with a custom
 * one behind them. Changes run the search as they are made, so the list
 * behind already shows the result when Search closes the panel.
 */
export function SearchFilterPanel({ filters, onChange, onClearAll, onDone, folderSelect }: SearchFilterPanelProps) {
  const t = useTranslations("advanced_search");
  const id = useId();
  // "Custom" with nothing typed yet has no value to tell it from "Any".
  const [customDate, setCustomDate] = useState(false);
  const [customSize, setCustomSize] = useState(false);
  const datePreset = customDate ? "custom" : datePresetOf(filters);
  const sizePreset = customSize ? "custom" : sizePresetOf(filters);
  const count = activeFilterCount(filters);

  const row = (key: string, label: string, field: ReactNode) => (
    <>
      <label htmlFor={`${id}-${key}`} className="text-xs text-muted-foreground max-w-[7rem] leading-tight">
        {label}
      </label>
      <div className="min-w-0">{field}</div>
    </>
  );

  const text = (key: "from" | "to" | "subject" | "body", placeholder?: string) => (
    <Input
      id={`${id}-${key}`}
      value={filters[key]}
      placeholder={placeholder}
      onChange={(e) => onChange({ [key]: e.target.value }, "debounced")}
      className="h-8 text-sm"
    />
  );

  return (
    <form
      data-search-filter-panel=""
      onSubmit={(e) => {
        e.preventDefault();
        onDone();
      }}
      className="space-y-3"
    >
      <div className="flex flex-wrap gap-1.5" role="group" aria-label={t("toggle_filters")}>
        <Chip
          icon={<Mail className="w-3.5 h-3.5" />}
          label={t("unread")}
          on={filters.isUnread === true}
          onClick={() => onChange({ isUnread: filters.isUnread === true ? null : true }, "now")}
        />
        <Chip
          icon={<MailOpen className="w-3.5 h-3.5" />}
          label={t("read")}
          on={filters.isUnread === false}
          onClick={() => onChange({ isUnread: filters.isUnread === false ? null : false }, "now")}
        />
        <Chip
          icon={<Star className="w-3.5 h-3.5" />}
          // "Not starred" only comes from elsewhere; shown so it can be undone.
          label={filters.isStarred === false ? t("not_starred") : t("starred")}
          on={filters.isStarred !== null}
          onClick={() => onChange({ isStarred: filters.isStarred === null ? true : null }, "now")}
        />
        <Chip
          icon={<Paperclip className="w-3.5 h-3.5" />}
          label={filters.hasAttachment === false ? t("no_attachment") : t("has_attachment")}
          on={filters.hasAttachment !== null}
          onClick={() => onChange({ hasAttachment: filters.hasAttachment === null ? true : null }, "now")}
        />
      </div>

      <div className="grid grid-cols-[auto_minmax(0,1fr)] items-center gap-x-3 gap-y-2">
        {row("from", t("from"), text("from", t("name_or_address")))}
        {row("to", t("to"), text("to", t("name_or_address")))}
        {row("subject", t("subject"), text("subject"))}
        {row("body", t("has_words"), text("body"))}

        {row("date", t("date_within"), (
          <select
            id={`${id}-date`}
            value={datePreset}
            onChange={(e) => {
              const key = e.target.value;
              setCustomDate(key === "custom");
              if (key === "custom") return;
              const preset = DATE_PRESETS.find((p) => p.key === key);
              onChange({ dateAfter: preset ? daysAgo(preset.days) : "", dateBefore: "" }, "now");
            }}
            className={SELECT_CLASS}
          >
            <option value="any">{t("any_time")}</option>
            {DATE_PRESETS.map((p) => (
              <option key={p.key} value={p.key}>{t(p.key)}</option>
            ))}
            <option value="custom">{t("custom_range")}</option>
          </select>
        ))}
        {datePreset === "custom" && (
          <div className="col-start-2 grid grid-cols-2 gap-2">
            <Input
              type="date"
              aria-label={t("date_after")}
              title={t("date_after")}
              value={filters.dateAfter}
              onChange={(e) => onChange({ dateAfter: e.target.value }, "now")}
              className="h-8 text-sm"
            />
            <Input
              type="date"
              aria-label={t("date_before")}
              title={t("date_before")}
              value={filters.dateBefore}
              onChange={(e) => onChange({ dateBefore: e.target.value }, "now")}
              className="h-8 text-sm"
            />
          </div>
        )}

        {row("size", t("size"), (
          <select
            id={`${id}-size`}
            value={sizePreset}
            onChange={(e) => {
              const key = e.target.value;
              setCustomSize(key === "custom");
              if (key === "custom") return;
              const mb = SIZE_PRESETS_MB.find((m) => `mb${m}` === key);
              onChange({ minSizeKb: mb ? String(mb * 1024) : "", maxSizeKb: "" }, "now");
            }}
            className={SELECT_CLASS}
          >
            <option value="any">{t("any_size")}</option>
            {SIZE_PRESETS_MB.map((mb) => (
              <option key={mb} value={`mb${mb}`}>{t("larger_than_mb", { size: mb })}</option>
            ))}
            <option value="custom">{t("custom_size")}</option>
          </select>
        ))}
        {sizePreset === "custom" && (
          <div className="col-start-2 grid grid-cols-2 gap-2">
            <Input
              type="number"
              min={1}
              inputMode="numeric"
              aria-label={t("size_min")}
              placeholder={t("size_min")}
              title={t("size_min")}
              value={filters.minSizeKb}
              onChange={(e) => onChange({ minSizeKb: e.target.value }, "debounced")}
              className="h-8 text-sm"
              data-testid="advanced-search-min-size"
            />
            <Input
              type="number"
              min={1}
              inputMode="numeric"
              aria-label={t("size_max")}
              placeholder={t("size_max")}
              title={t("size_max")}
              value={filters.maxSizeKb}
              onChange={(e) => onChange({ maxSizeKb: e.target.value }, "debounced")}
              className="h-8 text-sm"
              data-testid="advanced-search-max-size"
            />
          </div>
        )}

        {folderSelect && row("folder", t("search_in"), folderSelect)}
      </div>

      <div className="flex items-center justify-end gap-2">
        {count > 0 && (
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={() => {
              setCustomDate(false);
              setCustomSize(false);
              onClearAll();
            }}
            className="h-8 px-2.5 text-xs text-muted-foreground"
          >
            <RotateCcw className="w-3.5 h-3.5 me-1" />
            {t("clear_all")}
          </Button>
        )}
        <Button type="submit" size="sm" className="h-8 px-4 text-xs">
          {t("search")}
        </Button>
      </div>
    </form>
  );
}

function Chip({ icon, label, on, onClick }: { icon: ReactNode; label: string; on: boolean; onClick: () => void }) {
  return (
    <button
      type="button"
      aria-pressed={on}
      onClick={onClick}
      className={cn(
        "inline-flex items-center gap-1.5 h-7 px-2.5 rounded-full text-xs border transition-colors",
        on
          ? "bg-primary/10 border-primary/40 text-primary"
          : "bg-background border-border text-muted-foreground hover:text-foreground hover:border-muted-foreground",
      )}
    >
      {on ? <Check className="w-3.5 h-3.5" /> : icon}
      {label}
    </button>
  );
}
