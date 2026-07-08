"use client";

import { useMemo, useEffect, useRef, useState } from "react";
import { useTranslations, useFormatter } from "next-intl";
import { format, isSameDay, isToday, parseISO } from "date-fns";
import { cn } from "@/lib/utils";
import { Check } from "lucide-react";
import { EventCard } from "./event-card";
import { QuickEventInput } from "./quick-event-input";
import { formatSnapTime, getEventDayBounds, getPrimaryCalendarId, isTimedEventFullDayOnDate, layoutOverlappingEvents } from "@/lib/calendar-utils";
import type { CalendarEvent, Calendar, CalendarTask } from "@/lib/jmap/types";
import { useTimeGridInteractions } from "@/hooks/use-time-grid-interactions";
import type { PendingEventPreview } from "./event-modal";

interface CalendarDayViewProps {
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

export function CalendarDayView({
  selectedDate,
  events,
  calendars,
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
  const intlFormatter = useFormatter();
  const scrollRef = useRef<HTMLDivElement>(null);
  const dayKey = format(selectedDate, "yyyy-MM-dd");

  const calendarMap = useMemo(() => {
    const map = new Map<string, Calendar>();
    calendars.forEach((c) => map.set(c.id, c));
    return map;
  }, [calendars]);

  const { timedEvents, allDayEvents } = useMemo(() => {
    const timed: CalendarEvent[] = [];
    const allDay: CalendarEvent[] = [];
    events.forEach((ev) => {
      try {
        const { startDay, endDay } = getEventDayBounds(ev);
        const selDay = new Date(selectedDate); selDay.setHours(0, 0, 0, 0);

        const spansThisDay = startDay.getTime() <= selDay.getTime() && endDay.getTime() >= selDay.getTime();
        if (!spansThisDay) return;

        if (ev.showWithoutTime || isTimedEventFullDayOnDate(ev, selectedDate)) allDay.push(ev);
        else timed.push(ev);
      } catch { /* skip invalid dates */ }
    });
    return { timedEvents: timed, allDayEvents: allDay };
  }, [events, selectedDate]);

  const dayTasks = useMemo(() => {
    if (!tasks?.length) return [];
    return tasks.filter(task => {
      if (!task.due) return false;
      try {
        return isSameDay(parseISO(task.due), selectedDate);
      } catch { return false; }
    });
  }, [tasks, selectedDate]);

  useEffect(() => {
    if (scrollRef.current) {
      const now = new Date();
      scrollRef.current.scrollTop = Math.max(0, (now.getHours() - 1) * HOUR_HEIGHT);
    }
  }, []);

  const today = isToday(selectedDate);
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

  const layouted = useMemo(() => layoutOverlappingEvents(timedEvents, selectedDate), [timedEvents, selectedDate]);

  return (
    <div className="flex min-h-0 flex-col flex-1 overflow-hidden" role="grid" aria-label={intlFormatter.dateTime(selectedDate, { weekday: "long", month: "long", day: "numeric", year: "numeric" })}>
      <div className={cn("px-4 py-3 border-b border-border", isMobile && "px-3 py-2")}>
        <h3 className={cn("font-semibold", isMobile ? "text-base" : "text-lg", today && "text-primary")}>
          {isMobile
            ? intlFormatter.dateTime(selectedDate, { weekday: "short", month: "short", day: "numeric" })
            : intlFormatter.dateTime(selectedDate, { weekday: "long", month: "long", day: "numeric", year: "numeric" })
          }
        </h3>
      </div>

      {(allDayEvents.length > 0 || dayTasks.length > 0) && (
        <div
          className="px-4 py-2 border-b border-border"
          onContextMenu={onContextMenuEmpty ? (e) => {
            if ((e.target as HTMLElement).closest("[data-calendar-event],button")) return;
            onContextMenuEmpty(e, selectedDate, undefined, true);
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

      <div ref={scrollRef} className="min-h-0 flex-1 overflow-y-auto">
        <div className="flex relative" style={{ height: 24 * HOUR_HEIGHT }}>
          <div className={cn("flex-shrink-0", isMobile ? "w-10" : "w-16")}>
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

          <div
            className="flex-1 relative border-s border-border"
            role="row"
            aria-label={t("views.day")}
            onPointerDown={(e) => handleGridPointerDown(e, dayKey, selectedDate)}
            onPointerMove={handleGridPointerMove}
            onPointerUp={handleGridPointerUp}
            onDragOver={(e) => handleColumnDragOver(e, dayKey)}
            onDragLeave={handleColumnDragLeave}
            onDrop={(e) => handleColumnDrop(e, selectedDate)}
          >
            {HOURS.map((h) => (
              <div
                key={h}
                role="gridcell"
                aria-label={formatHour(h)}
                onClick={() => handleSlotClick(selectedDate, h)}
                onDoubleClick={() => handleSlotDoubleClick(selectedDate, h)}
                onContextMenu={onContextMenuEmpty ? (e) => onContextMenuEmpty(e, selectedDate, h, false) : undefined}
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

            {quickCreate?.dayKey === dayKey && (
              <QuickEventInput
                top={quickCreate.top}
                onSubmit={handleQuickCreateSubmit}
                onCancel={handleQuickCreateCancel}
              />
            )}

            {dragCreate && (
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

            {dropTarget?.dayKey === dayKey && (
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

            {pendingPreview && !pendingPreview.allDay && isSameDay(pendingPreview.start, selectedDate) && (
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
        </div>
      </div>
    </div>
  );
}
