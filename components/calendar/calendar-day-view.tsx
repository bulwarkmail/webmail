"use client";

import { useMemo, useEffect, useLayoutEffect, useRef, useState, useCallback } from "react";
import { useTranslations } from "next-intl";
import { useDisplayDateFormatter } from "@/hooks/use-display-date-formatter";
import { format, isSameDay, eachDayOfInterval, differenceInCalendarDays } from "date-fns";
import { cn } from "@/lib/utils";
import { Check } from "@/components/icons";
import { EventCard } from "./event-card";
import { QuickEventInput } from "./quick-event-input";
import { AllHoursToggle, HiddenEventsIndicator } from "./display-hours-controls";
import { formatSnapTime, getEventDayBounds, getPrimaryCalendarId, isTimedEventFullDayOnDate, layoutOverlappingEvents } from "@/lib/calendar-utils";
import { clipToDisplayHours, partitionByDisplayHours } from "@/lib/calendar-display-range";
import { displayNow, isDisplayToday } from "@/lib/timezone";
import { groupTasksByDueDay } from "@/lib/calendar-tasks";
import type { CalendarEvent, Calendar, CalendarTask } from "@/lib/jmap/types";
import { useDisplayHours } from "@/hooks/use-display-hours";
import { useTimeGridInteractions } from "@/hooks/use-time-grid-interactions";
import { useScrollWindow, getScrollStart, setScrollStart, scrollToStart } from "@/hooks/use-scroll-window";
import { dayKey, type ScrollWindowViewProps } from "@/lib/calendar-scroll-window";
import type { PendingEventPreview } from "./event-modal";
import { readableTextOn } from "@/lib/color-transform";

interface CalendarDayViewProps extends ScrollWindowViewProps {
  selectedDate: Date;
  events: CalendarEvent[];
  calendars: Calendar[];
  onSelectEvent: (event: CalendarEvent, anchorRect: DOMRect) => void;
  onHoverEvent?: (event: CalendarEvent, anchorRect: DOMRect) => void;
  onHoverLeave?: () => void;
  onContextMenuEvent?: (e: React.MouseEvent, event: CalendarEvent) => void;
  onContextMenuEmpty?: (e: React.MouseEvent, date: Date, hour?: number, allDayArea?: boolean) => void;
  onCreateAtTime: (date: Date, endDate?: Date) => void;
  timeFormat?: "12h" | "24h";
  isMobile?: boolean;
  pendingPreview?: PendingEventPreview | null;
  tasks?: CalendarTask[];
  onToggleTaskComplete?: (task: CalendarTask) => void;
  onSelectTask?: (task: CalendarTask) => void;
  /** The user's calendar addresses, to mark events they declined (#1110). */
  currentUserEmails?: string[];
}

const HOUR_HEIGHT = 64;
const HOURS = Array.from({ length: 24 }, (_, i) => i);
const FALLBACK_COL_WIDTH = 600;

export function CalendarDayView({
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
  onSelectEvent,
  onHoverEvent,
  onHoverLeave,
  onContextMenuEvent,
  onContextMenuEmpty,
  onCreateAtTime,
  timeFormat = "24h",
  isMobile,
  pendingPreview,
  tasks,
  onToggleTaskComplete,
  onSelectTask,
  currentUserEmails,
}: CalendarDayViewProps) {
  const t = useTranslations("calendar");
  // Grid days / event dates are display dates (local fields = wall-clock in
  // the user's zone); the app-wide formatter would shift them again (#755).
  const intlFormatter = useDisplayDateFormatter();
  // One scroll container for both axes (#759): the strip scrolls sideways,
  // the hours scroll down, and the sticky header block and hour gutter stay
  // put. (A nested vertical scroller would capture the gutter's stickiness.)
  const rootRef = useRef<HTMLDivElement>(null);
  const startSentinelRef = useRef<HTMLDivElement>(null);
  const endSentinelRef = useRef<HTMLDivElement>(null);
  const gutterWidth = isMobile ? 40 : 64;

  // One full-width column per loaded day (#759): the strip pages sideways
  // through the days and widens at either end.
  const days = useMemo(
    () => eachDayOfInterval({ start: rangeStart, end: rangeEnd }),
    [rangeStart, rangeEnd],
  );
  const colCount = days.length;

  const measureColWidth = useCallback((root: HTMLElement | null) => {
    if (!root || root.clientWidth <= gutterWidth) return FALLBACK_COL_WIDTH;
    return root.clientWidth - gutterWidth;
  }, [gutterWidth]);
  const [colWidth, setColWidth] = useState(FALLBACK_COL_WIDTH);
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
  // When that width changes (first measurement, resize) keep the same day
  // in view.
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

  const eventsByDay = useMemo(() => {
    const map = new Map<string, { timed: CalendarEvent[]; allDay: CalendarEvent[] }>();
    const bucket = (key: string) => {
      let entry = map.get(key);
      if (!entry) {
        entry = { timed: [], allDay: [] };
        map.set(key, entry);
      }
      return entry;
    };
    events.forEach((ev) => {
      try {
        const { startDay, endDay } = getEventDayBounds(ev);
        const cursor = new Date(startDay);
        while (cursor <= endDay) {
          const key = format(cursor, "yyyy-MM-dd");
          if (ev.showWithoutTime || isTimedEventFullDayOnDate(ev, cursor)) bucket(key).allDay.push(ev);
          else bucket(key).timed.push(ev);
          cursor.setDate(cursor.getDate() + 1);
        }
      } catch { /* skip invalid dates */ }
    });
    return map;
  }, [events]);

  const tasksByDay = useMemo(() => groupTasksByDueDay(tasks), [tasks]);

  const {
    hours, canToggle: canToggleHours, configured: configuredHours, showAllHours, toggleAllHours, revealMinutes,
  } = useDisplayHours({ scrollRef: rootRef, hourHeight: HOUR_HEIGHT });
  const firstHour = hours.startMinutes / 60;
  const visibleHours = HOURS.slice(firstHour, hours.endMinutes / 60);
  const gridHeight = visibleHours.length * HOUR_HEIGHT;

  // Column layouts are the costly part of a render; with months of columns
  // they must not be redone on every scroll-driven re-render.
  const layoutByDay = useMemo(() => {
    const map = new Map<string, ReturnType<typeof partitionByDisplayHours> & { layouts: ReturnType<typeof layoutOverlappingEvents> }>();
    for (const day of days) {
      const key = format(day, "yyyy-MM-dd");
      const partition = partitionByDisplayHours(eventsByDay.get(key)?.timed ?? [], day, hours);
      map.set(key, { ...partition, layouts: layoutOverlappingEvents(partition.visible, day) });
    }
    return map;
  }, [days, eventsByDay, hours]);

  const hasAllDayArea = useMemo(
    () => days.some((day) => {
      const key = format(day, "yyyy-MM-dd");
      return (eventsByDay.get(key)?.allDay.length ?? 0) > 0 || (tasksByDay.get(key)?.length ?? 0) > 0;
    }),
    [days, eventsByDay, tasksByDay],
  );

  const scrollToFocus = useCallback(() => {
    const root = rootRef.current;
    if (!root) return;
    const index = Math.max(0, Math.min(colCount - 1, differenceInCalendarDays(focus.date, rangeStart)));
    setScrollStart(root, "horizontal", index * colWidth);
  }, [focus.date, colCount, rangeStart, colWidth]);

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

  // Report the day in view so the title and mini calendar follow, and settle
  // on a whole day once the scrolling has stopped. (CSS scroll snapping is
  // not used: browsers re-snap on their own when columns are prepended,
  // which would double the scroll correction.)
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
    gridStartMinutes: hours.startMinutes,
    gridEndMinutes: hours.endMinutes,
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
  const gutterClass = cn("flex-shrink-0 sticky start-0 z-40 bg-background", isMobile ? "w-10" : "w-16");

  return (
    <div
      ref={rootRef}
      className="flex min-h-0 min-w-0 flex-col flex-1 overflow-auto [overflow-anchor:none]"
      onScroll={handleStripScroll}
      role="grid"
      aria-label={intlFormatter.dateTime(selectedDate, { weekday: "long", month: "long", day: "numeric", year: "numeric" })}
    >
      <div className="relative flex flex-col" style={{ width: stripWidth, minWidth: stripWidth }}>
        <div ref={startSentinelRef} data-testid="day-start-sentinel" className="absolute inset-y-0 start-0 w-px pointer-events-none" />
        <div ref={endSentinelRef} data-testid="day-end-sentinel" className="absolute inset-y-0 end-0 w-px pointer-events-none" />

        <div className="sticky top-0 z-50 flex border-b border-border bg-background">
          <div className={cn(gutterClass, "flex items-end justify-center pb-1")}>
            {canToggleHours && (
              <AllHoursToggle
                showAllHours={showAllHours}
                configured={configuredHours}
                timeFormat={timeFormat}
                onToggle={toggleAllHours}
              />
            )}
          </div>
          <div className="grid" style={columnsStyle}>
            {days.map((day) => {
              const key = format(day, "yyyy-MM-dd");
              const today = isDisplayToday(day);
              const allDayEvents = eventsByDay.get(key)?.allDay ?? [];
              const dayTasks = tasksByDay.get(key) ?? [];
              return (
                <div key={key} data-day={key} className="min-w-0 border-e border-border last:border-e-0">
                  <div
                    className={cn("flex flex-col items-start gap-0.5 px-3 pt-2 pb-1.5", isMobile && "px-2")}
                    role="columnheader"
                    aria-label={intlFormatter.dateTime(day, { weekday: "long", month: "long", day: "numeric", year: "numeric" })}
                  >
                    <div className={cn(
                      "w-10 text-center text-[11px] font-medium uppercase tracking-wide",
                      today ? "text-primary" : "text-muted-foreground",
                    )}>
                      {intlFormatter.dateTime(day, { weekday: "short" })}
                    </div>
                    <div
                      aria-current={today ? "date" : undefined}
                      className={cn(
                        "inline-flex items-center justify-center w-10 h-10 rounded-full text-xl",
                        today ? "bg-primary text-primary-foreground font-semibold" : "text-foreground",
                      )}
                    >
                      {format(day, "d")}
                    </div>
                  </div>

                  {hasAllDayArea && (
                    <div
                      className="px-4 py-2 border-t border-border"
                      onContextMenu={onContextMenuEmpty ? (e) => {
                        if ((e.target as HTMLElement).closest("[data-calendar-event],button")) return;
                        onContextMenuEmpty(e, day, undefined, true);
                      } : undefined}
                    >
                      {allDayEvents.length > 0 && (
                        <>
                          <div className="text-[10px] text-muted-foreground mb-1">{t("events.all_day")}</div>
                          <div className="space-y-1">
                            {allDayEvents.map((ev) => {
                              const calId = getPrimaryCalendarId(ev);
                              return (
                                <EventCard
                                  key={ev.id}
                                  event={ev}
                                  calendar={calId ? calendarMap.get(calId) : undefined}
                                  variant="chip"
                                  onClick={(rect) => onSelectEvent(ev, rect)}
                                  onMouseEnter={(rect) => onHoverEvent?.(ev, rect)}
                                  onMouseLeave={onHoverLeave}
                                  onContextMenu={onContextMenuEvent}
                                  currentUserEmails={currentUserEmails}
                                />
                              );
                            })}
                          </div>
                        </>
                      )}
                      {dayTasks.length > 0 && (
                        <>
                          <div className={cn("text-[10px] text-muted-foreground mb-1", allDayEvents.length > 0 && "mt-2")}>{t("tasks.label")}</div>
                          <div className="space-y-0.5">
                            {dayTasks.map((task) => {
                              const isCompleted = task.progress === "completed";
                              const cal = calendars.find(c => task.calendarIds[c.id]);
                              const color = cal?.color || "#3b82f6";
                              return (
                                <div
                                  key={task.id}
                                  data-calendar-task={task.id}
                                  onClick={() => onSelectTask?.(task)}
                                  className="flex items-center gap-1.5 px-1.5 py-0.5 rounded text-xs cursor-pointer hover:bg-muted/50 transition-colors"
                                  style={{ borderInlineStart: `3px solid ${color}` }}
                                >
                                  <button
                                    type="button"
                                    onClick={(e) => { e.stopPropagation(); onToggleTaskComplete?.(task); }}
                                    className={cn(
                                      "flex-shrink-0 w-3.5 h-3.5 rounded-full border flex items-center justify-center",
                                      isCompleted
                                        ? "bg-success border-success text-success-foreground"
                                        : "border-muted-foreground/40 hover:border-primary"
                                    )}
                                    aria-label={isCompleted ? t("tasks.mark_incomplete") : t("tasks.mark_complete")}
                                  >
                                    {isCompleted && <Check className="h-2.5 w-2.5" />}
                                  </button>
                                  <span className={cn("truncate", isCompleted && "line-through text-muted-foreground")}>
                                    {task.title || t("tasks.no_title")}
                                  </span>
                                </div>
                              );
                            })}
                          </div>
                        </>
                      )}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </div>

        <div>
          <div className="flex relative" style={{ height: gridHeight }}>
            <div className={gutterClass}>
              {visibleHours.map((h) => (
                <div
                  key={h}
                  className="relative text-muted-foreground text-end pe-2"
                  style={{ height: HOUR_HEIGHT }}
                >
                  {/* Midnight goes unlabelled; a later first hour is labelled
                      inside its row, where the header cannot cover it. */}
                  {(h > firstHour || firstHour > 0) && (
                    <span className={cn(
                      "absolute right-2 leading-none",
                      h > firstHour ? "top-0 -translate-y-1/2" : "top-1",
                      isMobile ? "text-[10px]" : "text-xs",
                    )}>
                      {formatHour(h)}
                    </span>
                  )}
                </div>
              ))}
            </div>

            <div className="relative grid" style={columnsStyle}>
              {days.map((day) => {
                const key = format(day, "yyyy-MM-dd");
                const today = isDisplayToday(day);
                const dayLayout = layoutByDay.get(key);
                const layouted = dayLayout?.layouts ?? [];

                return (
                  <div
                    key={key}
                    className="relative border-s border-border"
                    role="row"
                    aria-label={intlFormatter.dateTime(day, { weekday: "long", month: "long", day: "numeric" })}
                    onPointerDown={(e) => handleGridPointerDown(e, key, day)}
                    onPointerMove={handleGridPointerMove}
                    onPointerUp={handleGridPointerUp}
                    onDragOver={(e) => handleColumnDragOver(e, key)}
                    onDragLeave={handleColumnDragLeave}
                    onDrop={(e) => handleColumnDrop(e, day)}
                  >
                    {visibleHours.map((h) => (
                      <div
                        key={h}
                        role="gridcell"
                        aria-label={formatHour(h)}
                        onClick={() => handleSlotClick(day, h)}
                        onDoubleClick={() => handleSlotDoubleClick(day, h)}
                        onContextMenu={onContextMenuEmpty ? (e) => onContextMenuEmpty(e, day, h, false) : undefined}
                        className="border-b border-border/50 hover:bg-muted/30 cursor-pointer transition-colors"
                        style={{ height: HOUR_HEIGHT }}
                      />
                    ))}

                    {dayLayout && dayLayout.before > 0 && (
                      <HiddenEventsIndicator
                        count={dayLayout.before}
                        direction="before"
                        onReveal={() => revealMinutes(dayLayout.firstBeforeMinutes ?? 0)}
                      />
                    )}
                    {dayLayout && dayLayout.after > 0 && (
                      <HiddenEventsIndicator
                        count={dayLayout.after}
                        direction="after"
                        onReveal={() => revealMinutes(dayLayout.firstAfterMinutes ?? hours.endMinutes)}
                      />
                    )}

                    {layouted.map(({ event: ev, column, totalColumns, startMinutes, endMinutes }) => {
                      const durMin = Math.max(15, endMinutes - startMinutes);
                      const clip = clipToDisplayHours(startMinutes, endMinutes, hours);
                      const baseHeight = Math.max(24, (Math.max(15, clip.endMinutes - clip.startMinutes) / 60) * HOUR_HEIGHT);
                      // Short events at the bottom edge stay inside the grid.
                      const baseTop = Math.max(0, Math.min(
                        ((clip.startMinutes - hours.startMinutes) / 60) * HOUR_HEIGHT,
                        gridHeight - baseHeight,
                      ));
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
                          style={{ top, height, left: `${leftPct}%`, width: `${widthPct}%`, paddingLeft: 2, paddingRight: 2 }}
                        >
                          <EventCard
                            event={ev}
                            calendar={calId ? calendarMap.get(calId) : undefined}
                            variant="block"
                            onClick={(rect) => onSelectEvent(ev, rect)}
                            onMouseEnter={(rect) => onHoverEvent?.(ev, rect)}
                            onMouseLeave={onHoverLeave}
                            onContextMenu={onContextMenuEvent}
                            currentUserEmails={currentUserEmails}
                            draggable
                          />
                          {/* An edge beyond the visible hours has nothing to grab. */}
                          {!clip.clippedStart && (
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
                          )}
                          {!clip.clippedEnd && (
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
                          )}
                        </div>
                      );
                    })}

                    {today && nowMinutes >= hours.startMinutes && nowMinutes <= hours.endMinutes && (
                      <div
                        className="absolute left-0 right-0 z-20 pointer-events-none"
                        style={{ top: ((nowMinutes - hours.startMinutes) / 60) * HOUR_HEIGHT }}
                      >
                        <div className="flex items-center -translate-y-1/2">
                          <div className="w-3 h-3 rounded-full bg-destructive -ms-1.5 flex-shrink-0" />
                          <div className="flex-1 h-0.5 bg-destructive" />
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
                          top: ((dragCreate.startMinutes - hours.startMinutes) / 60) * HOUR_HEIGHT,
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
                        style={{ top: ((dropTarget.minutes - hours.startMinutes) / 60) * HOUR_HEIGHT }}
                      >
                        <div className="flex items-center">
                          <div className="w-2.5 h-2.5 rounded-full bg-primary -ms-1" />
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
                        const endMin = pendingPreview.end.getHours() * 60 + pendingPreview.end.getMinutes();
                        const durationMin = Math.max(15, endMin - startMin);
                        if (startMin + durationMin <= hours.startMinutes || startMin >= hours.endMinutes) return null;
                        const clip = clipToDisplayHours(startMin, startMin + durationMin, hours);
                        const cal = calendars.find(c => c.id === pendingPreview.calendarId);
                        const color = cal?.color || "#3b82f6";
                        // Drawn like a saved event, so the new event shows where
                        // it will land while it is being created.
                        return (
                          <div
                            data-pending-preview
                            className="absolute left-0.5 right-0.5 z-30 rounded-xs pointer-events-none overflow-hidden px-1.5 py-0.5 text-xs shadow-md"
                            style={{
                              top: ((clip.startMinutes - hours.startMinutes) / 60) * HOUR_HEIGHT,
                              height: Math.max(24, ((clip.endMinutes - clip.startMinutes) / 60) * HOUR_HEIGHT),
                              backgroundColor: color,
                              color: readableTextOn(color),
                            }}
                          >
                            <div className="font-medium truncate">
                              {pendingPreview.title}
                            </div>
                            <div className="text-[10.5px] opacity-85 truncate">
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
