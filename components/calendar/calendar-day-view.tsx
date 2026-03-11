"use client";

import { useMemo, useEffect, useRef, useState } from "react";
import { useTranslations, useFormatter } from "next-intl";
import { format, isToday, parseISO } from "date-fns";
import { cn } from "@/lib/utils";
import { EventCard, parseDuration } from "./event-card";
import { QuickEventInput } from "./quick-event-input";
import { getEventEndDate, layoutOverlappingEvents, formatSnapTime } from "@/lib/calendar-utils";
import type { CalendarEvent, Calendar } from "@/lib/jmap/types";
import { useTimeGridInteractions } from "@/hooks/use-time-grid-interactions";

interface CalendarDayViewProps {
  selectedDate: Date;
  events: CalendarEvent[];
  calendars: Calendar[];
  onSelectEvent: (event: CalendarEvent, anchorRect: DOMRect) => void;
  onCreateAtTime: (date: Date, endDate?: Date) => void;
  timeFormat?: "12h" | "24h";
  isMobile?: boolean;
}

const HOUR_HEIGHT = 64;
const HOURS = Array.from({ length: 24 }, (_, i) => i);

export function CalendarDayView({
  selectedDate,
  events,
  calendars,
  onSelectEvent,
  onCreateAtTime,
  timeFormat = "24h",
  isMobile,
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
        const start = new Date(ev.start);
        const end = getEventEndDate(ev);
        const startDay = new Date(start); startDay.setHours(0, 0, 0, 0);
        const endDay = new Date(end); endDay.setHours(0, 0, 0, 0);
        const selDay = new Date(selectedDate); selDay.setHours(0, 0, 0, 0);

        const spansThisDay = startDay.getTime() <= selDay.getTime() && endDay.getTime() >= selDay.getTime();
        if (!spansThisDay) return;

        if (ev.showWithoutTime) allDay.push(ev);
        else timed.push(ev);
      } catch { /* skip invalid dates */ }
    });
    return { timedEvents: timed, allDayEvents: allDay };
  }, [events, selectedDate]);

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
  });

  const formatHour = (h: number): string => {
    if (timeFormat === "12h") {
      const d = new Date(2000, 0, 1, h);
      return intlFormatter.dateTime(d, { hour: "numeric", minute: "2-digit", hour12: true });
    }
    return format(new Date(2000, 0, 1, h), "HH:mm");
  };

  const layouted = useMemo(() => layoutOverlappingEvents(timedEvents), [timedEvents]);

  return (
    <div className="flex flex-col flex-1 overflow-hidden" role="grid" aria-label={intlFormatter.dateTime(selectedDate, { weekday: "long", month: "long", day: "numeric", year: "numeric" })}>
      <div className={cn("px-4 py-3 border-b border-border", isMobile && "px-3 py-2")}>
        <h3 className={cn("font-semibold", isMobile ? "text-base" : "text-lg", today && "text-primary")}>
          {isMobile
            ? intlFormatter.dateTime(selectedDate, { weekday: "short", month: "short", day: "numeric" })
            : intlFormatter.dateTime(selectedDate, { weekday: "long", month: "long", day: "numeric", year: "numeric" })
          }
        </h3>
      </div>

      {allDayEvents.length > 0 && (
        <div className="px-4 py-2 border-b border-border">
          <div className="text-[10px] text-muted-foreground mb-1">{t("events.all_day")}</div>
          <div className="space-y-1">
            {allDayEvents.map((ev) => {
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
        </div>
      )}

      <div ref={scrollRef} className="flex-1 overflow-y-auto">
        <div className="flex relative" style={{ height: 24 * HOUR_HEIGHT }}>
          <div className={cn("flex-shrink-0", isMobile ? "w-10" : "w-16")}>
            {HOURS.map((h) => (
              <div
                key={h}
                className="relative text-muted-foreground text-right pr-2"
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
            className="flex-1 relative border-l border-border"
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
                className="border-b border-border/50 hover:bg-muted/30 cursor-pointer transition-colors"
                style={{ height: HOUR_HEIGHT }}
              />
            ))}

            {layouted.map(({ event: ev, column, totalColumns }) => {
              const start = parseISO(ev.start);
              const startMin = start.getHours() * 60 + start.getMinutes();
              const durMin = Math.max(15, parseDuration(ev.duration));
              const top = (startMin / 60) * HOUR_HEIGHT;
              const baseHeight = Math.max(24, (durMin / 60) * HOUR_HEIGHT);
              const height = resizeVisual?.eventId === ev.id ? resizeVisual.heightPx : baseHeight;
              const calId = Object.keys(ev.calendarIds)[0];
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

            {today && (
              <div
                className="absolute left-0 right-0 z-20 pointer-events-none"
                style={{ top: (nowMinutes / 60) * HOUR_HEIGHT }}
              >
                <div className="flex items-center">
                  <div className="w-2.5 h-2.5 rounded-full bg-red-500 -ml-1" />
                  <div className="flex-1 h-px bg-red-500" />
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
                  <div className="w-2.5 h-2.5 rounded-full bg-primary -ml-1" />
                  <div className="flex-1 h-0.5 bg-primary rounded-full" />
                </div>
                <div className="absolute -top-4 left-2 text-[10px] font-medium text-primary bg-background/90 px-1 rounded shadow-sm">
                  {formatSnapTime(dropTarget.minutes, timeFormat)}
                </div>
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
