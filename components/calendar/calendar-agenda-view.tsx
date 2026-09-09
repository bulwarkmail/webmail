"use client";

import { useMemo, useRef, useEffect, useLayoutEffect, useCallback } from "react";
import { useTranslations } from "next-intl";
import { useDisplayDateFormatter } from "@/hooks/use-display-date-formatter";
import { format, isTomorrow, startOfDay } from "date-fns";
import { MapPin, Users } from "lucide-react";
import { cn } from "@/lib/utils";
import { getEventColor } from "./event-card";
import { getEventDayBounds, getEventEndDate, getEventStartDate, getPrimaryCalendarId } from "@/lib/calendar-utils";
import { displayNow, isDisplayToday } from "@/lib/timezone";
import { getParticipantCount } from "@/lib/calendar-participants";
import type { CalendarEvent, Calendar } from "@/lib/jmap/types";

interface CalendarAgendaViewProps {
  /** Anchor day: the list starts here and scrolls back to the top when it changes. */
  selectedDate: Date;
  events: CalendarEvent[];
  calendars: Calendar[];
  /** Loaded window. "Today" only gets an (empty) anchor row when it lies inside. */
  rangeStart: Date;
  rangeEnd: Date;
  /** Widen the window into the past; omit when the past limit is reached. */
  onExtendPast?: () => void;
  /** Widen the window into the future; omit when the future limit is reached. */
  onExtendFuture?: () => void;
  isLoading?: boolean;
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
  rangeStart,
  rangeEnd,
  onExtendPast,
  onExtendFuture,
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
  // One outstanding extension at a time. For the past it also remembers the
  // scroll height, so rows prepended by the wider fetch don't shove the
  // visible ones down. Cleared when the fetch it triggered has finished.
  const pendingRef = useRef<{ side: "past" | "future"; scrollHeight: number } | null>(null);
  const wasLoadingRef = useRef(isLoading);

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

  // The anchor row is the first day at or after the selected day. It is where
  // the list starts out, and where "Today" brings the user back to.
  const anchorKey = format(selectedDate, "yyyy-MM-dd");
  const anchorIndex = grouped.findIndex((group) => group.dateKey >= anchorKey);
  const anchorRef = useRef<HTMLDivElement>(null);
  // Whether the fetch for the current anchor's window has completed. Until
  // then the rows belong to whatever was on screen before, so the bottom
  // sentinel must not grow the window off them.
  const loadedForAnchorRef = useRef(false);
  const scrollToAnchor = useCallback(() => {
    const el = scrollContainerRef.current;
    const target = anchorRef.current;
    if (!el) return;
    el.scrollTop = target
      ? el.scrollTop + target.getBoundingClientRect().top - el.getBoundingClientRect().top
      : 0;
  }, []);

  useLayoutEffect(() => {
    loadedForAnchorRef.current = false;
  }, [anchorKey]);

  // A new selected date (a fresh window, or "Today" pressed again): show the
  // anchor day. For a fresh window this happens again once its rows arrive.
  useLayoutEffect(() => {
    pendingRef.current = null;
    scrollToAnchor();
  }, [selectedDate, scrollToAnchor]);

  const requestPast = useCallback(() => {
    if (!onExtendPast || isLoading || pendingRef.current) return;
    pendingRef.current = { side: "past", scrollHeight: scrollContainerRef.current?.scrollHeight ?? 0 };
    onExtendPast();
  }, [onExtendPast, isLoading]);

  const requestFuture = useCallback(() => {
    if (!onExtendFuture || isLoading || pendingRef.current) return;
    pendingRef.current = { side: "future", scrollHeight: 0 };
    onExtendFuture();
  }, [onExtendFuture, isLoading]);

  // Wheeling up while already at the top reaches for earlier days. Touch
  // users (and anyone whose list is too short to scroll) have the button.
  const handleWheel = useCallback((e: React.WheelEvent<HTMLDivElement>) => {
    if (e.deltaY < 0 && e.currentTarget.scrollTop <= 0) requestPast();
  }, [requestPast]);

  // The fetch an extension triggered has finished (data and the loading flag
  // land in the same render). Rows prepended for the past would shove what
  // the user was looking at downwards: put it back. Browser scroll anchoring
  // is disabled on the container so the correction is not applied twice.
  useLayoutEffect(() => {
    const finished = wasLoadingRef.current && !isLoading;
    wasLoadingRef.current = isLoading;
    if (!finished) return;
    const pending = pendingRef.current;
    pendingRef.current = null;
    if (!loadedForAnchorRef.current) {
      loadedForAnchorRef.current = true;
      scrollToAnchor();
      return;
    }
    const el = scrollContainerRef.current;
    if (el && pending?.side === "past") el.scrollTop += el.scrollHeight - pending.scrollHeight;
  }, [isLoading, scrollToAnchor]);

  // The bottom sentinel loads more as soon as it scrolls into view. The
  // observer is recreated whenever the data or loading state changes so a
  // still-visible sentinel (short list) keeps filling until the limit.
  useEffect(() => {
    const root = scrollContainerRef.current;
    const target = bottomSentinelRef.current;
    if (!root || !target || !onExtendFuture || isLoading || !loadedForAnchorRef.current) return;
    if (typeof IntersectionObserver === "undefined") return;
    const observer = new IntersectionObserver((entries) => {
      if (entries.some((entry) => entry.isIntersecting)) requestFuture();
    }, { root, rootMargin: "0px 0px 300px 0px" });
    observer.observe(target);
    return () => observer.disconnect();
  }, [grouped, isLoading, onExtendFuture, requestFuture]);

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

  const loadingPast = isLoading && pendingRef.current?.side === "past";

  return (
    <div
      className="flex-1 overflow-y-auto [overflow-anchor:none]"
      ref={scrollContainerRef}
      onWheel={handleWheel}
    >
      <div className="px-4 py-2 text-center text-xs text-muted-foreground">
        {onExtendPast ? (
          <button
            type="button"
            onClick={requestPast}
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
        <div key={group.dateKey} ref={index === anchorIndex ? anchorRef : undefined} data-agenda-day={group.dateKey}>
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
        {onExtendFuture
          ? (isLoading && !loadingPast ? t("events.agenda_loading") : " ")
          : t("events.agenda_range_end", { date: formatRangeDate(rangeEnd) })}
      </div>
    </div>
  );
}
