"use client";

import { useMemo, useEffect, useLayoutEffect, useRef, useState, useCallback } from "react";
import { useTranslations } from "next-intl";
import { useDisplayDateFormatter } from "@/hooks/use-display-date-formatter";
import { format, isSameDay, parseISO, eachDayOfInterval, differenceInCalendarDays } from "date-fns";
import { cn } from "@/lib/utils";
import { Check } from "lucide-react";
import { EventCard } from "./event-card";
import { QuickEventInput } from "./quick-event-input";
import { formatSnapTime, getEventDayBounds, getPrimaryCalendarId, isTimedEventFullDayOnDate, layoutOverlappingEvents } from "@/lib/calendar-utils";
import { displayNow, isDisplayToday } from "@/lib/timezone";
import type { CalendarEvent, Calendar, CalendarTask } from "@/lib/jmap/types";
import { useTimeGridInteractions } from "@/hooks/use-time-grid-interactions";
import { useScrollWindow, getScrollStart, setScrollStart, scrollToStart } from "@/hooks/use-scroll-window";
import { dayKey, type ScrollWindowViewProps } from "@/lib/calendar-scroll-window";
import type { PendingEventPreview } from "./event-modal";

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

  const tasksByDay = useMemo(() => {
    const map = new Map<string, CalendarTask[]>();
    if (!tasks?.length) return map;
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

  // Column layouts are the costly part of a render; with months of columns
  // they must not be redone on every scroll-driven re-render.
  const layoutByDay = useMemo(() => {
    const map = new Map<string, ReturnType<typeof layoutOverlappingEvents>>();
    for (const day of days) {
      const key = format(day, "yyyy-MM-dd");
      map.set(key, layoutOverlappingEvents(eventsByDay.get(key)?.timed ?? [], day));
    }
    return map;
  }, [days, eventsByDay]);

  const hasAllDayArea = useMemo(
    () => days.some((day) => {
      const key = format(day, "yyyy-MM-dd");
      return (eventsByDay.get(key)?.allDay.length ?? 0) > 0 || (tasksByDay.get(key)?.length ?? 0) > 0;
    }),
    [days, eventsByDay, tasksByDay],
  );

  useEffect(() => {
    if (rootRef.current) {
      const now = displayNow();
      rootRef.current.scrollTop = Math.max(0, (now.getHours() - 1) * HOUR_HEIGHT);
    }
  }, []);

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
          <div className={gutterClass} />
          <div className="grid" style={columnsStyle}>
            {days.map((day) => {
              const key = format(day, "yyyy-MM-dd");
              const today = isDisplayToday(day);
              const allDayEvents = eventsByDay.get(key)?.allDay ?? [];
              const dayTasks = tasksByDay.get(key) ?? [];
              return (
                <div key={key} data-day={key} className="min-w-0 border-e border-border last:border-e-0">
                  <div className={cn("px-4 py-3", isMobile && "px-3 py-2")}>
                    <h3 className={cn("font-semibold truncate", isMobile ? "text-base" : "text-lg", today && "text-primary")}>
                      {isMobile
                        ? intlFormatter.dateTime(day, { weekday: "short", month: "short", day: "numeric" })
                        : intlFormatter.dateTime(day, { weekday: "long", month: "long", day: "numeric", year: "numeric" })
                      }
                    </h3>
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
                                  className="flex items-center gap-1.5 px-1.5 py-0.5 rounded text-xs cursor-pointer hover:bg-muted/50 transition-colors"
                                  style={{ borderLeft: `3px solid ${color}` }}
                                >
                                  <button
                                    onClick={(e) => { e.stopPropagation(); onToggleTaskComplete?.(task); }}
                                    className={cn(
                                      "flex-shrink-0 w-3.5 h-3.5 rounded-full border flex items-center justify-center",
                                      isCompleted
                                        ? "bg-success border-success text-success-foreground"
                                        : "border-muted-foreground/40 hover:border-primary"
                                    )}
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
          <div className="flex relative" style={{ height: 24 * HOUR_HEIGHT }}>
            <div className={gutterClass}>
              {HOURS.map((h) => (
                <div
                  key={h}
                  className="relative text-muted-foreground text-end pe-2"
                  style={{ height: HOUR_HEIGHT }}
                >
                  {h > 0 && (
                    <span className={cn("absolute top-0 right-2 -translate-y-1/2 leading-none", isMobile ? "text-[10px]" : "text-xs")}>
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
                const layouted = layoutByDay.get(key) ?? [];

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
                    {HOURS.map((h) => (
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

                    {layouted.map(({ event: ev, column, totalColumns, startMinutes, endMinutes }) => {
                      const durMin = Math.max(15, endMinutes - startMinutes);
                      const baseTop = (startMinutes / 60) * HOUR_HEIGHT;
                      const baseHeight = Math.max(24, (durMin / 60) * HOUR_HEIGHT);
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

                    {today && (
                      <div
                        className="absolute left-0 right-0 z-20 pointer-events-none"
                        style={{ top: (nowMinutes / 60) * HOUR_HEIGHT }}
                      >
                        <div className="flex items-center">
                          <div className="w-2.5 h-2.5 rounded-full bg-destructive -ms-1" />
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
                        const cal = calendars.find(c => c.id === pendingPreview.calendarId);
                        const color = cal?.color || "hsl(var(--primary))";
                        return (
                          <div
                            className="absolute left-2 right-2 z-10 rounded-md pointer-events-none border-2 border-dashed overflow-hidden"
                            style={{
                              top: (startMin / 60) * HOUR_HEIGHT,
                              height: Math.max(24, (durationMin / 60) * HOUR_HEIGHT),
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
