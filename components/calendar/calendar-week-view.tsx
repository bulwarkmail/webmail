"use client";

import { useMemo, useEffect, useLayoutEffect, useRef, useState, useCallback } from "react";
import { useTranslations } from "next-intl";
import { useDisplayDateFormatter } from "@/hooks/use-display-date-formatter";
import {
  startOfWeek, format, isSameDay, parseISO, eachDayOfInterval, differenceInCalendarDays,
} from "date-fns";
import { cn } from "@/lib/utils";
import { Check } from "lucide-react";
import { EventCard } from "./event-card";
import { QuickEventInput } from "./quick-event-input";
import { buildTimedFullDayWeekSegments, buildWeekSegmentsRaw, formatSnapTime, getEventDayBounds, getPrimaryCalendarId, isTimedEventFullDayOnDate, layoutOverlappingEvents, packWeekSegments } from "@/lib/calendar-utils";
import { displayNow, isDisplayToday } from "@/lib/timezone";
import type { CalendarEvent, Calendar, CalendarTask } from "@/lib/jmap/types";
import { useTimeGridInteractions } from "@/hooks/use-time-grid-interactions";
import { useScrollWindow, getScrollStart, setScrollStart, scrollToStart } from "@/hooks/use-scroll-window";
import { dayKey, type ScrollWindowViewProps } from "@/lib/calendar-scroll-window";
import type { PendingEventPreview } from "./event-modal";

interface CalendarWeekViewProps extends ScrollWindowViewProps {
  selectedDate: Date;
  events: CalendarEvent[];
  calendars: Calendar[];
  onSelectDate: (date: Date) => void;
  onSelectEvent: (event: CalendarEvent, anchorRect: DOMRect) => void;
  onHoverEvent?: (event: CalendarEvent, anchorRect: DOMRect) => void;
  onHoverLeave?: () => void;
  onContextMenuEvent?: (e: React.MouseEvent, event: CalendarEvent) => void;
  onContextMenuEmpty?: (e: React.MouseEvent, date: Date, hour?: number, allDayArea?: boolean) => void;
  onCreateAtTime: (date: Date, endDate?: Date) => void;
  firstDayOfWeek?: number;
  timeFormat?: "12h" | "24h";
  isMobile?: boolean;
  pendingPreview?: PendingEventPreview | null;
  tasks?: CalendarTask[];
  onToggleTaskComplete?: (task: CalendarTask) => void;
}

const HOUR_HEIGHT = 60;
const HOURS = Array.from({ length: 24 }, (_, i) => i);
const MOBILE_COL_WIDTH = 120;
const MIN_COL_WIDTH = 80;

export function CalendarWeekView({
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
  firstDayOfWeek = 1,
  timeFormat = "24h",
  isMobile,
  pendingPreview,
  tasks,
  onToggleTaskComplete,
}: CalendarWeekViewProps) {
  const t = useTranslations("calendar");
  // Grid days / event dates are display dates (local fields = wall-clock in
  // the user's zone); the app-wide formatter would shift them again (#755).
  const intlFormatter = useDisplayDateFormatter();
  // One scroll container for both axes (#759): the strip scrolls sideways,
  // the hours scroll down, and the sticky header rows and hour gutter stay
  // put. (A nested vertical scroller would capture the gutter's stickiness.)
  const rootRef = useRef<HTMLDivElement>(null);
  const startSentinelRef = useRef<HTMLDivElement>(null);
  const endSentinelRef = useRef<HTMLDivElement>(null);
  const weekStart = (firstDayOfWeek === 0 ? 0 : firstDayOfWeek === 6 ? 6 : 1) as 0 | 1 | 6;
  const gutterWidth = isMobile ? 40 : 56;

  // One column per loaded day (#759). Seven columns fill the viewport on
  // desktop; the strip scrolls sideways and widens at either end.
  const days = useMemo(
    () => eachDayOfInterval({ start: rangeStart, end: rangeEnd }),
    [rangeStart, rangeEnd],
  );
  const colCount = days.length;

  const measureColWidth = useCallback((root: HTMLElement | null) => {
    if (isMobile || !root) return MOBILE_COL_WIDTH;
    return Math.max(MIN_COL_WIDTH, Math.floor((root.clientWidth - gutterWidth) / 7));
  }, [isMobile, gutterWidth]);
  const [colWidth, setColWidth] = useState(MOBILE_COL_WIDTH);
  useLayoutEffect(() => {
    const root = rootRef.current;
    if (!root) return;
    setColWidth(measureColWidth(root));
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(() => setColWidth(measureColWidth(root)));
    observer.observe(root);
    return () => observer.disconnect();
  }, [measureColWidth]);

  // Every scroll offset is computed with the column width that is rendered.
  // When that width changes (first measurement, resize) keep the same day at
  // the start.
  const renderedColWidthRef = useRef<number | null>(null);
  useLayoutEffect(() => {
    const root = rootRef.current;
    const prev = renderedColWidthRef.current;
    renderedColWidthRef.current = colWidth;
    if (!root || prev === null || prev === colWidth) return;
    setScrollStart(root, "horizontal", Math.round(getScrollStart(root, "horizontal") / prev) * colWidth);
  }, [colWidth]);

  const stripWidth = gutterWidth + colCount * colWidth;
  const columnsStyle = { gridTemplateColumns: `repeat(${colCount}, ${colWidth}px)` };

  const calendarMap = useMemo(() => {
    const map = new Map<string, Calendar>();
    calendars.forEach((c) => map.set(c.id, c));
    return map;
  }, [calendars]);

  const timedEvents = useMemo(() => {
    const timed: Map<string, CalendarEvent[]> = new Map();

    events.forEach((ev) => {
      try {
        const { startDay, endDay } = getEventDayBounds(ev);

        const cursor = new Date(startDay);
        while (cursor <= endDay) {
          const key = format(cursor, "yyyy-MM-dd");
          if (!ev.showWithoutTime && !isTimedEventFullDayOnDate(ev, cursor)) {
            const arr = timed.get(key) || [];
            arr.push(ev);
            timed.set(key, arr);
          }
          cursor.setDate(cursor.getDate() + 1);
        }
      } catch { /* skip invalid dates */ }
    });
    return timed;
  }, [events]);

  // Column layouts are the costly part of a render; with months of columns
  // they must not be redone on every scroll-driven re-render.
  const layoutByDay = useMemo(() => {
    const map = new Map<string, ReturnType<typeof layoutOverlappingEvents>>();
    for (const day of days) {
      const key = format(day, "yyyy-MM-dd");
      map.set(key, layoutOverlappingEvents(timedEvents.get(key) || [], day));
    }
    return map;
  }, [days, timedEvents]);

  const allDaySegments = useMemo(() => {
    const explicitAllDay = buildWeekSegmentsRaw(
      events.filter((event) => event.showWithoutTime),
      days,
    );
    const timedFullDay = buildTimedFullDayWeekSegments(
      events.filter((event) => !event.showWithoutTime),
      days,
    );

    return packWeekSegments([...explicitAllDay, ...timedFullDay]);
  }, [events, days]);

  const allDayRowCount = useMemo(() => {
    return allDaySegments.reduce((maxRows, segment) => Math.max(maxRows, segment.row + 1), 0);
  }, [allDaySegments]);

  // Tasks grouped by day
  const tasksByDay = useMemo(() => {
    if (!tasks?.length) return new Map<string, CalendarTask[]>();
    const map = new Map<string, CalendarTask[]>();
    for (const task of tasks) {
      if (!task.due) continue;
      try {
        const key = format(parseISO(task.due), "yyyy-MM-dd");
        const existing = map.get(key) || [];
        existing.push(task);
        map.set(key, existing);
      } catch { /* skip */ }
    }
    return map;
  }, [tasks]);

  // Max tasks on any single loaded day
  const taskRowCount = useMemo(() => {
    let max = 0;
    for (const day of days) {
      const key = format(day, "yyyy-MM-dd");
      const count = tasksByDay.get(key)?.length ?? 0;
      if (count > max) max = count;
    }
    return max;
  }, [tasksByDay, days]);

  const hasAllDay = useMemo(() => {
    return allDaySegments.length > 0 || taskRowCount > 0;
  }, [allDaySegments, taskRowCount]);

  useEffect(() => {
    if (rootRef.current) {
      const now = displayNow();
      rootRef.current.scrollTop = Math.max(0, (now.getHours() - 1) * HOUR_HEIGHT);
    }
  }, []);

  // Navigation aligns the focused week (the focused day itself on mobile,
  // where fewer columns fit) with the start of the viewport.
  const scrollToFocus = useCallback(() => {
    const root = rootRef.current;
    if (!root) return;
    const target = isMobile ? focus.date : startOfWeek(focus.date, { weekStartsOn: weekStart });
    const index = Math.max(0, Math.min(colCount - 1, differenceInCalendarDays(target, rangeStart)));
    setScrollStart(root, "horizontal", index * colWidth);
  }, [focus.date, isMobile, weekStart, colCount, rangeStart, colWidth]);

  useScrollWindow({
    scrollRef: rootRef,
    axis: "horizontal",
    isLoading,
    windowKey,
    focusNonce: focus.nonce,
    scrollToFocus,
    onExtendStart,
    onExtendEnd,
    startSentinelRef,
    endSentinelRef,
    contentKey: days,
    anchorSelector: "[data-day]",
  });

  // Report the first column in view so the title and mini calendar follow,
  // and settle on a column boundary once the scrolling has stopped. (CSS
  // scroll snapping is not used: browsers re-snap on their own when columns
  // are prepended, which would double the scroll correction.)
  const visibleKeyRef = useRef<string | null>(null);
  const scrollFrameRef = useRef<number | null>(null);
  const snapTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const handleStripScroll = useCallback(() => {
    if (snapTimerRef.current !== null) clearTimeout(snapTimerRef.current);
    snapTimerRef.current = setTimeout(() => {
      snapTimerRef.current = null;
      const root = rootRef.current;
      if (!root || colWidth <= 0) return;
      const start = getScrollStart(root, "horizontal");
      const snapped = Math.round(start / colWidth) * colWidth;
      if (Math.abs(snapped - start) > 1) scrollToStart(root, "horizontal", snapped);
    }, 150);
    if (scrollFrameRef.current !== null) return;
    scrollFrameRef.current = requestAnimationFrame(() => {
      scrollFrameRef.current = null;
      const root = rootRef.current;
      if (!root || colWidth <= 0) return;
      const index = Math.max(0, Math.min(colCount - 1, Math.round(getScrollStart(root, "horizontal") / colWidth)));
      const day = days[index];
      if (!day) return;
      const key = dayKey(day);
      if (key === visibleKeyRef.current) return;
      visibleKeyRef.current = key;
      onVisibleDateChange?.(day);
    });
  }, [colWidth, colCount, days, onVisibleDateChange]);
  useEffect(() => () => {
    if (snapTimerRef.current !== null) clearTimeout(snapTimerRef.current);
    if (scrollFrameRef.current !== null) cancelAnimationFrame(scrollFrameRef.current);
  }, []);

  const [nowMinutes, setNowMinutes] = useState(() => {
    const now = displayNow();
    return now.getHours() * 60 + now.getMinutes();
  });
  useEffect(() => {
    const interval = setInterval(() => {
      const now = displayNow();
      setNowMinutes(now.getHours() * 60 + now.getMinutes());
    }, 60000);
    return () => clearInterval(interval);
  }, []);

  const {
    dragCreate, handleGridPointerDown, handleGridPointerMove, handleGridPointerUp,
    resizeVisual, handleResizePointerDown, handleResizePointerMove, handleResizePointerUp,
    quickCreate, handleSlotClick, handleSlotDoubleClick, handleQuickCreateSubmit, handleQuickCreateCancel,
    dropTarget, handleColumnDragOver, handleColumnDragLeave, handleColumnDrop,
  } = useTimeGridInteractions({
    hourHeight: HOUR_HEIGHT,
    calendars,
    onCreateRange: onCreateAtTime,
    errorMessages: {
      resize: t("notifications.event_resize_error"),
      move: t("notifications.event_move_error"),
      created: t("notifications.event_created"),
      error: t("notifications.event_error"),
    },
    isMobile,
  });

  const formatHour = (h: number): string => {
    if (timeFormat === "12h") {
      const d = new Date(2000, 0, 1, h);
      return intlFormatter.dateTime(d, { hour: "numeric", minute: "2-digit", hour12: true });
    }
    return format(new Date(2000, 0, 1, h), "HH:mm");
  };

  // Above every in-column overlay (events z-10, handles z-20, drag z-30) so
  // columns scrolled past the start do not show through the gutter.
  const gutterClass = cn("flex-shrink-0 sticky start-0 z-40 bg-background", isMobile ? "w-10" : "w-14");

  return (
    <div
      ref={rootRef}
      className="flex min-h-0 min-w-0 flex-col flex-1 overflow-auto [overflow-anchor:none]"
      onScroll={handleStripScroll}
      role="grid"
      aria-label={t("views.week")}
    >
      <div className="relative flex flex-col" style={{ width: stripWidth, minWidth: stripWidth }}>
      <div ref={startSentinelRef} data-testid="week-start-sentinel" className="absolute inset-y-0 start-0 w-px pointer-events-none" />
      <div ref={endSentinelRef} data-testid="week-end-sentinel" className="absolute inset-y-0 end-0 w-px pointer-events-none" />
      <div className="sticky top-0 z-50 bg-background">
      {hasAllDay && (
        <div className="flex border-b border-border">
          <div
            className={cn(gutterClass, "text-[10px] text-muted-foreground p-1 text-end")}
            style={{ minHeight: Math.max(28, (allDayRowCount + taskRowCount) * 24 + 4) }}
          >
            {t("events.all_day")}
          </div>
          <div
            className="relative grid border-s border-border"
            style={{ ...columnsStyle, minHeight: Math.max(28, (allDayRowCount + taskRowCount) * 24 + 4) }}
          >
            {days.map((day) => (
              <div
                key={format(day, "yyyy-MM-dd")}
                className="bg-background min-h-[28px] border-e border-border last:border-e-0"
                onContextMenu={onContextMenuEmpty ? (e) => onContextMenuEmpty(e, day, undefined, true) : undefined}
              />
            ))}

            <div className="absolute inset-0 pointer-events-none">
              {allDaySegments.map((segment) => {
                const calId = getPrimaryCalendarId(segment.event);
                return (
                  <div
                    key={`${segment.event.id}-${segment.startIndex}-${segment.row}`}
                    className="absolute px-0.5 pointer-events-auto"
                    style={{
                      left: `calc(${(segment.startIndex / colCount) * 100}% + 1px)`,
                      width: `calc(${(segment.span / colCount) * 100}% - 2px)`,
                      top: segment.row * 24 + 2,
                      height: 20,
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
                    />
                  </div>
                );
              })}
            </div>

            {/* Task chips in all-day area */}
            {taskRowCount > 0 && (
              <div className="absolute inset-x-0 pointer-events-none" style={{ top: allDayRowCount * 24 + 2 }}>
                {days.map((day, dayIndex) => {
                  const key = format(day, "yyyy-MM-dd");
                  const dayTasks = tasksByDay.get(key) || [];
                  return dayTasks.map((task, taskIndex) => {
                    const isCompleted = task.progress === "completed";
                    const cal = calendars.find(c => task.calendarIds[c.id]);
                    const color = cal?.color || "#3b82f6";
                    return (
                      <div
                        key={`task-${task.id}`}
                        className="absolute px-0.5 pointer-events-auto"
                        style={{
                          left: `calc(${(dayIndex / colCount) * 100}% + 1px)`,
                          width: `calc(${(1 / colCount) * 100}% - 2px)`,
                          top: taskIndex * 24,
                          height: 20,
                        }}
                      >
                        <div
                          className="h-full rounded text-[10px] leading-[20px] font-medium px-1.5 truncate flex items-center gap-1 cursor-pointer hover:opacity-80"
                          style={{ backgroundColor: `${color}20`, borderLeft: `3px solid ${color}` }}
                          onClick={() => onToggleTaskComplete?.(task)}
                        >
                          <span className={cn(
                            "w-2.5 h-2.5 rounded-full border flex-shrink-0 flex items-center justify-center",
                            isCompleted ? "bg-success border-success" : "border-current"
                          )}>
                            {isCompleted && <Check className="h-2 w-2 text-white" />}
                          </span>
                          <span className={cn("truncate", isCompleted && "line-through text-muted-foreground")}>
                            {task.title}
                          </span>
                        </div>
                      </div>
                    );
                  });
                })}
              </div>
            )}
          </div>
        </div>
      )}

      <div className="flex border-b border-border" role="row">
        <div className={gutterClass} />
        <div className="border-s border-border grid" style={columnsStyle}>
          {days.map((day) => {
            const todayCol = isDisplayToday(day);
            const selected = isSameDay(day, selectedDate);
            const fullLabel = intlFormatter.dateTime(day, { weekday: "long", month: "long", day: "numeric", year: "numeric" });
            return (
              <button
                key={day.toISOString()}
                onClick={() => onSelectDate(day)}
                role="columnheader"
                aria-label={fullLabel}
                data-day={dayKey(day)}
                className={cn(
                  "text-center py-2 text-sm border-e border-border last:border-e-0 transition-colors touch-manipulation",
                  "hover:bg-muted/50",
                  todayCol && "font-bold",
                )}
              >
                <div className="text-[10px] text-muted-foreground uppercase">
                  {intlFormatter.dateTime(day, { weekday: "short" })}
                </div>
                <div className={cn(
                  "inline-flex items-center justify-center w-7 h-7 rounded-full text-sm",
                  todayCol && "bg-primary text-primary-foreground",
                  selected && !todayCol && "bg-accent text-accent-foreground"
                )}>
                  {format(day, "d")}
                </div>
              </button>
            );
          })}
        </div>
      </div>

      </div>

      <div>
        <div className="flex relative" style={{ height: 24 * HOUR_HEIGHT }}>
          <div className={gutterClass}>
            {HOURS.map((h) => (
              <div
                key={h}
                className="relative text-muted-foreground text-end pe-2"
                style={{ height: HOUR_HEIGHT }}
              >
                {h > 0 && (
                  <span className={cn("absolute top-0 right-2 -translate-y-1/2 leading-none", isMobile ? "text-[9px]" : "text-[10px]")}>
                    {formatHour(h)}
                  </span>
                )}
              </div>
            ))}
          </div>

          <div className="border-s border-border relative grid" style={columnsStyle}>
            {days.map((day) => {
              const key = format(day, "yyyy-MM-dd");
              const todayCol = isDisplayToday(day);
              const layouted = layoutByDay.get(key) ?? [];

              return (
                <div
                  key={key}
                  className="relative border-e border-border last:border-e-0"
                  role="row"
                  aria-label={intlFormatter.dateTime(day, { weekday: "long", month: "long", day: "numeric" })}
                  onPointerDown={(e) => handleGridPointerDown(e, key, day)}
                  onPointerMove={handleGridPointerMove}
                  onPointerUp={handleGridPointerUp}
                  onDragOver={(e) => handleColumnDragOver(e, key)}
                  onDragLeave={handleColumnDragLeave}
                  onDrop={(e) => handleColumnDrop(e, day)}
                >
                  {HOURS.map((h) => (
                    <div
                      key={h}
                      role="gridcell"
                      aria-label={`${intlFormatter.dateTime(day, { weekday: "short" })} ${formatHour(h)}`}
                      onClick={() => handleSlotClick(day, h)}
                      onDoubleClick={() => handleSlotDoubleClick(day, h)}
                      onContextMenu={onContextMenuEmpty ? (e) => onContextMenuEmpty(e, day, h, false) : undefined}
                      className="border-b border-border/50 hover:bg-muted/30 cursor-pointer transition-colors"
                      style={{ height: HOUR_HEIGHT }}
                    />
                  ))}

                  {layouted.map(({ event: ev, column, totalColumns, startMinutes, endMinutes }) => {
                    const durMin = Math.max(15, endMinutes - startMinutes);
                    const baseTop = (startMinutes / 60) * HOUR_HEIGHT;
                    const baseHeight = Math.max(20, (durMin / 60) * HOUR_HEIGHT);
                    const isResizing = resizeVisual?.eventId === ev.id;
                    const top = isResizing ? resizeVisual!.topPx : baseTop;
                    const height = isResizing ? resizeVisual!.heightPx : baseHeight;
                    const calId = getPrimaryCalendarId(ev);
                    const leftPct = (column / totalColumns) * 100;
                    const widthPct = (1 / totalColumns) * 100;

                    return (
                      <div
                        key={ev.id}
                        className="absolute z-10 group/event"
                        data-calendar-event
                        style={{ top, height, left: `${leftPct}%`, width: `${widthPct}%`, paddingLeft: 1, paddingRight: 1 }}
                      >
                        <EventCard
                          event={ev}
                          calendar={calId ? calendarMap.get(calId) : undefined}
                          variant="block"
                          onClick={(rect) => onSelectEvent(ev, rect)}
                          onMouseEnter={(rect) => onHoverEvent?.(ev, rect)}
                          onMouseLeave={onHoverLeave}
                          onContextMenu={onContextMenuEvent}
                          draggable
                        />
                        <div
                          data-resize-handle
                          className="absolute top-0 left-1 right-1 h-3 cursor-n-resize z-20 flex items-start justify-center opacity-0 group-hover/event:opacity-100 transition-opacity"
                          aria-label={t("events.resize")}
                          onPointerDown={(e) => handleResizePointerDown(ev.id, "top", startMinutes, durMin, e)}
                          onPointerMove={handleResizePointerMove}
                          onPointerUp={handleResizePointerUp}
                        >
                          <div className="w-8 h-1 rounded-full bg-foreground/30 mt-0.5" />
                        </div>
                        <div
                          data-resize-handle
                          className="absolute bottom-0 left-1 right-1 h-3 cursor-s-resize z-20 flex items-end justify-center opacity-0 group-hover/event:opacity-100 transition-opacity"
                          aria-label={t("events.resize")}
                          onPointerDown={(e) => handleResizePointerDown(ev.id, "bottom", startMinutes, durMin, e)}
                          onPointerMove={handleResizePointerMove}
                          onPointerUp={handleResizePointerUp}
                        >
                          <div className="w-8 h-1 rounded-full bg-foreground/30 mb-0.5" />
                        </div>
                      </div>
                    );
                  })}

                  {todayCol && (
                    <div
                      className="absolute left-0 right-0 z-20 pointer-events-none"
                      style={{ top: (nowMinutes / 60) * HOUR_HEIGHT }}
                    >
                      <div className="flex items-center">
                        <div className="w-2 h-2 rounded-full bg-destructive -ms-1" />
                        <div className="flex-1 h-px bg-destructive" />
                      </div>
                    </div>
                  )}

                  {quickCreate?.dayKey === key && (
                    <QuickEventInput
                      top={quickCreate.top}
                      onSubmit={handleQuickCreateSubmit}
                      onCancel={handleQuickCreateCancel}
                    />
                  )}

                  {dragCreate?.dayKey === key && (
                    <div
                      className="absolute left-1 right-1 z-30 rounded-md pointer-events-none bg-primary/15 border-2 border-primary/30 border-dashed"
                      style={{
                        top: (dragCreate.startMinutes / 60) * HOUR_HEIGHT,
                        height: ((dragCreate.endMinutes - dragCreate.startMinutes) / 60) * HOUR_HEIGHT,
                      }}
                    >
                      <div className="text-[10px] font-medium text-primary px-1.5 py-0.5">
                        {formatSnapTime(dragCreate.startMinutes, timeFormat)} – {formatSnapTime(dragCreate.endMinutes, timeFormat)}
                      </div>
                    </div>
                  )}

                  {dropTarget?.dayKey === key && (
                    <div
                      className="absolute left-0 right-0 z-30 pointer-events-none"
                      style={{ top: (dropTarget.minutes / 60) * HOUR_HEIGHT }}
                    >
                      <div className="flex items-center">
                        <div className="w-2 h-2 rounded-full bg-primary -ms-1" />
                        <div className="flex-1 h-0.5 bg-primary rounded-full" />
                      </div>
                      <div className="absolute -top-4 left-2 text-[10px] font-medium text-primary bg-background/90 px-1 rounded shadow-sm">
                        {formatSnapTime(dropTarget.minutes, timeFormat)}
                      </div>
                    </div>
                  )}

                  {pendingPreview && !pendingPreview.allDay && isSameDay(pendingPreview.start, day) && (
                    (() => {
                      const startMin = pendingPreview.start.getHours() * 60 + pendingPreview.start.getMinutes();
                      let endMin = pendingPreview.end.getHours() * 60 + pendingPreview.end.getMinutes();
                      if (endMin <= startMin) endMin = 1440;
                      const durationMin = Math.max(15, endMin - startMin);
                      const cal = calendars.find(c => c.id === pendingPreview.calendarId);
                      const color = cal?.color || "hsl(var(--primary))";
                      return (
                        <div
                          className="absolute left-1 right-1 z-10 rounded-md pointer-events-none border-2 border-dashed overflow-hidden"
                          style={{
                            top: (startMin / 60) * HOUR_HEIGHT,
                            height: Math.max(20, (durationMin / 60) * HOUR_HEIGHT),
                            borderColor: color,
                            backgroundColor: `${color}10`,
                          }}
                        >
                          <div className="text-[10px] font-medium px-1.5 py-0.5 truncate" style={{ color }}>
                            {pendingPreview.title}
                          </div>
                          <div className="text-[9px] px-1.5 opacity-70" style={{ color }}>
                            {formatSnapTime(startMin, timeFormat)} – {formatSnapTime(startMin + durationMin, timeFormat)}
                          </div>
                        </div>
                      );
                    })()
                  )}
                </div>
              );
            })}
          </div>
        </div>
      </div>
      </div>
    </div>
  );
}
