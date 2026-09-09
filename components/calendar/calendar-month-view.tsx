"use client";

import { useMemo, useState, useCallback, useRef, useLayoutEffect, type DragEvent } from "react";
import { useTranslations } from "next-intl";
import { format, parseISO, eachDayOfInterval, addDays } from "date-fns";
import { cn } from "@/lib/utils";
import { EventCard } from "./event-card";
import { buildWeekSegments, getEventDayBounds, getPrimaryCalendarId } from "@/lib/calendar-utils";
import type { CalendarEvent, Calendar } from "@/lib/jmap/types";
import { useAuthStore } from "@/stores/auth-store";
import { useCalendarStore } from "@/stores/calendar-store";
import { useSettingsStore } from "@/stores/settings-store";
import type { PendingEventPreview } from "./event-modal";
import { toast } from "@/stores/toast-store";
import { useCalendarLocale } from "@/hooks/use-calendar-locale";
import { useScrollWindow } from "@/hooks/use-scroll-window";
import { dayKey, parseDayKey, type ScrollWindowViewProps } from "@/lib/calendar-scroll-window";

interface CalendarMonthViewProps extends ScrollWindowViewProps {
  selectedDate: Date;
  events: CalendarEvent[];
  calendars: Calendar[];
  onSelectDate: (date: Date) => void;
  onSelectEvent: (event: CalendarEvent, anchorRect: DOMRect) => void;
  onHoverEvent?: (event: CalendarEvent, anchorRect: DOMRect) => void;
  onHoverLeave?: () => void;
  onContextMenuEvent?: (e: React.MouseEvent, event: CalendarEvent) => void;
  onContextMenuEmpty?: (e: React.MouseEvent, date: Date, hour?: number, allDayArea?: boolean) => void;
  onCreateAtTime?: (date: Date) => void;
  firstDayOfWeek?: number;
  isMobile?: boolean;
  pendingPreview?: PendingEventPreview | null;
}

/** Fraction of the viewport height at which the "current month" is sampled. */
const VISIBLE_MONTH_SAMPLE = 0.4;

export function CalendarMonthView({
  selectedDate,
  focus,
  events,
  calendars,
  rangeStart,
  rangeEnd,
  windowKey,
  onExtendStart,
  onExtendEnd,
  isLoading = false,
  onVisibleDateChange,
  onSelectDate,
  onSelectEvent,
  onHoverEvent,
  onHoverLeave,
  onContextMenuEvent,
  onContextMenuEmpty,
  onCreateAtTime,
  isMobile,
  pendingPreview,
}: CalendarMonthViewProps) {
  const t = useTranslations("calendar");
  const showTimeInMonthView = useSettingsStore((state) => state.showTimeInMonthView);
  // On mobile the month view collapses events to dots unless the user opted
  // into full entries via "Show time in month view" (#666).
  const showChips = !isMobile || showTimeInMonthView;
  const overlayTop = isMobile ? 34 : 30;
  const rowHeight = isMobile ? 18 : 22;
  const chipHeight = rowHeight - 2;
  const baseRowMinHeight = isMobile ? 52 : 100;
  const {
    dayHeaderKeys,
    getMonthGridDays,
    checkIsToday,
    checkIsSameMonth,
    checkIsSameDay,
    formatDayNumber,
    formatFullDate,
    getMonth,
    getYear,
    monthLabelKeys,
  } = useCalendarLocale();

  // The loaded window is a run of whole weeks (#759): scrolling moves through
  // them continuously and the edges widen the window.
  const weeks = useMemo(() => {
    const days = eachDayOfInterval({ start: rangeStart, end: rangeEnd });
    const result: Date[][] = [];
    for (let i = 0; i + 7 <= days.length; i += 7) {
      result.push(days.slice(i, i + 7));
    }
    return result;
  }, [rangeStart, rangeEnd]);

  const calendarMap = useMemo(() => {
    const map = new Map<string, Calendar>();
    calendars.forEach((c) => map.set(c.id, c));
    return map;
  }, [calendars]);

  const eventsByDate = useMemo(() => {
    const map = new Map<string, CalendarEvent[]>();
    events.forEach((e) => {
      try {
        const { startDay, endDay } = getEventDayBounds(e);

        const cursor = new Date(startDay);
        while (cursor <= endDay) {
          const key = format(cursor, "yyyy-MM-dd");
          const arr = map.get(key) || [];
          arr.push(e);
          map.set(key, arr);
          cursor.setDate(cursor.getDate() + 1);
        }
      } catch { /* skip invalid dates */ }
    });
    return map;
  }, [events]);

  const weekSegments = useMemo(() => {
    return weeks.map((week) => {
      const segments = buildWeekSegments(events, week);
      const rowCount = segments.reduce((maxRows, segment) => Math.max(maxRows, segment.row + 1), 0);
      return { week, segments, rowCount };
    });
  }, [events, weeks]);

  const scrollRef = useRef<HTMLDivElement>(null);
  const topSentinelRef = useRef<HTMLDivElement>(null);
  const bottomSentinelRef = useRef<HTMLDivElement>(null);

  // Six rows fill the viewport, as a single month used to; taller rows grow
  // with their chips.
  const [viewportHeight, setViewportHeight] = useState(0);
  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(() => setViewportHeight(el.clientHeight));
    observer.observe(el);
    setViewportHeight(el.clientHeight);
    return () => observer.disconnect();
  }, []);
  const rowMinHeight = Math.max(baseRowMinHeight, Math.floor(viewportHeight / 6));

  // The month the user is looking at: sampled a little above the middle of
  // the viewport. It dims the other months' days and drives the title.
  const [visibleMonthDate, setVisibleMonthDate] = useState<Date>(() => focus.date);
  const visibleMonthRef = useRef(visibleMonthDate);
  const scrollFrameRef = useRef<number | null>(null);

  const sampleVisibleMonth = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    const sampleY = el.getBoundingClientRect().top + el.clientHeight * VISIBLE_MONTH_SAMPLE;
    const rows = el.querySelectorAll<HTMLElement>("[data-week]");
    let hit: HTMLElement | null = null;
    for (const row of rows) {
      if (row.getBoundingClientRect().bottom >= sampleY) { hit = row; break; }
    }
    const weekKey = hit?.dataset.week;
    if (!weekKey) return;
    const midWeek = addDays(parseDayKey(weekKey), 3);
    const current = visibleMonthRef.current;
    if (getMonth(midWeek) === getMonth(current) && getYear(midWeek) === getYear(current)) return;
    visibleMonthRef.current = midWeek;
    setVisibleMonthDate(midWeek);
    onVisibleDateChange?.(midWeek);
  }, [getMonth, getYear, onVisibleDateChange]);

  const handleScroll = useCallback(() => {
    if (scrollFrameRef.current !== null) return;
    scrollFrameRef.current = requestAnimationFrame(() => {
      scrollFrameRef.current = null;
      sampleVisibleMonth();
    });
  }, [sampleVisibleMonth]);

  // Navigation puts the first week of the focused month at the top.
  const scrollToFocus = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    const grid = getMonthGridDays(focus.date);
    const targetKey = dayKey(grid[0] ?? focus.date);
    const row = el.querySelector<HTMLElement>(`[data-week="${targetKey}"]`);
    if (row) {
      el.scrollTop += row.getBoundingClientRect().top - el.getBoundingClientRect().top;
    }
    visibleMonthRef.current = focus.date;
    setVisibleMonthDate(focus.date);
  }, [focus.date, getMonthGridDays]);

  useScrollWindow({
    scrollRef,
    axis: "vertical",
    isLoading,
    windowKey,
    focusNonce: focus.nonce,
    scrollToFocus,
    onExtendStart,
    onExtendEnd,
    startSentinelRef: topSentinelRef,
    endSentinelRef: bottomSentinelRef,
    contentKey: weekSegments,
    anchorSelector: "[data-week]",
  });

  const [dropDayKey, setDropDayKey] = useState<string | null>(null);

  const handleCellDragOver = useCallback((e: DragEvent<HTMLDivElement>, dayKey: string) => {
    if (!e.dataTransfer.types.includes("application/x-calendar-event")) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = "move";
    setDropDayKey((prev) => prev === dayKey ? prev : dayKey);
  }, []);

  const handleCellDragLeave = useCallback((e: DragEvent<HTMLDivElement>) => {
    const related = e.relatedTarget as Node | null;
    if (!e.currentTarget.contains(related)) setDropDayKey(null);
  }, []);

  const handleCellDrop = useCallback(async (e: DragEvent<HTMLDivElement>, day: Date) => {
    e.preventDefault();
    setDropDayKey(null);
    const json = e.dataTransfer.getData("application/x-calendar-event");
    if (!json) return;
    try {
      const data = JSON.parse(json);
      const originalStart = parseISO(data.originalStart);
      const event = useCalendarStore.getState().events.find(e => e.id === data.eventId);
      const isAllDay = event?.showWithoutTime;
      const newStart = new Date(day);
      newStart.setHours(originalStart.getHours(), originalStart.getMinutes(), originalStart.getSeconds(), 0);
      const newStartISO = isAllDay ? format(newStart, "yyyy-MM-dd") : format(newStart, "yyyy-MM-dd'T'HH:mm:ss");
      if (newStartISO === data.originalStart) return;
      const client = useAuthStore.getState().client;
      if (!client) return;
      const hasParticipants = event?.participants && Object.keys(event.participants).length > 0;
      await useCalendarStore.getState().updateEvent(client, data.eventId, { start: newStartISO }, hasParticipants || undefined);
    } catch {
      toast.error(t("notifications.event_move_error"));
    }
  }, [t]);

  return (
    <div className="flex flex-col flex-1 overflow-hidden" role="grid" aria-label={formatFullDate(selectedDate)}>
      <div className="grid grid-cols-7 border-b border-border" role="row">
        {dayHeaderKeys.map((d) => (
          <div key={d} role="columnheader" className={cn(
            "text-center text-xs font-medium text-muted-foreground py-2 border-e border-border last:border-e-0",
            isMobile && "py-1.5 text-[11px]"
          )}>
            {isMobile ? t(`days.${d}`).slice(0, 2) : t(`days.${d}`)}
          </div>
        ))}
      </div>

      <div
        ref={scrollRef}
        className="flex-1 flex flex-col overflow-y-auto [overflow-anchor:none]"
        onScroll={handleScroll}
      >
        <div ref={topSentinelRef} data-testid="month-top-sentinel" className="h-px flex-shrink-0" />
        {weekSegments.map(({ week, segments, rowCount }) => (
          <div key={dayKey(week[0])} data-week={dayKey(week[0])} className="relative flex-shrink-0 border-b border-border" role="row" style={{
            minHeight: showChips
              ? Math.max(rowMinHeight, overlayTop + 4 + rowCount * rowHeight + 8)
              : rowMinHeight,
          }}>
            <div className="grid grid-cols-7 h-full">
            {week.map((day, dayIndex) => {
              const inMonth = checkIsSameMonth(day, visibleMonthDate);
              const selected = checkIsSameDay(day, selectedDate);
              const today = checkIsToday(day);
              const key = format(day, "yyyy-MM-dd");
              const dayEvents = eventsByDate.get(key) || [];
              const fullDateLabel = formatFullDate(day);
              const previous = dayIndex > 0 ? week[dayIndex - 1] : addDays(day, -1);
              const firstOfMonth = !checkIsSameMonth(day, previous);

              return (
                <div
                  key={key}
                  role="gridcell"
                  aria-selected={selected}
                  aria-label={fullDateLabel}
                  onClick={() => onSelectDate(day)}
                  onDoubleClick={() => onCreateAtTime?.(day)}
                  onContextMenu={onContextMenuEmpty ? (e) => onContextMenuEmpty(e, day, undefined, true) : undefined}
                  onDragOver={(e) => handleCellDragOver(e, key)}
                  onDragLeave={handleCellDragLeave}
                  onDrop={(e) => handleCellDrop(e, day)}
                  className={cn(
                    "border-e border-border last:border-e-0 p-1 cursor-pointer transition-colors touch-manipulation",
                    !inMonth && "bg-muted/30",
                    "hover:bg-muted/50",
                    selected && isMobile && "bg-primary/10",
                    dropDayKey === key && "ring-2 ring-inset ring-primary bg-primary/10"
                  )}
                >
                  <div className="flex items-center justify-center gap-1 mb-0.5">
                    {firstOfMonth && (
                      <span className={cn("text-[10px] font-medium", inMonth ? "text-muted-foreground" : "text-muted-foreground/60")}>
                        {t(`months.${monthLabelKeys[getMonth(day)]}`)}
                      </span>
                    )}
                    <span
                      className={cn(
                        "inline-flex items-center justify-center rounded-full",
                        isMobile ? "w-7 h-7 text-xs" : "w-6 h-6 text-xs",
                        today && !selected && "bg-primary text-primary-foreground font-bold",
                        selected && "bg-primary text-primary-foreground font-bold",
                        !inMonth && !selected && !today && "text-muted-foreground/50",
                        inMonth && !selected && !today && "font-medium"
                      )}
                    >
                      {formatDayNumber(day)}
                    </span>
                  </div>
                  {isMobile && !showChips ? (
                    <div className="flex items-center justify-center gap-0.5 flex-wrap">
                      {dayEvents.slice(0, 3).map((ev) => {
                        const calId = getPrimaryCalendarId(ev);
                        const cal = calId ? calendarMap.get(calId) : undefined;
                        const evColor = ev.color || cal?.color || "#3b82f6";
                        return (
                          <span
                            key={ev.id}
                            className="w-1.5 h-1.5 rounded-full"
                            style={{ backgroundColor: evColor }}
                          />
                        );
                      })}
                      {dayEvents.length > 3 && (
                        <span className="w-1.5 h-1.5 rounded-full bg-muted-foreground/40" />
                      )}
                      {pendingPreview && checkIsSameDay(pendingPreview.start, day) && (
                        <span
                          className="w-1.5 h-1.5 rounded-full border border-dashed"
                          style={{ borderColor: calendarMap.get(pendingPreview.calendarId)?.color || "#3b82f6" }}
                        />
                      )}
                    </div>
                  ) : null}
                </div>
              );
            })}
            </div>

            {showChips && pendingPreview && (() => {
              const previewDayIdx = week.findIndex(d => checkIsSameDay(d, pendingPreview.start));
              if (previewDayIdx === -1) return null;
              const previewRow = rowCount;
              const cal = calendarMap.get(pendingPreview.calendarId);
              const color = cal?.color || "#3b82f6";
              return (
                <div className="absolute inset-x-0 pointer-events-none" style={{ top: overlayTop }}>
                  <div
                    className="absolute px-0.5"
                    style={{
                      left: `calc(${(previewDayIdx / 7) * 100}% + 1px)`,
                      width: `calc(${(1 / 7) * 100}% - 2px)`,
                      top: previewRow * rowHeight,
                      height: chipHeight,
                    }}
                  >
                    <div
                      className={cn(
                        "h-full rounded text-[10px] font-medium truncate border-2 border-dashed",
                        isMobile ? "leading-[16px] px-1" : "leading-[20px] px-1.5"
                      )}
                      style={{ borderColor: color, color, backgroundColor: `${color}10` }}
                    >
                      {pendingPreview.title}
                    </div>
                  </div>
                </div>
              );
            })()}

            {showChips && segments.length > 0 && (
              <div className="absolute inset-x-0 pointer-events-none" style={{ top: overlayTop }}>
                {segments.map((segment) => {
                  const calId = getPrimaryCalendarId(segment.event);
                  return (
                    <div
                      key={`${segment.event.id}-${segment.startIndex}-${segment.row}`}
                      className="absolute px-0.5 pointer-events-auto"
                      style={{
                        left: `calc(${(segment.startIndex / 7) * 100}% + 1px)`,
                        width: `calc(${(segment.span / 7) * 100}% - 2px)`,
                        top: segment.row * rowHeight,
                        height: chipHeight,
                      }}
                    >
                      <EventCard
                        event={segment.event}
                        calendar={calId ? calendarMap.get(calId) : undefined}
                        variant="span"
                        continuesBefore={segment.continuesBefore}
                        continuesAfter={segment.continuesAfter}
                        onClick={(rect) => onSelectEvent(segment.event, rect)}
                        onMouseEnter={(rect) => onHoverEvent?.(segment.event, rect)}
                        onMouseLeave={onHoverLeave}
                        onContextMenu={onContextMenuEvent}
                        draggable
                        className={isMobile ? "text-[10px] px-1" : undefined}
                      />
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        ))}
        <div ref={bottomSentinelRef} data-testid="month-bottom-sentinel" className="h-px flex-shrink-0" />
      </div>
    </div>
  );
}
