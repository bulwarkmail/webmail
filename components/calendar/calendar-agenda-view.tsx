"use client";

import { useMemo, useRef, useCallback } from "react";
import { useTranslations } from "next-intl";
import { useDisplayDateFormatter } from "@/hooks/use-display-date-formatter";
import { format, isTomorrow, startOfDay } from "date-fns";
import { MapPin, Users } from "@/components/icons";
import { cn } from "@/lib/utils";
import { getEventColor } from "./event-card";
import { getEventDayBounds, getEventEndDate, getEventStartDate, getPrimaryCalendarId } from "@/lib/calendar-utils";
import { displayNow, isDisplayToday } from "@/lib/timezone";
import { getParticipantCount, isDeclinedByUser } from "@/lib/calendar-participants";
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
  /** The user's calendar addresses, to mark events they declined (#1110). */
  currentUserEmails?: string[];
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
  currentUserEmails,
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

      {grouped.map((group, index) => {
        const today = isDisplayToday(group.date);
        const relativeLabel = today
          ? t("events.today_header")
          : isTomorrow(group.date) ? t("events.tomorrow_header") : null;
        return (
        <div
          key={group.dateKey}
          ref={index === focusIndex ? focusRowRef : undefined}
          data-agenda-day={group.dateKey}
          className="flex items-start gap-2 px-2 sm:px-4 py-1.5 border-b border-border"
          aria-label={formatDateHeader(group.date)}
          role="group"
        >
          {/* The date sits on the left of its events, as in a schedule. */}
          <div className="sticky top-0 flex items-center gap-2 w-24 sm:w-32 flex-shrink-0 py-1.5">
            <span className={cn(
              "inline-flex items-center justify-center w-9 h-9 rounded-full text-xl flex-shrink-0",
              today ? "bg-primary text-primary-foreground font-semibold" : "text-foreground",
            )}>
              {intlFormatter.dateTime(group.date, { day: "numeric" })}
            </span>
            <span className="min-w-0 leading-tight">
              <span className={cn(
                "block text-[11px] font-medium uppercase tracking-wide truncate",
                today ? "text-primary" : "text-muted-foreground",
              )}>
                {intlFormatter.dateTime(group.date, { month: "short", weekday: "short" })}
              </span>
              {relativeLabel && (
                <span className={cn("block text-[11px] truncate", today ? "text-primary" : "text-muted-foreground")}>
                  {relativeLabel}
                </span>
              )}
            </span>
          </div>

          {group.events.length === 0 ? (
            <div className="flex-1 py-3.5 text-sm text-muted-foreground">
              {t("events.no_events")}
            </div>
          ) : (
          <div className="flex-1 min-w-0 py-0.5">
            {group.events.map((ev) => {
              const calId = getPrimaryCalendarId(ev);
              const calendar = calId ? calendarMap.get(calId) : undefined;
              const color = getEventColor(ev, calendar);
              const start = getEventStartDate(ev);
              const end = getEventEndDate(ev);
              // iTIP CANCEL marks the attendee's copy with status "cancelled"
              // instead of deleting it (#572); a declined invitation stays
              // listed too (#1110).
              const isInactive = ev.status === "cancelled" || isDeclinedByUser(ev, currentUserEmails);
              const locationName = ev.locations
                ? Object.values(ev.locations)[0]?.name
                : null;
              const meta = [locationName, calendar?.name].filter(Boolean).join(" · ");

              return (
                <button
                  key={ev.id}
                  onClick={(e) => onSelectEvent(ev, e.currentTarget.getBoundingClientRect())}
                  onMouseEnter={(e) => onHoverEvent?.(ev, e.currentTarget.getBoundingClientRect())}
                  onMouseLeave={() => onHoverLeave?.()}
                  onContextMenu={onContextMenuEvent ? (e) => onContextMenuEvent(e, ev) : undefined}
                  className="w-full flex items-start gap-3 px-2 rounded-md hover:bg-muted/60 transition-colors text-start"
                  style={{ paddingBlock: 'var(--density-item-py)' }}
                >
                  <span className="w-28 sm:w-32 flex-shrink-0 text-sm text-muted-foreground tabular-nums">
                    {ev.showWithoutTime ? t("events.all_day") : `${formatTime(start)} – ${formatTime(end)}`}
                  </span>

                  {/* Calendar colour as a dot on the title line; hollow when
                      declined or cancelled (repos/branding/APP.md). */}
                  <span
                    className="w-[9px] h-[9px] mt-[5.5px] rounded-full flex-shrink-0"
                    style={isInactive ? { boxShadow: `inset 0 0 0 1.5px ${color}` } : { backgroundColor: color }}
                    aria-hidden="true"
                  />

                  <div className="flex-1 min-w-0">
                    <div className={cn("text-sm font-medium truncate", isInactive && "line-through text-muted-foreground")}>
                      {ev.title || t("events.no_title")}
                    </div>
                    {(meta || getParticipantCount(ev) > 0) && (
                      <div className="flex items-center gap-2 text-xs text-muted-foreground mt-0.5 min-w-0">
                        {locationName && <MapPin className="w-3 h-3 flex-shrink-0" />}
                        {meta && <span className="truncate">{meta}</span>}
                        {getParticipantCount(ev) > 0 && (
                          <span className="flex items-center gap-1 flex-shrink-0">
                            <Users className="w-3 h-3" />
                            {getParticipantCount(ev)}
                          </span>
                        )}
                      </div>
                    )}
                  </div>
                </button>
              );
            })}
          </div>
          )}
        </div>
        );
      })}

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
