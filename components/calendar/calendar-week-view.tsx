"use client";

import { useMemo, useEffect, useLayoutEffect, useRef, useState, useCallback } from "react";
import { useTranslations } from "next-intl";
import { useDisplayDateFormatter } from "@/hooks/use-display-date-formatter";
import {
  startOfWeek, format, isSameDay, eachDayOfInterval,
} from "date-fns";
import { cn } from "@/lib/utils";
import { EventCard } from "./event-card";
import { QuickEventInput } from "./quick-event-input";
import { CalendarTaskChip } from "./task-chip";
import { AllHoursToggle, HiddenEventsIndicator } from "./display-hours-controls";
import { groupTasksByDueDay } from "@/lib/calendar-tasks";
import { buildTimedFullDayWeekSegments, buildWeekSegmentsRaw, formatSnapTime, getEventDayBounds, getPrimaryCalendarId, isTimedEventFullDayOnDate, layoutOverlappingEvents, packWeekSegments } from "@/lib/calendar-utils";
import { clipToDisplayHours, indexOfDayOnOrAfter, partitionByDisplayHours, remapSegmentsToShownDays, resolveWorkingDays } from "@/lib/calendar-display-range";
import { displayNow, isDisplayToday } from "@/lib/timezone";
import type { CalendarEvent, Calendar, CalendarTask } from "@/lib/jmap/types";
import { useSettingsStore } from "@/stores/settings-store";
import { useDisplayHours } from "@/hooks/use-display-hours";
import { useTimeGridInteractions } from "@/hooks/use-time-grid-interactions";
import { useScrollWindow, getScrollStart, setScrollStart, scrollToStart } from "@/hooks/use-scroll-window";
import { dayKey, type ScrollWindowViewProps } from "@/lib/calendar-scroll-window";
import type { PendingEventPreview } from "./event-modal";
import { readableTextOn } from "@/lib/color-transform";

interface CalendarWeekViewProps extends ScrollWindowViewProps {
  selectedDate: Date;
  events: CalendarEvent[];
  calendars: Calendar[];
  onSelectDate: (date: Date) => void;
  /** Open a day in the day view (clicking its date in the header). */
  onOpenDay?: (date: Date) => void;
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
  onSelectTask?: (task: CalendarTask) => void;
  /** The user's calendar addresses, to mark events they declined (#1110). */
  currentUserEmails?: string[];
}

const HOUR_HEIGHT = 60;
const HOURS = Array.from({ length: 24 }, (_, i) => i);
const MOBILE_COL_WIDTH = 120;
const MIN_COL_WIDTH = 80;

export function CalendarWeekView({
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
  onOpenDay,
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
  onSelectTask,
  currentUserEmails,
}: CalendarWeekViewProps) {
  const t = useTranslations("calendar");
  // Grid days / event dates are display dates (local fields = wall-clock in
  // the user's zone); the app-wide formatter would shift them again (#755).
  const intlFormatter = useDisplayDateFormatter();
  // One scroll container for both axes (#759): the strip scrolls sideways,
  // the hours scroll down, and the sticky header rows and hour gutter stay
  // put. (A nested vertical scroller would capture the gutter's stickiness.)
  const rootRef = useRef<HTMLDivElement>(null);
  const startSentinelRef = useRef<HTMLDivElement>(null);
  const endSentinelRef = useRef<HTMLDivElement>(null);
  const weekStart = (firstDayOfWeek === 0 ? 0 : firstDayOfWeek === 6 ? 6 : 1) as 0 | 1 | 6;
  const gutterWidth = isMobile ? 40 : 56;

  // One column per loaded day (#759). A week's columns fill the viewport on
  // desktop; the strip scrolls sideways and widens at either end. Days the
  // user does not work on can be left out (#1164).
  const allDays = useMemo(
    () => eachDayOfInterval({ start: rangeStart, end: rangeEnd }),
    [rangeStart, rangeEnd],
  );
  const hideNonWorkingDays = useSettingsStore((s) => s.calendarHideNonWorkingDays);
  const workingDaysSetting = useSettingsStore((s) => s.calendarWorkingDays);
  const workingDays = useMemo(
    () => resolveWorkingDays(hideNonWorkingDays, workingDaysSetting),
    [hideNonWorkingDays, workingDaysSetting],
  );
  const { days, shownIndexByDay } = useMemo(() => {
    if (!workingDays) return { days: allDays, shownIndexByDay: null };
    const shown: Date[] = [];
    const indices = allDays.map((day) => {
      if (!workingDays.has(day.getDay())) return -1;
      shown.push(day);
      return shown.length - 1;
    });
    return shown.length > 0 ? { days: shown, shownIndexByDay: indices } : { days: allDays, shownIndexByDay: null };
  }, [allDays, workingDays]);
  const colCount = days.length;
  const columnsPerWeek = shownIndexByDay && workingDays ? workingDays.size : 7;

  const measureColWidth = useCallback((root: HTMLElement | null) => {
    if (isMobile || !root) return MOBILE_COL_WIDTH;
    return Math.max(MIN_COL_WIDTH, Math.floor((root.clientWidth - gutterWidth) / columnsPerWeek));
  }, [isMobile, gutterWidth, columnsPerWeek]);
  const [colWidth, setColWidth] = useState(MOBILE_COL_WIDTH);
  const [viewportWidth, setViewportWidth] = useState(0);
  // First day in view, reported by the scroll handler below (#1293)
  const [visibleDayKey, setVisibleDayKey] = useState<string | null>(null);
  useLayoutEffect(() => {
    const root = rootRef.current;
    if (!root) return;
    const measure = () => {
      setColWidth(measureColWidth(root));
      setViewportWidth(Math.max(0, root.clientWidth - gutterWidth));
    };
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(measure);
    observer.observe(root);
    return () => observer.disconnect();
  }, [measureColWidth, gutterWidth]);

  // Every scroll offset is computed with the column width that is rendered.
  // When that width changes (first measurement, resize) keep the same day at
  // the start.
  const renderedColWidthRef = useRef<number | null>(null);
  useLayoutEffect(() => {
    const root = rootRef.current;
    const prev = renderedColWidthRef.current;
    renderedColWidthRef.current = colWidth;
    if (!root || prev === null || prev === colWidth) return;
    setScrollStart(root, "horizontal", Math.round(getScrollStart(root, "horizontal") / prev) * colWidth);
  }, [colWidth]);

  const stripWidth = gutterWidth + colCount * colWidth;
  const columnsStyle = { gridTemplateColumns: `repeat(${colCount}, ${colWidth}px)` };

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

  const {
    hours, canToggle: canToggleHours, configured: configuredHours, showAllHours, toggleAllHours, revealMinutes,
  } = useDisplayHours({ scrollRef: rootRef, hourHeight: HOUR_HEIGHT });
  const firstHour = hours.startMinutes / 60;
  const visibleHours = HOURS.slice(firstHour, hours.endMinutes / 60);
  const gridHeight = visibleHours.length * HOUR_HEIGHT;

  // Column layouts are the costly part of a render; with months of columns
  // they must not be redone on every scroll-driven re-render.
  const layoutByDay = useMemo(() => {
    const map = new Map<string, ReturnType<typeof partitionByDisplayHours> & { layouts: ReturnType<typeof layoutOverlappingEvents> }>();
    for (const day of days) {
      const key = format(day, "yyyy-MM-dd");
      const partition = partitionByDisplayHours(timedEvents.get(key) || [], day, hours);
      map.set(key, { ...partition, layouts: layoutOverlappingEvents(partition.visible, day) });
    }
    return map;
  }, [days, timedEvents, hours]);

  // Built over the consecutive days and then moved onto the drawn columns,
  // so an event across a hidden weekend still spans Friday to Monday.
  const allDaySegments = useMemo(() => {
    const explicitAllDay = buildWeekSegmentsRaw(
      events.filter((event) => event.showWithoutTime),
      allDays,
    );
    const timedFullDay = buildTimedFullDayWeekSegments(
      events.filter((event) => !event.showWithoutTime),
      allDays,
    );
    const segments = [...explicitAllDay, ...timedFullDay];

    return packWeekSegments(shownIndexByDay ? remapSegmentsToShownDays(segments, shownIndexByDay) : segments);
  }, [events, allDays, shownIndexByDay]);

  const tasksByDay = useMemo(() => groupTasksByDueDay(tasks), [tasks]);

  // Tasks stack under the events of their own day rather than globally (#1107, #1270)
  const dayEventRows = useMemo(() => {
    return days.map((_, dayIndex) =>
      allDaySegments.reduce(
        (rows, segment) =>
          dayIndex >= segment.startIndex && dayIndex < segment.startIndex + segment.span
            ? Math.max(rows, segment.row + 1)
            : rows,
        0,
      )
    );
  }, [days, allDaySegments]);

  // The strip holds weeks to months of days (#759), but the all-day area is
  // sized from the columns in view: a crowded day in another week must not
  // add empty rows or an expand toggle here (#1293). The first visible day is
  // tracked by date, so columns prepended while loading do not shift it.
  const visibleStartIndex = useMemo(() => {
    const tracked = visibleDayKey ? days.findIndex((d) => dayKey(d) === visibleDayKey) : -1;
    if (tracked >= 0) return tracked;
    const target = isMobile ? focus.date : startOfWeek(focus.date, { weekStartsOn: weekStart });
    return indexOfDayOnOrAfter(days, target);
  }, [visibleDayKey, days, isMobile, focus.date, weekStart]);
  const visibleColumns = isMobile ? Math.max(1, Math.ceil(viewportWidth / colWidth)) : columnsPerWeek;

  // Max combined rows (events + tasks) across the visible days
  const maxContentRows = useMemo(() => {
    let max = 0;
    const end = Math.min(days.length, visibleStartIndex + visibleColumns);
    for (let i = visibleStartIndex; i < end; i++) {
      const key = format(days[i], "yyyy-MM-dd");
      const taskCount = tasksByDay.get(key)?.length ?? 0;
      const total = dayEventRows[i] + taskCount;
      if (total > max) max = total;
    }
    return max;
  }, [days, dayEventRows, tasksByDay, visibleStartIndex, visibleColumns]);

  const hasAllDay = useMemo(() => {
    return maxContentRows > 0;
  }, [maxContentRows]);

  const DEFAULT_ALL_DAY_MAX_ROWS = 3;
  const [isAllDayExpanded, setIsAllDayExpanded] = useState(false);
  const isExpandable = maxContentRows > DEFAULT_ALL_DAY_MAX_ROWS;
  const visibleRows = isAllDayExpanded ? maxContentRows : Math.min(DEFAULT_ALL_DAY_MAX_ROWS, maxContentRows);
  const allDayHeight = Math.max(28, visibleRows * 24 + 4);

  // Navigation aligns the focused week (the focused day itself on mobile,
  // where fewer columns fit) with the start of the viewport.
  const scrollToFocus = useCallback(() => {
    const root = rootRef.current;
    if (!root) return;
    const target = isMobile ? focus.date : startOfWeek(focus.date, { weekStartsOn: weekStart });
    setScrollStart(root, "horizontal", indexOfDayOnOrAfter(days, target) * colWidth);
  }, [focus.date, isMobile, weekStart, days, colWidth]);

  useScrollWindow({
    scrollRef: rootRef,
    axis: "horizontal",
    isLoading,
    windowKey,
    focusNonce: focus.nonce,
    scrollToFocus,
    onExtendStart,
    onExtendEnd,
    startSentinelRef,
    endSentinelRef,
    contentKey: days,
    anchorSelector: "[data-day]",
  });

  // Report the first column in view so the title and mini calendar follow,
  // and settle on a column boundary once the scrolling has stopped. (CSS
  // scroll snapping is not used: browsers re-snap on their own when columns
  // are prepended, which would double the scroll correction.)
  const visibleKeyRef = useRef<string | null>(null);
  const scrollFrameRef = useRef<number | null>(null);
  const snapTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const handleStripScroll = useCallback(() => {
    if (snapTimerRef.current !== null) clearTimeout(snapTimerRef.current);
    snapTimerRef.current = setTimeout(() => {
      snapTimerRef.current = null;
      const root = rootRef.current;
      if (!root || colWidth <= 0) return;
      const start = getScrollStart(root, "horizontal");
      const snapped = Math.round(start / colWidth) * colWidth;
      if (Math.abs(snapped - start) > 1) scrollToStart(root, "horizontal", snapped);
    }, 150);
    if (scrollFrameRef.current !== null) return;
    scrollFrameRef.current = requestAnimationFrame(() => {
      scrollFrameRef.current = null;
      const root = rootRef.current;
      if (!root || colWidth <= 0) return;
      const index = Math.max(0, Math.min(colCount - 1, Math.round(getScrollStart(root, "horizontal") / colWidth)));
      const day = days[index];
      if (!day) return;
      const key = dayKey(day);
      if (key === visibleKeyRef.current) return;
      visibleKeyRef.current = key;
      setVisibleDayKey(key);
      onVisibleDateChange?.(day);
    });
  }, [colWidth, colCount, days, onVisibleDateChange]);
  useEffect(() => () => {
    if (snapTimerRef.current !== null) clearTimeout(snapTimerRef.current);
    if (scrollFrameRef.current !== null) cancelAnimationFrame(scrollFrameRef.current);
  }, []);

  const [nowMinutes, setNowMinutes] = useState(() => {
    const now = displayNow();
    return now.getHours() * 60 + now.getMinutes();
  });
  useEffect(() => {
    const interval = setInterval(() => {
      const now = displayNow();
      setNowMinutes(now.getHours() * 60 + now.getMinutes());
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
    gridStartMinutes: hours.startMinutes,
    gridEndMinutes: hours.endMinutes,
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

  // Above every in-column overlay (events z-10, handles z-20, drag z-30) so
  // columns scrolled past the start do not show through the gutter.
  const gutterClass = cn("flex-shrink-0 sticky start-0 z-40 bg-background", isMobile ? "w-10" : "w-14");

  return (
    <div
      ref={rootRef}
      className="flex min-h-0 min-w-0 flex-col flex-1 overflow-auto [overflow-anchor:none]"
      onScroll={handleStripScroll}
      role="grid"
      aria-label={t("views.week")}
    >
      <div className="relative flex flex-col" style={{ width: stripWidth, minWidth: stripWidth }}>
      <div ref={startSentinelRef} data-testid="week-start-sentinel" className="absolute inset-y-0 start-0 w-px pointer-events-none" />
      <div ref={endSentinelRef} data-testid="week-end-sentinel" className="absolute inset-y-0 end-0 w-px pointer-events-none" />
      <div className="sticky top-0 z-50 bg-background">
      <div className="flex border-b border-border" role="row">
        <div className={cn(gutterClass, "flex items-end justify-center pb-1")}>
          {canToggleHours && (
            <AllHoursToggle
              showAllHours={showAllHours}
              configured={configuredHours}
              timeFormat={timeFormat}
              onToggle={toggleAllHours}
            />
          )}
        </div>
        <div className="border-s border-border grid" style={columnsStyle}>
          {days.map((day) => {
            const todayCol = isDisplayToday(day);
            const selected = isSameDay(day, selectedDate);
            const fullLabel = intlFormatter.dateTime(day, { weekday: "long", month: "long", day: "numeric", year: "numeric" });
            return (
              <div
                key={day.toISOString()}
                role="columnheader"
                aria-label={fullLabel}
                data-day={dayKey(day)}
                className="flex flex-col items-center gap-0.5 pt-2 pb-1.5 border-e border-border last:border-e-0"
              >
                <div className={cn(
                  "text-[11px] font-medium uppercase tracking-wide",
                  todayCol ? "text-primary" : "text-muted-foreground",
                )}>
                  {intlFormatter.dateTime(day, { weekday: "short" })}
                </div>
                {/* The date opens that day in the day view. */}
                <button
                  type="button"
                  onClick={() => (onOpenDay ?? onSelectDate)(day)}
                  aria-label={fullLabel}
                  aria-current={todayCol ? "date" : undefined}
                  className={cn(
                    "inline-flex items-center justify-center rounded-full transition-colors touch-manipulation",
                    isMobile ? "w-8 h-8 text-base" : "w-10 h-10 text-xl",
                    todayCol
                      ? "bg-primary text-primary-foreground font-semibold hover:bg-primary/90"
                      : selected
                        ? "bg-accent text-accent-foreground font-medium"
                        : "text-foreground hover:bg-muted",
                  )}
                >
                  {format(day, "d")}
                </button>
              </div>
            );
          })}
        </div>
      </div>
      {hasAllDay && (
        <div className="flex border-b border-border">
          <div
            className={cn(gutterClass, "text-[10px] text-muted-foreground p-1 text-end flex flex-col justify-between")}
            style={{ height: allDayHeight }}
          >
            <span>{t("events.all_day")}</span>
            {isExpandable && (
              <button
                type="button"
                aria-label="all-day-expand"
                aria-expanded={isAllDayExpanded}
                onClick={() => setIsAllDayExpanded((prev) => !prev)}
                className="self-end mt-auto text-[10px] text-muted-foreground hover:text-foreground flex items-center gap-0.5 rounded px-1 py-0.5 hover:bg-muted transition-colors cursor-pointer"
                title={isAllDayExpanded ? t("events.show_less") : t("events.show_more")}
              >
                {isAllDayExpanded ? (
                  <span>▲</span>
                ) : (
                  <>
                    <span>+{maxContentRows - DEFAULT_ALL_DAY_MAX_ROWS}</span>
                    <span>▼</span>
                  </>
                )}
              </button>
            )}
          </div>
          <div
            data-testid="all-day-grid"
            className="relative grid border-s border-border overflow-hidden"
            style={{ ...columnsStyle, height: allDayHeight }}
          >
            {days.map((day) => (
              <div
                key={format(day, "yyyy-MM-dd")}
                className="bg-background min-h-[28px] border-e border-border last:border-e-0"
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
                      currentUserEmails={currentUserEmails}
                    />
                  </div>
                );
              })}
            </div>

            {/* Task chips in all-day area, stacked under events of their day (#1107, #1270) */}
            <div className="absolute inset-0 pointer-events-none">
              {days.map((day, dayIndex) => {
                const key = format(day, "yyyy-MM-dd");
                const dayTasks = tasksByDay.get(key) || [];
                const baseRow = dayEventRows[dayIndex];
                return dayTasks.map((task, taskIndex) => (
                  <div
                    key={`task-${task.id}`}
                    className="absolute px-0.5 pointer-events-auto"
                    style={{
                      left: `calc(${(dayIndex / colCount) * 100}% + 1px)`,
                      width: `calc(${(1 / colCount) * 100}% - 2px)`,
                      top: (baseRow + taskIndex) * 24 + 2,
                      height: 20,
                    }}
                  >
                    <CalendarTaskChip
                      task={task}
                      calendar={calendars.find(c => task.calendarIds[c.id])}
                      onToggleComplete={onToggleTaskComplete}
                      onSelect={onSelectTask}
                    />
                  </div>
                ));
              })}
            </div>
          </div>
        </div>
      )}


      </div>

      <div>
        <div className="flex relative" style={{ height: gridHeight }}>
          <div className={gutterClass}>
            {visibleHours.map((h) => (
              <div
                key={h}
                className="relative text-muted-foreground text-end pe-2"
                style={{ height: HOUR_HEIGHT }}
              >
                {/* Midnight goes unlabelled; a later first hour is labelled
                    inside its row, where the header cannot cover it. */}
                {(h > firstHour || firstHour > 0) && (
                  <span className={cn(
                    "absolute right-2 leading-none",
                    h > firstHour ? "top-0 -translate-y-1/2" : "top-1",
                    isMobile ? "text-[9px]" : "text-[10px]",
                  )}>
                    {formatHour(h)}
                  </span>
                )}
              </div>
            ))}
          </div>

          <div className="border-s border-border relative grid" style={columnsStyle}>
            {days.map((day) => {
              const key = format(day, "yyyy-MM-dd");
              const todayCol = isDisplayToday(day);
              const dayLayout = layoutByDay.get(key);
              const layouted = dayLayout?.layouts ?? [];

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
                  {visibleHours.map((h) => (
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

                  {dayLayout && dayLayout.before > 0 && (
                    <HiddenEventsIndicator
                      count={dayLayout.before}
                      direction="before"
                      onReveal={() => revealMinutes(dayLayout.firstBeforeMinutes ?? 0)}
                    />
                  )}
                  {dayLayout && dayLayout.after > 0 && (
                    <HiddenEventsIndicator
                      count={dayLayout.after}
                      direction="after"
                      onReveal={() => revealMinutes(dayLayout.firstAfterMinutes ?? hours.endMinutes)}
                    />
                  )}

                  {layouted.map(({ event: ev, column, totalColumns, startMinutes, endMinutes }) => {
                    const durMin = Math.max(15, endMinutes - startMinutes);
                    const clip = clipToDisplayHours(startMinutes, endMinutes, hours);
                    const baseHeight = Math.max(20, (Math.max(15, clip.endMinutes - clip.startMinutes) / 60) * HOUR_HEIGHT);
                    // Short events at the bottom edge stay inside the grid.
                    const baseTop = Math.max(0, Math.min(
                      ((clip.startMinutes - hours.startMinutes) / 60) * HOUR_HEIGHT,
                      gridHeight - baseHeight,
                    ));
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
                          currentUserEmails={currentUserEmails}
                          draggable
                        />
                        {/* An edge beyond the visible hours has nothing to grab. */}
                        {!clip.clippedStart && (
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
                        )}
                        {!clip.clippedEnd && (
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
                        )}
                      </div>
                    );
                  })}

                  {todayCol && nowMinutes >= hours.startMinutes && nowMinutes <= hours.endMinutes && (
                    <div
                      className="absolute left-0 right-0 z-20 pointer-events-none"
                      style={{ top: ((nowMinutes - hours.startMinutes) / 60) * HOUR_HEIGHT }}
                    >
                      <div className="flex items-center -translate-y-1/2">
                        <div className="w-3 h-3 rounded-full bg-destructive -ms-1.5 flex-shrink-0" />
                        <div className="flex-1 h-0.5 bg-destructive" />
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
                        top: ((dragCreate.startMinutes - hours.startMinutes) / 60) * HOUR_HEIGHT,
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
                      style={{ top: ((dropTarget.minutes - hours.startMinutes) / 60) * HOUR_HEIGHT }}
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
                      if (startMin + durationMin <= hours.startMinutes || startMin >= hours.endMinutes) return null;
                      const clip = clipToDisplayHours(startMin, startMin + durationMin, hours);
                      const cal = calendars.find(c => c.id === pendingPreview.calendarId);
                      const color = cal?.color || "#3b82f6";
                      // Drawn like a saved event, so the new event shows where
                      // it will land while it is being created.
                      return (
                        <div
                          data-pending-preview
                          className="absolute left-0.5 right-0.5 z-30 rounded-xs pointer-events-none overflow-hidden px-1.5 py-0.5 text-xs shadow-md"
                          style={{
                            top: ((clip.startMinutes - hours.startMinutes) / 60) * HOUR_HEIGHT,
                            height: Math.max(20, ((clip.endMinutes - clip.startMinutes) / 60) * HOUR_HEIGHT),
                            backgroundColor: color,
                            color: readableTextOn(color),
                          }}
                        >
                          <div className="font-medium truncate">
                            {pendingPreview.title}
                          </div>
                          <div className="text-[10.5px] opacity-85 truncate">
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
