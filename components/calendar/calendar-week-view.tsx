"use client";

import { useMemo, useEffect, useRef, useState } from "react";
import { useTranslations, useFormatter } from "next-intl";
import {
  startOfWeek, addDays, format, isSameDay, isToday, parseISO,
} from "date-fns";
import { cn } from "@/lib/utils";
import { EventCard, parseDuration } from "./event-card";
import { QuickEventInput } from "./quick-event-input";
import { getEventEndDate, layoutOverlappingEvents, formatSnapTime } from "@/lib/calendar-utils";
import type { CalendarEvent, Calendar } from "@/lib/jmap/types";
import { useTimeGridInteractions } from "@/hooks/use-time-grid-interactions";

interface CalendarWeekViewProps {
  selectedDate: Date;
  events: CalendarEvent[];
  calendars: Calendar[];
  onSelectDate: (date: Date) => void;
  onSelectEvent: (event: CalendarEvent, anchorRect: DOMRect) => void;
  onCreateAtTime: (date: Date, endDate?: Date) => void;
  firstDayOfWeek?: number;
  timeFormat?: "12h" | "24h";
  isMobile?: boolean;
}

const HOUR_HEIGHT = 60;
const HOURS = Array.from({ length: 24 }, (_, i) => i);

export function CalendarWeekView({
  selectedDate,
  events,
  calendars,
  onSelectDate,
  onSelectEvent,
  onCreateAtTime,
  firstDayOfWeek = 1,
  timeFormat = "24h",
  isMobile,
}: CalendarWeekViewProps) {
  const t = useTranslations("calendar");
  const intlFormatter = useFormatter();
  const scrollRef = useRef<HTMLDivElement>(null);
  const weekStart = (firstDayOfWeek === 0 ? 0 : 1) as 0 | 1;

  const weekDays = useMemo(() => {
    if (isMobile) {
      // Show 3-day window centered on selected date
      return Array.from({ length: 3 }, (_, i) => addDays(selectedDate, i - 1));
    }
    const start = startOfWeek(selectedDate, { weekStartsOn: weekStart });
    return Array.from({ length: 7 }, (_, i) => addDays(start, i));
  }, [selectedDate, weekStart, isMobile]);

  const calendarMap = useMemo(() => {
    const map = new Map<string, Calendar>();
    calendars.forEach((c) => map.set(c.id, c));
    return map;
  }, [calendars]);

  const { timedEvents, allDayEvents } = useMemo(() => {
    const timed: Map<string, CalendarEvent[]> = new Map();
    const allDay: Map<string, CalendarEvent[]> = new Map();

    events.forEach((ev) => {
      try {
        const start = new Date(ev.start);
        const end = getEventEndDate(ev);
        const startDay = new Date(start); startDay.setHours(0, 0, 0, 0);
        const endDay = new Date(end); endDay.setHours(0, 0, 0, 0);

        const cursor = new Date(startDay);
        while (cursor <= endDay) {
          const key = format(cursor, "yyyy-MM-dd");
          if (ev.showWithoutTime) {
            const arr = allDay.get(key) || [];
            arr.push(ev);
            allDay.set(key, arr);
          } else {
            const arr = timed.get(key) || [];
            arr.push(ev);
            timed.set(key, arr);
          }
          cursor.setDate(cursor.getDate() + 1);
        }
      } catch { /* skip invalid dates */ }
    });
    return { timedEvents: timed, allDayEvents: allDay };
  }, [events]);

  const hasAllDay = useMemo(() => {
    return weekDays.some(day => {
      const key = format(day, "yyyy-MM-dd");
      return (allDayEvents.get(key) || []).length > 0;
    });
  }, [weekDays, allDayEvents]);

  useEffect(() => {
    if (scrollRef.current) {
      const now = new Date();
      scrollRef.current.scrollTop = Math.max(0, (now.getHours() - 1) * HOUR_HEIGHT);
    }
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
  });

  const formatHour = (h: number): string => {
    if (timeFormat === "12h") {
      const d = new Date(2000, 0, 1, h);
      return intlFormatter.dateTime(d, { hour: "numeric", minute: "2-digit", hour12: true });
    }
    return format(new Date(2000, 0, 1, h), "HH:mm");
  };

  const colCount = isMobile ? 3 : 7;

  return (
    <div className="flex flex-col flex-1 overflow-hidden" role="grid" aria-label={t("views.week")}>
      {hasAllDay && (
        <div className="flex border-b border-border">
          <div className={cn("flex-shrink-0 text-[10px] text-muted-foreground p-1 text-right", isMobile ? "w-10" : "w-14")}>
            {t("events.all_day")}
          </div>
          <div className={cn("flex-1 grid gap-px bg-border", isMobile ? "grid-cols-3" : "grid-cols-7")}>
            {weekDays.map((day) => {
              const key = format(day, "yyyy-MM-dd");
              const dayAllDay = allDayEvents.get(key) || [];
              return (
                <div key={key} className="bg-background p-0.5 min-h-[28px]">
                  {dayAllDay.map((ev) => {
                    const calId = Object.keys(ev.calendarIds)[0];
                    return (
                      <EventCard
                        key={ev.id}
                        event={ev}
                        calendar={calendarMap.get(calId)}
                        variant="chip"
                        onClick={(rect) => onSelectEvent(ev, rect)}
                      />
                    );
                  })}
                </div>
              );
            })}
          </div>
        </div>
      )}

      <div className="flex border-b border-border" role="row">
        <div className={cn("flex-shrink-0", isMobile ? "w-10" : "w-14")} />
        <div className={cn("flex-1 border-l border-border", isMobile ? "grid grid-cols-3" : "grid grid-cols-7")}>
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
                  "text-center py-2 text-sm border-r border-border last:border-r-0 transition-colors touch-manipulation",
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

      <div ref={scrollRef} className="flex-1 overflow-y-auto">
        <div className="flex relative" style={{ height: 24 * HOUR_HEIGHT }}>
          <div className={cn("flex-shrink-0", isMobile ? "w-10" : "w-14")}>
            {HOURS.map((h) => (
              <div
                key={h}
                className="relative text-muted-foreground text-right pr-2"
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

          <div className={cn("flex-1 border-l border-border relative", isMobile ? "grid grid-cols-3" : "grid grid-cols-7")}>
            {weekDays.map((day) => {
              const key = format(day, "yyyy-MM-dd");
              const dayEvents = timedEvents.get(key) || [];
              const todayCol = isToday(day);
              const layouted = layoutOverlappingEvents(dayEvents);

              return (
                <div
                  key={key}
                  className="relative border-r border-border last:border-r-0"
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
                      className="border-b border-border/50 hover:bg-muted/30 cursor-pointer transition-colors"
                      style={{ height: HOUR_HEIGHT }}
                    />
                  ))}

                  {layouted.map(({ event: ev, column, totalColumns }) => {
                    const start = parseISO(ev.start);
                    const startMin = start.getHours() * 60 + start.getMinutes();
                    const durMin = Math.max(15, parseDuration(ev.duration));
                    const top = (startMin / 60) * HOUR_HEIGHT;
                    const baseHeight = Math.max(20, (durMin / 60) * HOUR_HEIGHT);
                    const height = resizeVisual?.eventId === ev.id ? resizeVisual.heightPx : baseHeight;
                    const calId = Object.keys(ev.calendarIds)[0];
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
                          calendar={calendarMap.get(calId)}
                          variant="block"
                          onClick={(rect) => onSelectEvent(ev, rect)}
                          draggable
                        />
                        <div
                          data-resize-handle
                          className="absolute bottom-0 left-1 right-1 h-3 cursor-s-resize z-20 flex items-end justify-center opacity-0 group-hover/event:opacity-100 transition-opacity"
                          aria-label={t("events.resize")}
                          onPointerDown={(e) => handleResizePointerDown(ev.id, durMin, e)}
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
                        <div className="w-2 h-2 rounded-full bg-red-500 -ml-1" />
                        <div className="flex-1 h-px bg-red-500" />
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
                        <div className="w-2 h-2 rounded-full bg-primary -ml-1" />
                        <div className="flex-1 h-0.5 bg-primary rounded-full" />
                      </div>
                      <div className="absolute -top-4 left-2 text-[10px] font-medium text-primary bg-background/90 px-1 rounded shadow-sm">
                        {formatSnapTime(dropTarget.minutes, timeFormat)}
                      </div>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </div>
      </div>
    </div>
  );
}
