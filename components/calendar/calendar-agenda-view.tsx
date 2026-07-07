"use client";

import { useMemo, useRef, useEffect, useCallback } from "react";
import { useTranslations, useFormatter } from "next-intl";
import { format, isToday, isTomorrow, startOfDay } from "date-fns";
import { MapPin, Users } from "lucide-react";
import { cn } from "@/lib/utils";
import { getEventColor } from "./event-card";
import { getEventDayBounds, getEventEndDate, getEventStartDate, getPrimaryCalendarId } from "@/lib/calendar-utils";
import { getParticipantCount } from "@/lib/calendar-participants";
import type { CalendarEvent, Calendar } from "@/lib/jmap/types";

interface CalendarAgendaViewProps {
  selectedDate: Date;
  events: CalendarEvent[];
  calendars: Calendar[];
  onSelectEvent: (event: CalendarEvent, anchorRect: DOMRect) => void;
  onHoverEvent?: (event: CalendarEvent, anchorRect: DOMRect) => void;
  onHoverLeave?: () => void;
  onContextMenuEvent?: (e: React.MouseEvent, event: CalendarEvent) => void;
  timeFormat?: "12h" | "24h";
}

interface DayGroup {
  date: Date;
  dateKey: string;
  events: CalendarEvent[];
}

export function CalendarAgendaView({
  selectedDate,
  events,
  calendars,
  onSelectEvent,
  onHoverEvent,
  onHoverLeave,
  onContextMenuEvent,
  timeFormat = "24h",
}: CalendarAgendaViewProps) {
  const t = useTranslations("calendar");
  const intlFormatter = useFormatter();

  const calendarMap = useMemo(() => {
    const map = new Map<string, Calendar>();
    calendars.forEach((c) => map.set(c.id, c));
    return map;
  }, [calendars]);

  const todayRef = useRef<HTMLDivElement>(null);
  const scrollContainerRef = useRef<HTMLDivElement>(null);

  const grouped = useMemo(() => {
    const sorted = [...events].sort((a, b) =>
      getEventStartDate(a).getTime() - getEventStartDate(b).getTime()
    );

    const groups: DayGroup[] = [];
    const groupMap = new Map<string, DayGroup>();

    sorted.forEach((ev) => {
      try {
        const { startDay, endDay } = getEventDayBounds(ev);
        const cursor = new Date(startDay);
        while (cursor <= endDay) {
          const key = format(cursor, "yyyy-MM-dd");
          let group = groupMap.get(key);
          if (!group) {
            group = { date: new Date(cursor), dateKey: key, events: [] };
            groupMap.set(key, group);
            groups.push(group);
          }
          group.events.push(ev);
          cursor.setDate(cursor.getDate() + 1);
        }
      } catch { /* skip invalid dates */ }
    });

    // Always include today's date in the groups so the view has a "Today" anchor
    const todayKey = format(new Date(), "yyyy-MM-dd");
    if (!groupMap.has(todayKey)) {
      const todayGroup = { date: startOfDay(new Date()), dateKey: todayKey, events: [] as CalendarEvent[] };
      groupMap.set(todayKey, todayGroup);
      groups.push(todayGroup);
    }

    groups.sort((a, b) => a.date.getTime() - b.date.getTime());
    return groups;
  }, [events]);

  // Auto-scroll to today's section on mount and when selectedDate changes to today
  const scrollToToday = useCallback(() => {
    if (todayRef.current) {
      todayRef.current.scrollIntoView({ block: "start" });
    }
  }, []);

  useEffect(() => {
    // Scroll to today on mount
    const frame = requestAnimationFrame(scrollToToday);
    return () => cancelAnimationFrame(frame);
  }, [scrollToToday]);

  useEffect(() => {
    // Scroll to today when selectedDate changes to today
    if (isToday(selectedDate)) {
      scrollToToday();
    }
  }, [selectedDate, scrollToToday]);

  const formatDateHeader = (date: Date): string => {
    if (isToday(date)) return t("events.today_header");
    if (isTomorrow(date)) return t("events.tomorrow_header");
    return intlFormatter.dateTime(date, { weekday: "long", month: "long", day: "numeric" });
  };

  const formatTime = (date: Date): string => {
    if (timeFormat === "12h") {
      return intlFormatter.dateTime(date, { hour: "numeric", minute: "2-digit", hour12: true });
    }
    return format(date, "HH:mm");
  };

  return (
    <div className="flex-1 overflow-y-auto" ref={scrollContainerRef}>
      {grouped.map((group) => (
        <div key={group.dateKey} ref={isToday(group.date) ? todayRef : undefined}>
          <div className="sticky top-0 bg-muted/80 backdrop-blur-sm px-4 py-2 border-b border-border">
            <span className={cn(
              "text-sm font-medium",
              isToday(group.date) && "text-primary"
            )}>
              {formatDateHeader(group.date)}
            </span>
            <span className="text-xs text-muted-foreground ms-2">
              {intlFormatter.dateTime(group.date, { month: "short", day: "numeric", year: "numeric" })}
            </span>
          </div>

          {group.events.length === 0 ? (
            <div className="px-4 py-6 text-center text-sm text-muted-foreground">
              {t("events.no_events")}
            </div>
          ) : (
          <div className="divide-y divide-border">
            {group.events.map((ev) => {
              const calId = getPrimaryCalendarId(ev);
              const calendar = calId ? calendarMap.get(calId) : undefined;
              const color = getEventColor(ev, calendar);
              const start = getEventStartDate(ev);
              const end = getEventEndDate(ev);
              // iTIP CANCEL marks the attendee's copy with status "cancelled"
              // instead of deleting it (#572).
              const isCancelled = ev.status === "cancelled";
              const locationName = ev.locations
                ? Object.values(ev.locations)[0]?.name
                : null;

              return (
                <button
                  key={ev.id}
                  onClick={(e) => onSelectEvent(ev, e.currentTarget.getBoundingClientRect())}
                  onMouseEnter={(e) => onHoverEvent?.(ev, e.currentTarget.getBoundingClientRect())}
                  onMouseLeave={() => onHoverLeave?.()}
                  onContextMenu={onContextMenuEvent ? (e) => onContextMenuEvent(e, ev) : undefined}
                  className={cn(
                    "w-full flex items-start px-4 hover:bg-muted/50 transition-colors text-start",
                    isCancelled && "opacity-60"
                  )}
                  style={{ gap: 'var(--density-item-gap)', paddingBlock: 'var(--density-item-py)' }}
                >
                  <div className="flex flex-col items-center pt-0.5 min-w-[60px]">
                    {ev.showWithoutTime ? (
                      <span className="text-xs font-medium text-muted-foreground">
                        {t("events.all_day")}
                      </span>
                    ) : (
                      <>
                        <span className="text-sm font-medium">{formatTime(start)}</span>
                        <span className="text-xs text-muted-foreground">{formatTime(end)}</span>
                      </>
                    )}
                  </div>

                  <div
                    className="w-1 self-stretch rounded-full flex-shrink-0"
                    style={{ backgroundColor: color }}
                  />

                  <div className="flex-1 min-w-0">
                    <div className={cn("text-sm font-medium truncate", isCancelled && "line-through")}>
                      {ev.title || t("events.no_title")}
                    </div>
                    {locationName && (
                      <div className="flex items-center gap-1 text-xs text-muted-foreground mt-0.5">
                        <MapPin className="w-3 h-3 flex-shrink-0" />
                        <span className="truncate">{locationName}</span>
                      </div>
                    )}
                    {getParticipantCount(ev) > 0 && (
                      <div className="flex items-center gap-1 text-xs text-muted-foreground mt-0.5">
                        <Users className="w-3 h-3 flex-shrink-0" />
                        <span>{getParticipantCount(ev)}</span>
                      </div>
                    )}
                    {calendar && (
                      <div className="text-xs text-muted-foreground mt-0.5">
                        {calendar.name}
                      </div>
                    )}
                  </div>
                </button>
              );
            })}
          </div>
          )}
        </div>
      ))}
    </div>
  );
}
