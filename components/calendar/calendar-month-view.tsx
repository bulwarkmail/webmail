"use client";

import { useMemo, useState, useCallback, useRef, useLayoutEffect, type DragEvent } from "react";
import { useTranslations } from "next-intl";
import { format, parseISO, eachDayOfInterval, addDays, isSameDay } from "date-fns";
import { cn } from "@/lib/utils";
import { EventCard } from "./event-card";
import { CalendarTaskChip } from "./task-chip";
import { buildWeekSegments, getEventDayBounds, getPrimaryCalendarId } from "@/lib/calendar-utils";
import { groupTasksByDueDay } from "@/lib/calendar-tasks";
import { isDeclinedByUser } from "@/lib/calendar-participants";
import type { CalendarEvent, Calendar, CalendarTask } from "@/lib/jmap/types";
import { useAuthStore } from "@/stores/auth-store";
import { useCalendarStore } from "@/stores/calendar-store";
import { movedEventUpdates } from "@/lib/calendar-participants";
import { useSettingsStore, type MonthTimedEventStyle } from "@/stores/settings-store";
import { FONT_SIZE_SCALE } from "@/lib/accessibility-settings";
import type { PendingEventPreview } from "./event-modal";
import { toast } from "@/stores/toast-store";
import { useCalendarLocale } from "@/hooks/use-calendar-locale";
import { useScrollWindow } from "@/hooks/use-scroll-window";
import { dayKey, mostVisibleMonthDay, parseDayKey, type ScrollWindowViewProps } from "@/lib/calendar-scroll-window";
import { useCalendarErrorMessage } from "@/hooks/use-calendar-error-message";
import { PluginDayLabel } from "./plugin-day-label";
import { useDisplayDateFormatter } from "@/hooks/use-display-date-formatter";
import type { MoveEventHandler } from "@/hooks/use-time-grid-interactions";
import { useCvdColor } from "@/hooks/use-cvd-color";

interface CalendarMonthViewProps extends ScrollWindowViewProps {
  selectedDate: Date;
  events: CalendarEvent[];
  calendars: Calendar[];
  onSelectDate: (date: Date) => void;
  onSelectEvent: (event: CalendarEvent, anchorRect: DOMRect) => void;
  onHoverEvent?: (event: CalendarEvent, anchorRect: DOMRect) => void;
  onHoverLeave?: () => void;
  onContextMenuEvent?: (e: React.MouseEvent, event: CalendarEvent) => void;
  onContextMenuEmpty?: (e: React.MouseEvent, date: Date, hour?: number, allDayArea?: boolean) => void;
  /** A click on a day's empty space: a new all-day event there (wide screens). */
  onCreateAllDay?: (date: Date) => void;
  /** Open a day in the day view (its date number, or its "N more" link). */
  onOpenDay?: (date: Date) => void;
  firstDayOfWeek?: number;
  isMobile?: boolean;
  pendingPreview?: PendingEventPreview | null;
  tasks?: CalendarTask[];
  onToggleTaskComplete?: (task: CalendarTask) => void;
  onSelectTask?: (task: CalendarTask) => void;
  /**
   * The user's calendar addresses, to mark events they declined (#1110).
   * Moving an event they organize also asks its attendees again.
   */
  currentUserEmails?: string[];
  /** Whether the user may change an event: only those can be dragged or resized. */
  canEditEvent?: (event: CalendarEvent) => boolean;
  /** The event whose card or editor is open: drawn with the selection ring. */
  selectedEventId?: string | null;
  /**
   * Save a drag or resize. The page asks which occurrences a change to a
   * series covers; without it the change goes straight to the store.
   */
  onMoveEvent?: MoveEventHandler;
}

/**
 * The month grid's rows are positioned in pixels, so they follow the text size
 * by hand: at a fixed height large text was cut off and ran into the day number.
 */
export function monthGridMetrics(isMobile: boolean, textScale: number) {
  const scale = Math.max(1, textScale);
  const overlayTop = Math.round((isMobile ? 34 : 30) * scale);
  // 24px chips with a mouse (WCAG 2.5.8); touch screens show dots.
  const rowHeight = Math.round((isMobile ? 18 : 26) * scale);
  const chipHeight = rowHeight - 2;
  // A wide-screen week row fits at least three entries and the "N more"
  // link, so a short window (1280x720) does not cut every day to one.
  const baseRowMinHeight = isMobile ? 52 : overlayTop + 4 + 8 + 4 * rowHeight;
  return { overlayTop, rowHeight, chipHeight, baseRowMinHeight };
}

export function CalendarMonthView({
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
  onSelectDate,
  onSelectEvent,
  onHoverEvent,
  onHoverLeave,
  onContextMenuEvent,
  onContextMenuEmpty,
  onCreateAllDay,
  onOpenDay,
  isMobile,
  pendingPreview,
  tasks,
  onToggleTaskComplete,
  onSelectTask,
  currentUserEmails,
  canEditEvent = () => true,
  selectedEventId,
  onMoveEvent,
}: CalendarMonthViewProps) {
  const t = useTranslations("calendar");
  const paint = useCvdColor();
  const describeError = useCalendarErrorMessage();
  const showTimeInMonthView = useSettingsStore((state) => state.showTimeInMonthView);
  const timedStyle = useSettingsStore((state) => state.calendarMonthTimedEvents);
  // On mobile the month view collapses events to dots unless the user opted
  // into full entries via "Show time in month view" (#666).
  const showChips = !isMobile || showTimeInMonthView;
  const textScale = FONT_SIZE_SCALE[useSettingsStore((state) => state.fontSize)] ?? 1;
  const { overlayTop, rowHeight, chipHeight, baseRowMinHeight } = monthGridMetrics(isMobile, textScale);
  const {
    dayHeaderKeys,
    getMonthGridDays,
    checkIsToday,
    checkIsSameMonth,
    checkIsSameDay,
    formatDayNumber,
    formatFullDate,
    formatMonthYear,
    getMonth,
    getYear,
    monthLabelKeys,
  } = useCalendarLocale();

  // The loaded window is a run of whole weeks (#759): scrolling moves through
  // them continuously and the edges widen the window.
  const weeks = useMemo(() => {
    const days = eachDayOfInterval({ start: rangeStart, end: rangeEnd });
    const result: Date[][] = [];
    for (let i = 0; i + 7 <= days.length; i += 7) {
      result.push(days.slice(i, i + 7));
    }
    return result;
  }, [rangeStart, rangeEnd]);

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

  const tasksByDate = useMemo(() => groupTasksByDueDay(tasks), [tasks]);

  // Phones have room for one letter per weekday: the language's own short
  // form, not the first letters of the name ("اث" for Monday in Arabic).
  const intlFormatter = useDisplayDateFormatter();
  const narrowDayNames = useMemo(
    () => (weeks[0] ?? []).map((day) => intlFormatter.dateTime(day, { weekday: "narrow" })),
    [weeks, intlFormatter],
  );

  const weekSegments = useMemo(() => {
    return weeks.map((week) => {
      const segments = buildWeekSegments(events, week);
      const rowCount = segments.reduce((maxRows, segment) => Math.max(maxRows, segment.row + 1), 0);
      // Tasks stack under the lowest event of their own day rather than of
      // the whole week, so a busy Monday does not push Friday's tasks down.
      const dayEventRows = week.map((_, dayIndex) => segments.reduce(
        (rows, segment) => dayIndex >= segment.startIndex && dayIndex < segment.startIndex + segment.span
          ? Math.max(rows, segment.row + 1)
          : rows,
        0,
      ));
      const dayTasks = week.map((day) => tasksByDate.get(format(day, "yyyy-MM-dd")) ?? []);
      const contentRows = dayTasks.reduce(
        (rows, dayTaskList, dayIndex) => Math.max(rows, dayEventRows[dayIndex] + dayTaskList.length),
        rowCount,
      );
      return { week, segments, rowCount, dayEventRows, dayTasks, contentRows };
    });
  }, [events, weeks, tasksByDate]);

  const scrollRef = useRef<HTMLDivElement>(null);
  const headerRef = useRef<HTMLDivElement>(null);
  const topSentinelRef = useRef<HTMLDivElement>(null);
  const bottomSentinelRef = useRef<HTMLDivElement>(null);

  // Six rows fill the viewport, as a single month used to; taller rows grow
  // with their chips.
  const [viewportHeight, setViewportHeight] = useState(0);
  const [headerHeight, setHeaderHeight] = useState(0);
  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(() => {
      setViewportHeight(el.clientHeight);
      if (headerRef.current) setHeaderHeight(headerRef.current.offsetHeight);
    });
    observer.observe(el);
    if (headerRef.current) observer.observe(headerRef.current);
    setViewportHeight(el.clientHeight);
    if (headerRef.current) setHeaderHeight(headerRef.current.offsetHeight);
    return () => observer.disconnect();
  }, []);
  const availableHeight = Math.max(0, viewportHeight - headerHeight);
  const rowMinHeight = Math.max(baseRowMinHeight, Math.floor(availableHeight / 6));
  // On wide screens a week keeps its height: a day with more entries than
  // fit shows the first ones and a "N more" link (as in Google Calendar).
  // Phones keep growing the row to fit.
  const rowCapacity = Math.max(1, Math.floor((rowMinHeight - overlayTop - 4 - 8) / rowHeight));
  const capRows = showChips && !isMobile;

  // The month the user is looking at: the one with the most days in view. It
  // dims the other months' days and drives the title. One point on the screen
  // won't do: in a short pane it hit the week holding the 1st, and today's
  // month was called by the name of the one before.
  const [visibleMonthDate, setVisibleMonthDate] = useState<Date>(() => focus.date);
  const visibleMonthRef = useRef(visibleMonthDate);
  const scrollFrameRef = useRef<number | null>(null);

  // The week at the top of the view and how far it is scrolled, as a share of its
  // height. Rows change height with the window; see the effect below.
  const topWeekRef = useRef<{ key: string; progress: number } | null>(null);

  const sampleVisibleMonth = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    const hHeight = headerRef.current?.offsetHeight ?? 0;
    const box = el.getBoundingClientRect();
    const rows = Array.from(el.querySelectorAll<HTMLElement>("[data-week]"), (row) => {
      const rect = row.getBoundingClientRect();
      return { weekStart: parseDayKey(row.dataset.week ?? ""), top: rect.top, bottom: rect.bottom };
    });
    const viewTop = box.top + hHeight;
    const topRow = rows.find((row) => row.bottom > viewTop);
    if (topRow) {
      topWeekRef.current = {
        key: dayKey(topRow.weekStart),
        progress: Math.max(0, viewTop - topRow.top) / Math.max(1, topRow.bottom - topRow.top),
      };
    }
    const day = mostVisibleMonthDay(rows, box.top + hHeight, box.top + el.clientHeight, (d) => `${getYear(d)}-${getMonth(d)}`);
    if (!day) return;
    const current = visibleMonthRef.current;
    if (getMonth(day) === getMonth(current) && getYear(day) === getYear(current)) return;
    visibleMonthRef.current = day;
    setVisibleMonthDate(day);
    onVisibleDateChange?.(day);
  }, [getMonth, getYear, onVisibleDateChange]);

  const handleScroll = useCallback(() => {
    if (scrollFrameRef.current !== null) return;
    scrollFrameRef.current = requestAnimationFrame(() => {
      scrollFrameRef.current = null;
      sampleVisibleMonth();
    });
  }, [sampleVisibleMonth]);

  // A resized window or a turned phone changes the height of every week while
  // the scroll offset stays put, which slid the view to other weeks under a title
  // that still named the month. Keep the same week at the top. Watched on the
  // rows themselves, since their height also depends on what is in them.
  const weekHeightsRef = useRef(new Map<string, number>());
  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(() => {
      let changed = false;
      el.querySelectorAll<HTMLElement>("[data-week]").forEach((row) => {
        const key = row.dataset.week ?? "";
        const height = row.getBoundingClientRect().height;
        const known = weekHeightsRef.current.get(key);
        if (known !== undefined && known !== height) changed = true;
        weekHeightsRef.current.set(key, height);
      });
      const anchor = topWeekRef.current;
      if (!changed || !anchor) return;
      const row = el.querySelector<HTMLElement>(`[data-week="${anchor.key}"]`);
      if (!row) return;
      const rect = row.getBoundingClientRect();
      const viewTop = el.getBoundingClientRect().top + (headerRef.current?.offsetHeight ?? 0);
      el.scrollTop += rect.top + anchor.progress * rect.height - viewTop;
    });
    el.querySelectorAll("[data-week]").forEach((row) => observer.observe(row));
    return () => observer.disconnect();
  }, [weekSegments]);

  // Navigation puts the first week of the focused month at the top.
  const scrollToFocus = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    const grid = getMonthGridDays(focus.date);
    const targetKey = dayKey(grid[0] ?? focus.date);
    const row = el.querySelector<HTMLElement>(`[data-week="${targetKey}"]`);
    if (row) {
      const hHeight = headerRef.current?.offsetHeight ?? 0;
      el.scrollTop += row.getBoundingClientRect().top - el.getBoundingClientRect().top - hHeight;
    }
    topWeekRef.current = { key: targetKey, progress: 0 };
    visibleMonthRef.current = focus.date;
    setVisibleMonthDate(focus.date);
  }, [focus.date, getMonthGridDays]);

  useScrollWindow({
    scrollRef,
    axis: "vertical",
    isLoading,
    windowKey,
    focusNonce: focus.nonce,
    scrollToFocus,
    onExtendStart,
    onExtendEnd,
    startSentinelRef: topSentinelRef,
    endSentinelRef: bottomSentinelRef,
    contentKey: weekSegments,
    anchorSelector: "[data-week]",
  });

  // One tab stop for the whole grid (the selected day's date), arrows move
  // from day to day and week to week, Enter opens the day (R8): Tab used to
  // walk every date of the loaded months.
  const selectedKey = dayKey(selectedDate);
  const rovingKey = useMemo(() => {
    const keys = new Set(weeks.flat().map(dayKey));
    if (keys.has(selectedKey)) return selectedKey;
    const focusKey = dayKey(focus.date);
    return keys.has(focusKey) ? focusKey : (weeks[0]?.[0] ? dayKey(weeks[0][0]) : selectedKey);
  }, [weeks, selectedKey, focus.date]);
  const handleDayKeyDown = useCallback((e: React.KeyboardEvent<HTMLButtonElement>, day: Date, dayIndex: number) => {
    if (e.altKey || e.ctrlKey || e.metaKey || e.shiftKey) return;
    const rtl = getComputedStyle(e.currentTarget).direction === "rtl";
    let delta: number;
    switch (e.key) {
      case "ArrowLeft": delta = rtl ? 1 : -1; break;
      case "ArrowRight": delta = rtl ? -1 : 1; break;
      case "ArrowUp": delta = -7; break;
      case "ArrowDown": delta = 7; break;
      case "Home": delta = -dayIndex; break;
      case "End": delta = 6 - dayIndex; break;
      default: return;
    }
    // The grid's arrows, not the calendar's previous/next month.
    e.preventDefault();
    const next = addDays(day, delta);
    const target = scrollRef.current?.querySelector<HTMLButtonElement>(`[data-day-button="${dayKey(next)}"]`);
    if (!target) return;
    onSelectDate(next);
    target.focus();
  }, [onSelectDate]);

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
    // Anything else (a Pro tab or message moving to this pane) is not ours.
    const json = e.dataTransfer.getData("application/x-calendar-event");
    if (!json) return;
    e.preventDefault();
    setDropDayKey(null);
    try {
      const data = JSON.parse(json);
      const originalStart = parseISO(data.originalStart);
      const event = useCalendarStore.getState().events.find(e => e.id === data.eventId);
      const isAllDay = event?.showWithoutTime;
      const newStart = new Date(day);
      newStart.setHours(originalStart.getHours(), originalStart.getMinutes(), originalStart.getSeconds(), 0);
      // `start` is a LocalDateTime for all-day events too: Stalwart drops a
      // date-only value and the event is left without a start (#1119).
      const newStartISO = format(newStart, isAllDay ? "yyyy-MM-dd'T'00:00:00" : "yyyy-MM-dd'T'HH:mm:ss");
      if (newStartISO === data.originalStart) return;
      const client = useAuthStore.getState().client;
      if (!client) return;
      const moved = movedEventUpdates(event, { start: newStartISO }, currentUserEmails ?? []);
      if (event && onMoveEvent) await onMoveEvent(event, moved.updates, moved.sendSchedulingMessages, "move");
      else await useCalendarStore.getState().updateEvent(client, data.eventId, moved.updates, moved.sendSchedulingMessages);
    } catch (error) {
      toast.error(describeError(error, t("notifications.event_move_error")));
    }
  }, [t, describeError, currentUserEmails, onMoveEvent]);

  return (
    <div className="flex flex-col flex-1 overflow-hidden" role="grid" aria-label={`${t("views.month")}, ${formatMonthYear(visibleMonthDate)}`}>
      <div
        ref={scrollRef}
        className="flex-1 flex flex-col overflow-y-auto [overflow-anchor:none]"
        onScroll={handleScroll}
      >
        <div
          ref={headerRef}
          className="sticky top-0 z-50 bg-background grid grid-cols-7 border-b border-border"
          role="row"
        >
          {dayHeaderKeys.map((d, index) => (
            <div key={d} role="columnheader" aria-label={isMobile ? t(`days.${d}`) : undefined} className={cn(
              "text-center text-xs font-medium text-muted-foreground py-2 border-e border-border last:border-e-0",
              isMobile && "py-1.5 text-[0.6875rem]"
            )}>
              {isMobile ? narrowDayNames[index] ?? t(`days.${d}`) : t(`days.${d}`)}
            </div>
          ))}
        </div>
        <div ref={topSentinelRef} data-testid="month-top-sentinel" className="h-px flex-shrink-0" />
        {weekSegments.map(({ week, segments, rowCount, dayEventRows, dayTasks, contentRows }) => {
          const overflowing = capRows && contentRows > rowCapacity;
          // Rows drawn per day; the last one is taken by the "N more" link.
          const rowLimit = overflowing ? rowCapacity - 1 : Infinity;
          const hiddenPerDay = overflowing
            ? week.map((_, dayIndex) => {
              const hiddenEvents = segments.filter((segment) =>
                segment.row >= rowLimit
                && dayIndex >= segment.startIndex
                && dayIndex < segment.startIndex + segment.span,
              ).length;
              const hiddenTasks = dayTasks[dayIndex].filter((_, taskIndex) => dayEventRows[dayIndex] + taskIndex >= rowLimit).length;
              return hiddenEvents + hiddenTasks;
            })
            : null;
          // Rows that grow with their content make room for the new event's preview.
          const previewRows = !capRows && pendingPreview && week.some((day) => checkIsSameDay(pendingPreview.start, day)) ? 1 : 0;
          return (
          <div key={dayKey(week[0])} data-week={dayKey(week[0])} className="relative flex-shrink-0 border-b border-border" role="row" style={{
            minHeight: showChips && !overflowing
              ? Math.max(rowMinHeight, overlayTop + 4 + (contentRows + previewRows) * rowHeight + 8)
              : rowMinHeight,
          }}>
            <div className="grid grid-cols-7 h-full">
            {week.map((day, dayIndex) => {
              const inMonth = checkIsSameMonth(day, visibleMonthDate);
              const selected = checkIsSameDay(day, selectedDate);
              const today = checkIsToday(day);
              const key = format(day, "yyyy-MM-dd");
              const dayEvents = eventsByDate.get(key) || [];
              const dayTaskList = dayTasks[dayIndex];
              const fullDateLabel = formatFullDate(day);
              const previous = dayIndex > 0 ? week[dayIndex - 1] : addDays(day, -1);
              const firstOfMonth = !checkIsSameMonth(day, previous);

              return (
                <div
                  key={key}
                  role="gridcell"
                  aria-selected={selected}
                  onClick={() => {
                    onSelectDate(day);
                    // On phones a tap opens the day instead.
                    if (!isMobile) onCreateAllDay?.(day);
                  }}
                  onContextMenu={onContextMenuEmpty ? (e) => onContextMenuEmpty(e, day, undefined, true) : undefined}
                  onDragOver={(e) => handleCellDragOver(e, key)}
                  onDragLeave={handleCellDragLeave}
                  onDrop={(e) => handleCellDrop(e, day)}
                  className={cn(
                    "relative border-e border-border last:border-e-0 p-1 cursor-pointer transition-colors touch-manipulation",
                    !inMonth && "bg-muted/30",
                    "hover:bg-muted/50",
                    selected && isMobile && "bg-primary/10",
                    dropDayKey === key && "ring-2 ring-inset ring-primary bg-primary/10"
                  )}
                >
                  <div className="flex items-center justify-center gap-1 mb-0.5">
                    {firstOfMonth && (
                      <span className="text-[0.625rem] font-medium text-muted-foreground">
                        {t(`months.${monthLabelKeys[getMonth(day)]}`)}
                      </span>
                    )}
                    {/* The date opens that day in the day view; on phones the
                        whole cell already does. */}
                    <button
                      type="button"
                      data-day-button={key}
                      tabIndex={!isMobile && key === rovingKey ? 0 : -1}
                      onKeyDown={(e) => handleDayKeyDown(e, day, dayIndex)}
                      onClick={(e) => {
                        if (isMobile || !onOpenDay) return;
                        e.stopPropagation();
                        onOpenDay(day);
                      }}
                      aria-label={fullDateLabel}
                      aria-current={today ? "date" : undefined}
                      className={cn(
                        "inline-flex items-center justify-center rounded-full transition-colors",
                        isMobile ? "w-7 h-7 text-xs" : "w-6 h-6 text-xs",
                        today && "bg-primary text-primary-foreground font-bold",
                        selected && !today && "bg-primary/15 text-primary font-bold",
                        // Readable at 4.5:1 like any text; the muted colour
                        // still sets other months apart.
                        !inMonth && !selected && !today && "text-muted-foreground",
                        inMonth && !selected && !today && "font-medium",
                        !today && !isMobile && "hover:bg-muted"
                      )}
                    >
                      {formatDayNumber(day)}
                    </button>
                    {/* Phones have no room for the text: a dot stands in for it. */}
                    <PluginDayLabel surface="calendar-day-header" date={key} compact={isMobile} className={isMobile ? undefined : "min-w-0 flex-1"} />
                  </div>
                  {isMobile && !showChips ? (
                    <div className="flex items-center justify-center gap-0.5 flex-wrap">
                      {/* The dots in words, for screen readers. */}
                      {dayEvents.length > 0 && (
                        <span className="sr-only">{dayEvents.map((ev) => ev.title || t("events.no_title")).join(", ")}</span>
                      )}
                      {dayEvents.slice(0, 3).map((ev) => {
                        const calId = getPrimaryCalendarId(ev);
                        const cal = calId ? calendarMap.get(calId) : undefined;
                        const evColor = paint(ev.color || cal?.color || "#3b82f6");
                        const inactive = ev.status === "cancelled" || isDeclinedByUser(ev, currentUserEmails);
                        return (
                          <span
                            key={ev.id}
                            className={cn("w-1.5 h-1.5 rounded-full", inactive && "opacity-40")}
                            style={{ backgroundColor: evColor }}
                          />
                        );
                      })}
                      {/* Tasks are rings where events are filled dots. */}
                      {dayTaskList.slice(0, Math.max(0, 3 - dayEvents.length)).map((task) => {
                        const calId = Object.keys(task.calendarIds).find((id) => calendarMap.has(id));
                        return (
                          <span
                            key={`task-${task.id}`}
                            data-calendar-task={task.id}
                            className={cn("w-1.5 h-1.5 rounded-full border", task.progress === "completed" && "opacity-40")}
                            style={{ borderColor: paint((calId && calendarMap.get(calId)?.color) || "#3b82f6") }}
                          />
                        );
                      })}
                      {dayEvents.length + dayTaskList.length > 3 && (
                        <span className="w-1.5 h-1.5 rounded-full bg-muted-foreground/40" />
                      )}
                      {pendingPreview && checkIsSameDay(pendingPreview.start, day) && (
                        <span
                          className="w-1.5 h-1.5 rounded-full border border-dashed"
                          style={{ borderColor: paint(calendarMap.get(pendingPreview.calendarId)?.color || "#3b82f6") }}
                        />
                      )}
                    </div>
                  ) : null}
                  {showChips && (
                    <MonthCellEntries
                      dayIndex={dayIndex}
                      week={week}
                      segments={segments}
                      rowLimit={rowLimit}
                      rowCount={rowCount}
                      dayEventRows={dayEventRows}
                      dayTasks={dayTasks}
                      hidden={hiddenPerDay?.[dayIndex] ?? 0}
                      overlayTop={overlayTop}
                      rowHeight={rowHeight}
                      chipHeight={chipHeight}
                      isMobile={isMobile}
                      calendarMap={calendarMap}
                      pendingPreview={pendingPreview}
                      lastRow={capRows ? rowCapacity - 1 : Infinity}
                      selectedEventId={selectedEventId}
                      currentUserEmails={currentUserEmails}
                      canEditEvent={canEditEvent}
                      inView={(d) => checkIsSameMonth(d, visibleMonthDate)}
                      timedStyle={timedStyle}
                      onSelectEvent={onSelectEvent}
                      onHoverEvent={onHoverEvent}
                      onHoverLeave={onHoverLeave}
                      onContextMenuEvent={onContextMenuEvent}
                      onToggleTaskComplete={onToggleTaskComplete}
                      onSelectTask={onSelectTask}
                      onShowMore={() => (onOpenDay ?? onSelectDate)(week[dayIndex])}
                      moreLabel={t("events.more", { count: hiddenPerDay?.[dayIndex] ?? 0 })}
                      paint={paint}
                    />
                  )}
                </div>
              );
            })}
            </div>

          </div>
          );
        })}
        <div ref={bottomSentinelRef} data-testid="month-bottom-sentinel" className="h-px flex-shrink-0" />
      </div>
    </div>
  );
}

type WeekSegment = ReturnType<typeof buildWeekSegments>[number];

/**
 * A month cell's events, tasks and "N more" link. They sit inside the
 * day's own gridcell, so a screen reader moving through the grid reads
 * them with the day (an event in a row but outside any cell was skipped).
 * An event spanning several days is drawn from its first day's cell
 * across the following ones.
 */
function MonthCellEntries({
  dayIndex, week, segments, rowLimit, rowCount, dayEventRows, dayTasks, hidden, overlayTop, rowHeight, chipHeight,
  isMobile, calendarMap, pendingPreview, lastRow, selectedEventId, currentUserEmails, canEditEvent, inView, timedStyle,
  onSelectEvent, onHoverEvent, onHoverLeave, onContextMenuEvent, onToggleTaskComplete, onSelectTask, onShowMore, moreLabel, paint,
}: {
  dayIndex: number;
  week: Date[];
  segments: WeekSegment[];
  rowLimit: number;
  rowCount: number;
  dayEventRows: number[];
  dayTasks: CalendarTask[][];
  hidden: number;
  overlayTop: number;
  rowHeight: number;
  chipHeight: number;
  isMobile?: boolean;
  calendarMap: Map<string, Calendar>;
  pendingPreview?: PendingEventPreview | null;
  /** The last row a fixed-height week has room for; the preview must not go past it. */
  lastRow: number;
  selectedEventId?: string | null;
  currentUserEmails?: string[];
  canEditEvent: (event: CalendarEvent) => boolean;
  /** Whether a day is in the month in view: only those take Tab. */
  inView: (day: Date) => boolean;
  timedStyle?: MonthTimedEventStyle;
  onSelectEvent: (event: CalendarEvent, anchorRect: DOMRect) => void;
  onHoverEvent?: (event: CalendarEvent, anchorRect: DOMRect) => void;
  onHoverLeave?: () => void;
  onContextMenuEvent?: (e: React.MouseEvent, event: CalendarEvent) => void;
  onToggleTaskComplete?: (task: CalendarTask) => void;
  onSelectTask?: (task: CalendarTask) => void;
  onShowMore: () => void;
  moreLabel: string;
  paint: (color: string) => string;
}) {
  const day = week[dayIndex];
  // Width of `span` cells from this one, with the 1px borders between them.
  const spanWidth = (span: number) => `calc(${span * 100}% + ${span - 2}px)`;
  const place = (row: number, span = 1): React.CSSProperties => ({
    insetInlineStart: 1,
    width: spanWidth(span),
    top: overlayTop + row * rowHeight,
    height: chipHeight,
  });
  // A click, double click or right-click on an entry is the entry's, not a
  // click on the empty day (which creates an all-day event there).
  const own = {
    onClick: (e: React.MouseEvent) => e.stopPropagation(),
    onDoubleClick: (e: React.MouseEvent) => e.stopPropagation(),
    onContextMenu: (e: React.MouseEvent) => e.stopPropagation(),
  };
  const daySegments = segments.filter((segment) => segment.startIndex === dayIndex && segment.row < rowLimit);
  const tasks = dayTasks[dayIndex].filter((_, taskIndex) => dayEventRows[dayIndex] + taskIndex < rowLimit);
  const preview = pendingPreview && isSameDay(pendingPreview.start, day) ? pendingPreview : null;

  return (
    <>
      {daySegments.map((segment) => {
        const calId = getPrimaryCalendarId(segment.event);
        const spanDays = week.slice(segment.startIndex, segment.startIndex + segment.span);
        return (
          <div
            key={`${segment.event.id}-${segment.startIndex}-${segment.row}`}
            className="absolute z-10 px-0.5"
            style={place(segment.row, segment.span)}
            {...own}
          >
            <EventCard
              event={segment.event}
              isSelected={segment.event.id === selectedEventId}
              calendar={calId ? calendarMap.get(calId) : undefined}
              variant="span"
              timedStyle={segment.span === 1 ? timedStyle : undefined}
              continuesBefore={segment.continuesBefore}
              continuesAfter={segment.continuesAfter}
              onClick={(rect) => onSelectEvent(segment.event, rect)}
              onMouseEnter={(rect) => onHoverEvent?.(segment.event, rect)}
              onMouseLeave={onHoverLeave}
              onContextMenu={onContextMenuEvent}
              currentUserEmails={currentUserEmails}
              draggable={canEditEvent(segment.event)}
              tabbable={spanDays.some(inView)}
              className={isMobile ? "text-[0.625rem] px-1" : undefined}
            />
          </div>
        );
      })}
      {tasks.map((task, taskIndex) => {
        const calId = Object.keys(task.calendarIds).find((id) => calendarMap.has(id));
        return (
          <div
            key={`task-${task.id}`}
            className="absolute z-10 px-0.5"
            style={place(dayEventRows[dayIndex] + taskIndex)}
            {...own}
          >
            <CalendarTaskChip
              task={task}
              calendar={calId ? calendarMap.get(calId) : undefined}
              onToggleComplete={onToggleTaskComplete}
              onSelect={onSelectTask}
              tabbable={inView(day)}
            />
          </div>
        );
      })}
      {hidden > 0 && (
        <div className="absolute z-10 px-0.5" style={place(rowLimit)} {...own}>
          <button
            type="button"
            tabIndex={inView(day) ? undefined : -1}
            onClick={onShowMore}
            className="w-full h-full text-start px-1.5 rounded-xs text-xs font-medium text-muted-foreground hover:bg-muted hover:text-foreground transition-colors truncate"
          >
            {moreLabel}
          </button>
        </div>
      )}
      {preview && (() => {
        // On a full day it lies over the last row: below it, it landed on the next week's date.
        const previewRow = Math.min(lastRow, Math.max(rowCount, dayEventRows[dayIndex] + dayTasks[dayIndex].length));
        const color = paint(calendarMap.get(preview.calendarId)?.color || "#3b82f6");
        return (
          <div className="absolute z-20 px-0.5 pointer-events-none" style={place(previewRow)}>
            <div
              data-pending-preview
              className={cn(
                "h-full rounded text-[0.625rem] font-medium truncate border-2 border-dashed",
                isMobile ? "leading-[1rem] px-1" : "leading-[1.25rem] px-1.5"
              )}
              style={{ borderColor: color, color, backgroundColor: `color-mix(in srgb, ${color} 6%, var(--color-background))` }}
            >
              {preview.title}
            </div>
          </div>
        );
      })()}
    </>
  );
}
