"use client";

import { useMemo, useState, useCallback, type DragEvent } from "react";
import { useTranslations, useFormatter } from "next-intl";
import {
  startOfMonth, endOfMonth, startOfWeek, endOfWeek,
  eachDayOfInterval, isSameDay, isSameMonth, isToday, format, parseISO,
} from "date-fns";
import { cn } from "@/lib/utils";
import { EventCard } from "./event-card";
import { buildWeekSegments, getEventDayBounds, getPrimaryCalendarId } from "@/lib/calendar-utils";
import type { CalendarEvent, Calendar } from "@/lib/jmap/types";
import { useAuthStore } from "@/stores/auth-store";
import { useCalendarStore } from "@/stores/calendar-store";
import type { PendingEventPreview } from "./event-modal";
import { toast } from "@/stores/toast-store";

interface CalendarMonthViewProps {
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

export function CalendarMonthView({
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
  isMobile,
  pendingPreview,
}: CalendarMonthViewProps) {
  const t = useTranslations("calendar");
  const intlFormatter = useFormatter();
  const weekStart = (firstDayOfWeek === 0 ? 0 : 1) as 0 | 1;

  const days = useMemo(() => {
    const monthStart = startOfMonth(selectedDate);
    const monthEnd = endOfMonth(selectedDate);
    const gridStart = startOfWeek(monthStart, { weekStartsOn: weekStart });
    const gridEnd = endOfWeek(monthEnd, { weekStartsOn: weekStart });
    return eachDayOfInterval({ start: gridStart, end: gridEnd });
  }, [selectedDate, weekStart]);

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

  const dayHeaders = firstDayOfWeek === 0
    ? ["sun", "mon", "tue", "wed", "thu", "fri", "sat"] as const
    : ["mon", "tue", "wed", "thu", "fri", "sat", "sun"] as const;

  const weeks = useMemo(() => {
    const result: Date[][] = [];
    for (let i = 0; i < days.length; i += 7) {
      result.push(days.slice(i, i + 7));
    }
    return result;
  }, [days]);

  const weekSegments = useMemo(() => {
    return weeks.map((week) => {
      const segments = buildWeekSegments(events, week);
      const rowCount = segments.reduce((maxRows, segment) => Math.max(maxRows, segment.row + 1), 0);
      return { week, segments, rowCount };
    });
  }, [events, weeks]);

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
    <div className="flex flex-col flex-1 overflow-hidden" role="grid" aria-label={intlFormatter.dateTime(selectedDate, { month: "long", year: "numeric" })}>
      <div className="grid grid-cols-7 border-b border-border" role="row">
        {dayHeaders.map((d) => (
          <div key={d} role="columnheader" className={cn(
            "text-center text-xs font-medium text-muted-foreground py-2 border-e border-border last:border-e-0",
            isMobile && "py-1.5 text-[11px]"
          )}>
            {isMobile ? t(`days.${d}`).slice(0, 2) : t(`days.${d}`)}
          </div>
        ))}
      </div>

      <div className="flex-1 flex flex-col overflow-y-auto">
        {weekSegments.map(({ week, segments, rowCount }, wi) => (
          <div key={wi} className={cn(
            "relative flex-1 border-b border-border last:border-b-0",
            isMobile ? "min-h-[52px]" : "min-h-[100px]"
          )} role="row" style={isMobile ? undefined : { minHeight: Math.max(100, 34 + rowCount * 22 + 8) }}>
            <div className="grid grid-cols-7 h-full">
            {week.map((day) => {
              const inMonth = isSameMonth(day, selectedDate);
              const selected = isSameDay(day, selectedDate);
              const today = isToday(day);
              const key = format(day, "yyyy-MM-dd");
              const dayEvents = eventsByDate.get(key) || [];
              const fullDateLabel = intlFormatter.dateTime(day, { weekday: "long", month: "long", day: "numeric", year: "numeric" });

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
                  <div className="flex items-center justify-center mb-0.5">
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
                      {format(day, "d")}
                    </span>
                  </div>
                  {isMobile ? (
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
                      {pendingPreview && isSameDay(pendingPreview.start, day) && (
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

            {!isMobile && pendingPreview && (() => {
              const previewDayIdx = week.findIndex(d => isSameDay(d, pendingPreview.start));
              if (previewDayIdx === -1) return null;
              const previewRow = rowCount;
              const cal = calendarMap.get(pendingPreview.calendarId);
              const color = cal?.color || "#3b82f6";
              return (
                <div className="absolute inset-x-0 pointer-events-none" style={{ top: 30 }}>
                  <div
                    className="absolute px-0.5"
                    style={{
                      left: `calc(${(previewDayIdx / 7) * 100}% + 1px)`,
                      width: `calc(${(1 / 7) * 100}% - 2px)`,
                      top: previewRow * 22,
                      height: 20,
                    }}
                  >
                    <div
                      className="h-full rounded text-[10px] leading-[20px] font-medium px-1.5 truncate border-2 border-dashed"
                      style={{ borderColor: color, color, backgroundColor: `${color}10` }}
                    >
                      {pendingPreview.title}
                    </div>
                  </div>
                </div>
              );
            })()}

            {!isMobile && segments.length > 0 && (
              <div className="absolute inset-x-0 pointer-events-none" style={{ top: 30 }}>
                {segments.map((segment) => {
                  const calId = getPrimaryCalendarId(segment.event);
                  return (
                    <div
                      key={`${segment.event.id}-${segment.startIndex}-${segment.row}`}
                      className="absolute px-0.5 pointer-events-auto"
                      style={{
                        left: `calc(${(segment.startIndex / 7) * 100}% + 1px)`,
                        width: `calc(${(segment.span / 7) * 100}% - 2px)`,
                        top: segment.row * 22,
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
                        draggable
                      />
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}
