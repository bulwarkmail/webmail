"use client";

import { useMemo, useRef, useCallback } from "react";
import { useTranslations } from "next-intl";
import { useDisplayDateFormatter } from "@/hooks/use-display-date-formatter";
import { format, isTomorrow, startOfDay } from "date-fns";
import { MapPin, Users } from "lucide-react";
import { cn } from "@/lib/utils";
import { getEventColor } from "./event-card";
import { getEventDayBounds, getEventEndDate, getEventStartDate, getPrimaryCalendarId } from "@/lib/calendar-utils";
import { displayNow, isDisplayToday } from "@/lib/timezone";
import { getParticipantCount } from "@/lib/calendar-participants";
import { useScrollWindow } from "@/hooks/use-scroll-window";
import type { ScrollWindowViewProps } from "@/lib/calendar-scroll-window";
import type { CalendarEvent, Calendar } from "@/lib/jmap/types";

interface CalendarAgendaViewProps extends ScrollWindowViewProps {
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
  focus,
  events,
  calendars,
  rangeStart,
  rangeEnd,
  windowKey,
  onExtendStart,
  onExtendEnd,
  isLoading = false,
  onSelectEvent,
  onHoverEvent,
  onHoverLeave,
  onContextMenuEvent,
  timeFormat = "24h",
}: CalendarAgendaViewProps) {
  const t = useTranslations("calendar");
  // Grid days / event dates are display dates (local fields = wall-clock in
  // the user's zone); the app-wide formatter would shift them again (#755).
  const intlFormatter = useDisplayDateFormatter();

  const calendarMap = useMemo(() => {
    const map = new Map<string, Calendar>();
    calendars.forEach((c) => map.set(c.id, c));
    return map;
  }, [calendars]);

  const scrollContainerRef = useRef<HTMLDivElement>(null);
  const bottomSentinelRef = useRef<HTMLDivElement>(null);

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

    // Keep a "Today" row as an anchor, but only when today is actually part
    // of the loaded window - otherwise it would claim there is nothing on a
    // day that was never fetched.
    const today = startOfDay(displayNow());
    const todayKey = format(today, "yyyy-MM-dd");
    if (!groupMap.has(todayKey) && today >= startOfDay(rangeStart) && today <= rangeEnd) {
      const todayGroup = { date: today, dateKey: todayKey, events: [] as CalendarEvent[] };
      groupMap.set(todayKey, todayGroup);
      groups.push(todayGroup);
    }

    groups.sort((a, b) => a.date.getTime() - b.date.getTime());
    return groups;
  }, [events, rangeStart, rangeEnd]);

  // The focus row is the first day at or after the focused day: where the
  // list starts out, and where "Today" brings the user back to.
  const focusKey = format(focus.date, "yyyy-MM-dd");
  const focusIndex = grouped.findIndex((group) => group.dateKey >= focusKey);
  const focusRowRef = useRef<HTMLDivElement>(null);
  const scrollToFocus = useCallback(() => {
    const el = scrollContainerRef.current;
    const target = focusRowRef.current;
    if (!el) return;
    el.scrollTop = target
      ? el.scrollTop + target.getBoundingClientRect().top - el.getBoundingClientRect().top
      : 0;
  }, []);

  const { requestStart, pendingSide } = useScrollWindow({
    scrollRef: scrollContainerRef,
    axis: "vertical",
    isLoading,
    windowKey,
    focusNonce: focus.nonce,
    scrollToFocus,
    onExtendStart,
    onExtendEnd,
    endSentinelRef: bottomSentinelRef,
    contentKey: grouped,
    anchorSelector: "[data-agenda-day]",
  });

  // Wheeling up while already at the top reaches for earlier days. Touch
  // users (and anyone whose list is too short to scroll) have the button.
  const handleWheel = useCallback((e: React.WheelEvent<HTMLDivElement>) => {
    if (e.deltaY < 0 && e.currentTarget.scrollTop <= 0) requestStart();
  }, [requestStart]);

  const formatDateHeader = (date: Date): string => {
    if (isDisplayToday(date)) return t("events.today_header");
    if (isTomorrow(date)) return t("events.tomorrow_header");
    return intlFormatter.dateTime(date, { weekday: "long", month: "long", day: "numeric" });
  };

  const formatTime = (date: Date): string => {
    if (timeFormat === "12h") {
      return intlFormatter.dateTime(date, { hour: "numeric", minute: "2-digit", hour12: true });
    }
    return format(date, "HH:mm");
  };

  const formatRangeDate = (date: Date): string =>
    intlFormatter.dateTime(date, { month: "short", day: "numeric", year: "numeric" });

  const loadingPast = isLoading && pendingSide === "start";

  return (
    <div
      className="flex-1 overflow-y-auto [overflow-anchor:none]"
      ref={scrollContainerRef}
      onWheel={handleWheel}
    >
      <div className="px-4 py-2 text-center text-xs text-muted-foreground">
        {onExtendStart ? (
          <button
            type="button"
            onClick={requestStart}
            disabled={isLoading}
            className="rounded-md px-2 py-1 hover:bg-muted hover:text-foreground disabled:opacity-60"
          >
            {loadingPast ? t("events.agenda_loading") : t("events.agenda_show_earlier")}
          </button>
        ) : (
          <span>{t("events.agenda_range_start", { date: formatRangeDate(rangeStart) })}</span>
        )}
      </div>

      {grouped.length === 0 && !isLoading && (
        <div className="px-4 py-6 text-center text-sm text-muted-foreground">
          {t("events.no_events")}
        </div>
      )}

      {grouped.map((group, index) => (
        <div key={group.dateKey} ref={index === focusIndex ? focusRowRef : undefined} data-agenda-day={group.dateKey}>
          <div className="sticky top-0 bg-muted/80 backdrop-blur-sm px-4 py-2 border-b border-border">
            <span className={cn(
              "text-sm font-medium",
              isDisplayToday(group.date) && "text-primary"
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

      <div
        ref={bottomSentinelRef}
        data-testid="agenda-bottom-sentinel"
        className="px-4 py-3 text-center text-xs text-muted-foreground"
      >
        {onExtendEnd
          ? (isLoading && pendingSide === "end" ? t("events.agenda_loading") : " ")
          : t("events.agenda_range_end", { date: formatRangeDate(rangeEnd) })}
      </div>
    </div>
  );
}
