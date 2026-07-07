"use client";

import { useMemo, useEffect, useRef, useState } from "react";
import { useTranslations, useFormatter } from "next-intl";
import {
  startOfWeek, addDays, format, isSameDay, isToday, parseISO,
} from "date-fns";
import { cn } from "@/lib/utils";
import { Check } from "lucide-react";
import { EventCard } from "./event-card";
import { QuickEventInput } from "./quick-event-input";
import { buildTimedFullDayWeekSegments, buildWeekSegmentsRaw, formatSnapTime, getEventDayBounds, getPrimaryCalendarId, isTimedEventFullDayOnDate, layoutOverlappingEvents, packWeekSegments } from "@/lib/calendar-utils";
import type { CalendarEvent, Calendar, CalendarTask } from "@/lib/jmap/types";
import { useTimeGridInteractions } from "@/hooks/use-time-grid-interactions";
import type { PendingEventPreview } from "./event-modal";

interface CalendarWeekViewProps {
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

export function CalendarWeekView({
  selectedDate,
  events,
  calendars,
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
  const intlFormatter = useFormatter();
  const scrollRef = useRef<HTMLDivElement>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const weekStart = (firstDayOfWeek === 0 ? 0 : 1) as 0 | 1;

  const weekDays = useMemo(() => {
    const start = startOfWeek(selectedDate, { weekStartsOn: weekStart });
    return Array.from({ length: 7 }, (_, i) => addDays(start, i));
  }, [selectedDate, weekStart]);

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

  const allDaySegments = useMemo(() => {
    const explicitAllDay = buildWeekSegmentsRaw(
      events.filter((event) => event.showWithoutTime),
      weekDays,
    );
    const timedFullDay = buildTimedFullDayWeekSegments(
      events.filter((event) => !event.showWithoutTime),
      weekDays,
    );

    return packWeekSegments([...explicitAllDay, ...timedFullDay]);
  }, [events, weekDays]);

  const allDayRowCount = useMemo(() => {
    return allDaySegments.reduce((maxRows, segment) => Math.max(maxRows, segment.row + 1), 0);
  }, [allDaySegments]);

  // Tasks grouped by day for the week
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

  // Max tasks on any single day in this week
  const taskRowCount = useMemo(() => {
    let max = 0;
    for (const day of weekDays) {
      const key = format(day, "yyyy-MM-dd");
      const count = tasksByDay.get(key)?.length ?? 0;
      if (count > max) max = count;
    }
    return max;
  }, [tasksByDay, weekDays]);

  const hasAllDay = useMemo(() => {
    return allDaySegments.length > 0 || taskRowCount > 0;
  }, [allDaySegments, taskRowCount]);

  useEffect(() => {
    if (scrollRef.current) {
      const now = new Date();
      scrollRef.current.scrollTop = Math.max(0, (now.getHours() - 1) * HOUR_HEIGHT);
    }
    // On mobile, scroll horizontally to center today's column
    if (isMobile && rootRef.current) {
      const todayIdx = weekDays.findIndex(d => isToday(d));
      if (todayIdx >= 0) {
        const gutter = 40;
        const colWidth = (rootRef.current.scrollWidth - gutter) / 7;
        const target = gutter + todayIdx * colWidth - rootRef.current.clientWidth / 2 + colWidth / 2;
        rootRef.current.scrollLeft = Math.max(0, target);
      }
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const [nowMinutes, setNowMinutes] = useState(() => {
    const now = new Date();
    return now.getHours() * 60 + now.getMinutes();
  });
  useEffect(() => {
    const interval = setInterval(() => {
      setNowMinutes(new Date().getHours() * 60 + new Date().getMinutes());
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

  const colCount = 7;

  return (
    <div
      ref={rootRef}
      className={cn(
        "flex min-h-0 min-w-0 flex-col flex-1",
        isMobile ? "overflow-x-auto overflow-y-hidden" : "overflow-hidden"
      )}
      role="grid"
      aria-label={t("views.week")}
    >
      <div className={cn("flex min-h-0 flex-col flex-1", isMobile && "min-w-[880px]")}>      {hasAllDay && (
        <div className="flex border-b border-border">
          <div
            className={cn("flex-shrink-0 text-[10px] text-muted-foreground p-1 text-end", isMobile ? "w-10 sticky left-0 z-10 bg-background" : "w-14")}
            style={{ minHeight: Math.max(28, (allDayRowCount + taskRowCount) * 24 + 4) }}
          >
            {t("events.all_day")}
          </div>
          <div
            className="flex-1 relative grid gap-px bg-border grid-cols-7"
            style={{ minHeight: Math.max(28, (allDayRowCount + taskRowCount) * 24 + 4) }}
          >
            {weekDays.map((day) => (
              <div
                key={format(day, "yyyy-MM-dd")}
                className="bg-background min-h-[28px]"
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
                {weekDays.map((day, dayIndex) => {
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
        <div className={cn("flex-shrink-0", isMobile ? "w-10 sticky left-0 z-10 bg-background" : "w-14")} />
        <div className="flex-1 border-s border-border grid grid-cols-7">
          {weekDays.map((day) => {
            const todayCol = isToday(day);
            const selected = isSameDay(day, selectedDate);
            const fullLabel = intlFormatter.dateTime(day, { weekday: "long", month: "long", day: "numeric", year: "numeric" });
            return (
              <button
                key={day.toISOString()}
                onClick={() => onSelectDate(day)}
                role="columnheader"
                aria-label={fullLabel}
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

      <div ref={scrollRef} className="min-h-0 flex-1 overflow-y-auto">
        <div className="flex relative" style={{ height: 24 * HOUR_HEIGHT }}>
          <div className={cn("flex-shrink-0", isMobile ? "w-10 sticky left-0 z-10 bg-background" : "w-14")}>
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

          <div className="flex-1 border-s border-border relative grid grid-cols-7">
            {weekDays.map((day) => {
              const key = format(day, "yyyy-MM-dd");
              const dayEvents = timedEvents.get(key) || [];
              const todayCol = isToday(day);
              const layouted = layoutOverlappingEvents(dayEvents, day);

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
