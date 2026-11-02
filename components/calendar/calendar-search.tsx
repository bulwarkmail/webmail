"use client";

import { forwardRef, useId, useMemo, useRef, type KeyboardEvent } from "react";
import { useTranslations } from "next-intl";
import { format } from "date-fns";
import { Search, MapPin, Repeat } from "@/components/icons";
import { ToolbarSearch } from "@/components/ui/toolbar";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";
import { Spinner } from "@/components/ui/spinner";
import { cn } from "@/lib/utils";
import { useDisplayDateFormatter } from "@/hooks/use-display-date-formatter";
import { getEventEndDate, getEventStartDate, getPrimaryCalendarId } from "@/lib/calendar-utils";
import { isDeclinedByUser } from "@/lib/calendar-participants";
import { isRecurringEvent } from "@/lib/global-search/providers/calendar";
import { displayNow } from "@/lib/timezone";
import type { Calendar, CalendarEvent } from "@/lib/jmap/types";
import type { CalendarSearchResults as Results } from "@/hooks/use-calendar-event-search";
import { getEventColor } from "./event-card";
import { useCvdColor } from "@/hooks/use-cvd-color";

const RESULT_SELECTOR = "[data-search-result]";

interface CalendarSearchFieldProps {
  value: string;
  onChange: (value: string) => void;
  /** Escape on an empty field, or the phone's close: leave the search. */
  onDismiss?: () => void;
  autoFocus?: boolean;
  className?: string;
}

/** The search box in the calendar toolbar (CAL-16). */
export const CalendarSearchField = forwardRef<HTMLInputElement, CalendarSearchFieldProps>(
  function CalendarSearchField({ value, onChange, onDismiss, autoFocus, className }, ref) {
    const t = useTranslations("calendar");
    const fieldRef = useRef<HTMLDivElement>(null);
    const handleKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
      if (e.nativeEvent.isComposing || e.ctrlKey || e.metaKey || e.altKey || e.shiftKey) return;
      if (e.key === "Escape") {
        // Escape clears the search first, then leaves the field (R8).
        e.preventDefault();
        e.stopPropagation();
        if (value) onChange("");
        else if (onDismiss) onDismiss();
      } else if (e.key === "ArrowDown") {
        const first = e.currentTarget.closest('[data-calendar-search-scope]')?.querySelector<HTMLElement>(RESULT_SELECTOR);
        if (first) { e.preventDefault(); first.focus(); }
      }
    };
    return (
      <div ref={fieldRef} role="search" className={className}>
        <ToolbarSearch
          ref={ref}
          value={value}
          autoFocus={autoFocus}
          onChange={(e) => onChange(e.target.value)}
          onKeyDown={handleKeyDown}
          onClear={() => {
            onChange("");
            fieldRef.current?.querySelector<HTMLInputElement>('[data-calendar-search]')?.focus();
          }}
          clearLabel={t("search.clear")}
          shortcut="/"
          placeholder={t("search.title")}
          aria-label={t("search.title")}
          autoComplete="off"
          data-calendar-search
        />
      </div>
    );
  },
);

interface CalendarSearchResultsProps {
  query: string;
  results: Results;
  calendars: Calendar[];
  timeFormat?: "12h" | "24h";
  currentUserEmails?: string[];
  onSelectEvent: (event: CalendarEvent, anchorRect: DOMRect) => void;
  onContextMenuEvent?: (e: React.MouseEvent, event: CalendarEvent) => void;
  /** Empties the search box, back to the calendar (R9). */
  onClearSearch?: () => void;
}

/** The events a calendar search found, upcoming first, then past ones. */
export function CalendarSearchResults({
  query, results, calendars, timeFormat = "24h", currentUserEmails, onSelectEvent, onContextMenuEvent, onClearSearch,
}: CalendarSearchResultsProps) {
  const t = useTranslations("calendar");
  const paint = useCvdColor();
  const intlFormatter = useDisplayDateFormatter();
  const listRef = useRef<HTMLDivElement>(null);
  const sectionId = useId();
  const focusSearch = () => listRef.current?.closest('[data-calendar-search-scope]')?.querySelector<HTMLInputElement>('[data-calendar-search]')?.focus();
  const calendarMap = useMemo(() => new Map(calendars.map((c) => [c.id, c])), [calendars]);
  const { upcoming, past, searching } = results;
  const count = upcoming.length + past.length;
  const thisYear = displayNow().getFullYear();

  const formatTime = (date: Date) => timeFormat === "12h"
    ? intlFormatter.dateTime(date, { hour: "numeric", minute: "2-digit", hour12: true })
    : format(date, "HH:mm");

  // Navigation stays inside this pane; moving focus never opens an event.
  const handleRowKeyDown = (e: KeyboardEvent<HTMLButtonElement>) => {
    if (e.nativeEvent.isComposing || e.ctrlKey || e.metaKey || e.altKey || e.shiftKey) return;
    if (!["ArrowDown", "ArrowUp", "Home", "End", "Escape"].includes(e.key)) return;
    e.preventDefault();
    e.stopPropagation();
    const rows = Array.from(listRef.current?.querySelectorAll<HTMLElement>(RESULT_SELECTOR) ?? []);
    const index = rows.indexOf(e.currentTarget);
    if (e.key === "Escape" || (e.key === "ArrowUp" && index === 0)) {
      focusSearch();
      return;
    }
    const next = e.key === "Home" ? rows[0] : e.key === "End" ? rows.at(-1)
      : rows[index + (e.key === "ArrowDown" ? 1 : -1)];
    next?.focus();
    next?.scrollIntoView?.({block: "nearest"});
  };

  const renderRow = (ev: CalendarEvent) => {
    const calId = getPrimaryCalendarId(ev);
    const calendar = calId ? calendarMap.get(calId) : undefined;
    const color = paint(getEventColor(ev, calendar));
    const start = getEventStartDate(ev);
    const end = getEventEndDate(ev);
    const isInactive = ev.status === "cancelled" || isDeclinedByUser(ev, currentUserEmails);
    const locationName = ev.locations ? Object.values(ev.locations)[0]?.name : null;
    const meta = [locationName, calendar?.name].filter(Boolean).join(" · ");
    // A series the server found by its first occurrence.
    const repeats = !ev.recurrenceId && isRecurringEvent(ev);
    const sameYear = start.getFullYear() === thisYear;
    const title = ev.title || t("events.no_title");
    return (
      <button
        key={ev.id}
        type="button"
        data-search-result
        onClick={(e) => onSelectEvent(ev, e.currentTarget.getBoundingClientRect())}
        onContextMenu={onContextMenuEvent ? (e) => onContextMenuEvent(e, ev) : undefined}
        onKeyDown={handleRowKeyDown}
        className="memail-calendar-result w-full min-w-0 grid items-start gap-x-3 gap-y-1 rounded-lg px-3 hover:bg-muted/60 focus-visible:bg-muted/60 outline-none focus-inset transition-colors text-start"
        style={{ paddingBlock: "var(--density-item-py)" }}
      >
        <span className="memail-calendar-result-date text-sm leading-snug">
          <time dateTime={format(start, ev.showWithoutTime ? "yyyy-MM-dd" : "yyyy-MM-dd'T'HH:mm:ss")} className="block text-foreground">
            {intlFormatter.dateTime(start, sameYear
              ? { weekday: "short", month: "short", day: "numeric" }
              : { month: "short", day: "numeric", year: "numeric" })}
          </time>
          <span className="block text-xs text-muted-foreground tabular-nums">
            {ev.showWithoutTime ? t("events.all_day") : <bdi dir="ltr">{`${formatTime(start)} – ${formatTime(end)}`}</bdi>}
          </span>
        </span>
        <span
          className="memail-calendar-result-dot w-[9px] h-[9px] mt-[5.5px] rounded-full"
          style={isInactive ? { boxShadow: `inset 0 0 0 1.5px ${color}` } : { backgroundColor: color }}
          aria-hidden="true"
        />
        <span className="flex-1 min-w-0">
          <span className="flex min-w-0">
            <span dir="auto" className={cn("min-w-0 text-sm font-medium line-clamp-2 break-words", isInactive && "line-through text-muted-foreground")} title={title}>
              {title}
            </span>
          </span>
          {(meta || repeats) && (
            <span className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted-foreground mt-1 min-w-0">
              {meta && <span dir="auto" className="min-w-0 break-words" title={meta}>
                {locationName && <MapPin className="me-1 inline h-3 w-3 align-text-bottom" aria-hidden="true"/>}
                {meta}
              </span>}
              {repeats && (
                <span className="flex items-center gap-1 flex-shrink-0">
                  <Repeat className="w-3 h-3" aria-hidden="true" />
                  {t("search.repeats")}
                </span>
              )}
            </span>
          )}
        </span>
      </button>
    );
  };

  const section = (id: string, label: string, events: CalendarEvent[]) => events.length > 0 && (
    <section aria-labelledby={id} className="py-1">
      <h2 id={id} className="sticky top-0 z-10 border-b border-border/50 bg-background/95 px-4 py-2 text-xs font-semibold text-muted-foreground backdrop-blur-sm">
        {label}
      </h2>
      <div className="space-y-1 px-2 py-2">{events.map(renderRow)}</div>
    </section>
  );

  return (
    <div ref={listRef} className="memail-calendar-results flex-1 min-h-0 min-w-0 overflow-y-auto" aria-busy={searching} data-testid="calendar-search-results">
      <p className="sr-only" role="status" aria-live="polite">
        {searching && count === 0 ? "" : t("search.results", { count })}
      </p>
      {count === 0 && searching && (
        <div className="flex justify-center p-8"><Spinner /></div>
      )}
      {count === 0 && !searching && (
        <EmptyState
          icon={Search}
          title={t("search.no_results", { query: query.trim() })}
          description={t("search.no_results_hint")}
          actions={onClearSearch && (
            <Button size="sm" variant="outline" onClick={() => { onClearSearch?.(); focusSearch(); }}>
              {t("search.clear")}
            </Button>
          )}
        />
      )}
      {section(`${sectionId}-upcoming`, t("search.upcoming"), upcoming)}
      {section(`${sectionId}-past`, t("search.past"), past)}
      {count > 0 && searching && (
        <div className="flex justify-center py-3"><Spinner size="sm" /></div>
      )}
    </div>
  );
}
