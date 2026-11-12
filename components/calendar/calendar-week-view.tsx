"use client";

import { useMemo, useEffect, useLayoutEffect, useRef, useState, useCallback } from "react";
import { useTranslations } from "next-intl";
import { useDisplayDateFormatter } from "@/hooks/use-display-date-formatter";
import {
  startOfWeek, format, isSameDay, eachDayOfInterval,
} from "date-fns";
import { cn } from "@/lib/utils";
import { EventCard, eventFillClass, eventFillStyle } from "./event-card";
import { QuickEventInput } from "./quick-event-input";
import { CalendarTaskChip } from "./task-chip";
import { AllHoursToggle, HiddenEventsIndicator } from "./display-hours-controls";
import { groupTasksByDueDay } from "@/lib/calendar-tasks";
import { buildTimedFullDayWeekSegments, buildWeekSegmentsRaw, formatSnapTime, getEventDayBounds, getPrimaryCalendarId, isTimedEventFullDayOnDate, layoutOverlappingEvents, packWeekSegments, pendingTimedMinutes, PENDING_LAYOUT_ID } from "@/lib/calendar-utils";
import { clipToDisplayHours, indexOfDayOnOrAfter, partitionByDisplayHours, remapSegmentsToShownDays, resolveWorkingDays } from "@/lib/calendar-display-range";
import { displayNow, isDisplayToday } from "@/lib/timezone";
import type { CalendarEvent, Calendar, CalendarTask } from "@/lib/jmap/types";
import { useSettingsStore } from "@/stores/settings-store";
import { useDisplayHours, type RevealTime } from "@/hooks/use-display-hours";
import { useTimeGridFocus } from "@/hooks/use-time-grid-focus";
import { useTimeGridInteractions, type MoveEventHandler } from "@/hooks/use-time-grid-interactions";
import { useScrollWindow, getScrollStart, setScrollStart, scrollToStart } from "@/hooks/use-scroll-window";
import { dayKey, type ScrollWindowViewProps } from "@/lib/calendar-scroll-window";
import type { PendingEventPreview } from "./event-modal";
import { useCalendarErrorMessage } from "@/hooks/use-calendar-error-message";
import { PluginDayLabel } from "./plugin-day-label";
import { useCvdColor } from "@/hooks/use-cvd-color";

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
  /** The "?" / "Reply" marker of an unanswered invitation (pim-9). */
  onReplyEvent?: (anchor: HTMLElement, event: CalendarEvent) => void;
  onCreateAtTime: (date: Date, endDate?: Date) => void;
  /** A click on a day in the all-day row: a new all-day event there. */
  onCreateAllDay?: (date: Date) => void;
  firstDayOfWeek?: number;
  timeFormat?: "12h" | "24h";
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
  /** A time to bring into view, such as a just-saved event's start. */
  revealAt?: RevealTime | null;
}

const MIN_HOUR_HEIGHT = 60;
const HOURS = Array.from({ length: 24 }, (_, i) => i);
const MOBILE_COL_WIDTH = 120;
/**
 * A pane narrower than this shows three days a page, unless the user asked
 * for the whole week: seven columns there turned overlapping events into
 * 30px slivers (pim-p3-13).
 */
const COMPACT_WEEK_BELOW = 1000;
const COMPACT_WEEK_DAYS = 3;
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
  onReplyEvent,
  onCreateAtTime,
  onCreateAllDay,
  firstDayOfWeek = 1,
  timeFormat = "24h",
  isMobile,
  pendingPreview,
  tasks,
  onToggleTaskComplete,
  onSelectTask,
  currentUserEmails,
  canEditEvent = () => true,
  selectedEventId,
  onMoveEvent,
  revealAt,
}: CalendarWeekViewProps) {
  const t = useTranslations("calendar");
  const tCal = useTranslations("ux_p3_pim_cal");
  const paint = useCvdColor();
  const tintedEvents = useSettingsStore((s) => s.calendarTintedEvents);
  const describeError = useCalendarErrorMessage();
  // Grid days / event dates are display dates (local fields = wall-clock in
  // the user's zone); the app-wide formatter would shift them again (#755).
  const intlFormatter = useDisplayDateFormatter();
  // One scroll container for both axes (#759): the strip scrolls sideways,
  // the hours scroll down, and the sticky header rows and hour gutter stay
  // put. (A nested vertical scroller would capture the gutter's stickiness.)
  const rootRef = useRef<HTMLDivElement>(null);
  // The sticky date header (and all-day row): the hour rows fill what is left.
  const headerRef = useRef<HTMLDivElement>(null);
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
  const allDaysWhenNarrow = useSettingsStore((s) => s.calendarNarrowWeekAllDays);
  const [viewportWidth, setViewportWidth] = useState(0);
  // A narrow pane (not a phone, which has its own strip): three days a page.
  const narrowPane = !isMobile && viewportWidth > 0 && viewportWidth + gutterWidth < COMPACT_WEEK_BELOW;
  const canCompact = narrowPane && columnsPerWeek > COMPACT_WEEK_DAYS;
  const compact = canCompact && !allDaysWhenNarrow;
  const columnsPerPage = compact ? COMPACT_WEEK_DAYS : columnsPerWeek;

  const measureColWidth = useCallback((root: HTMLElement | null) => {
    if (isMobile || !root) return MOBILE_COL_WIDTH;
    const perPage = !allDaysWhenNarrow && root.clientWidth < COMPACT_WEEK_BELOW && columnsPerWeek > COMPACT_WEEK_DAYS ? COMPACT_WEEK_DAYS : columnsPerWeek;
    // Not rounded down: the pixels left over showed a sliver of next Monday at the edge.
    return Math.max(MIN_COL_WIDTH, (root.clientWidth - gutterWidth) / perPage);
  }, [isMobile, gutterWidth, columnsPerWeek, allDaysWhenNarrow]);
  const [colWidth, setColWidth] = useState(MOBILE_COL_WIDTH);
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
    hours, hourHeight, canToggle: canToggleHours, configured: configuredHours, showAllHours, toggleAllHours, revealMinutes,
  } = useDisplayHours({ scrollRef: rootRef, headerRef, minHourHeight: MIN_HOUR_HEIGHT, revealAt });
  const firstHour = hours.startMinutes / 60;
  const visibleHours = HOURS.slice(firstHour, hours.endMinutes / 60);
  const gridHeight = visibleHours.length * hourHeight;

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

  // The new event being created takes a column beside the events it
  // overlaps, as it will once saved, instead of covering them. Only its
  // times count: typing its title doesn't redo the layout.
  const pendingStartMs = pendingPreview && !pendingPreview.allDay ? pendingPreview.start.getTime() : null;
  const pendingEndMs = pendingPreview && !pendingPreview.allDay ? pendingPreview.end.getTime() : null;
  const pendingLayout = useMemo(() => {
    if (pendingStartMs === null || pendingEndMs === null) return null;
    const preview = { start: new Date(pendingStartMs), end: new Date(pendingEndMs) };
    const day = days.find((d) => isSameDay(d, preview.start));
    const bounds = day ? pendingTimedMinutes(preview, day) : null;
    if (!day || !bounds) return null;
    const key = format(day, "yyyy-MM-dd");
    const partition = partitionByDisplayHours(timedEvents.get(key) || [], day, hours);
    const all = layoutOverlappingEvents(partition.visible, day, bounds);
    const pending = all.find((layout) => layout.event.id === PENDING_LAYOUT_ID);
    if (!pending) return null;
    return { key, layouts: all.filter((layout) => layout.event.id !== PENDING_LAYOUT_ID), pending };
  }, [pendingStartMs, pendingEndMs, days, timedEvents, hours]);

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

  const weekRange = useMemo(() => {
    if (!days.length) return undefined;
    return {
      start: days[0],
      end: days[days.length - 1],
    };
  }, [days]);

  const tasksByDay = useMemo(() => groupTasksByDueDay(tasks, weekRange), [tasks, weekRange]);

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
    const target = isMobile || compact ? focus.date : startOfWeek(focus.date, { weekStartsOn: weekStart });
    return indexOfDayOnOrAfter(days, target);
  }, [visibleDayKey, days, isMobile, compact, focus.date, weekStart]);
  const visibleColumns = isMobile ? Math.max(1, Math.ceil(viewportWidth / colWidth)) : columnsPerPage;

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
    // Three days a page start at the focused day, as on a phone.
    const target = isMobile || compact ? focus.date : startOfWeek(focus.date, { weekStartsOn: weekStart });
    setScrollStart(root, "horizontal", indexOfDayOnOrAfter(days, target) * colWidth);
  }, [focus.date, isMobile, compact, weekStart, days, colWidth]);

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
    dragCreate, handleGridPointerDown, handleGridPointerMove, handleGridPointerUp, handleGridPointerCancel,
    resizeVisual, handleResizePointerDown, handleResizePointerMove, handleResizePointerUp,
    quickCreate, handleSlotClick, handleSlotDoubleClick, handleQuickCreateSubmit, handleQuickCreateCancel,
    dropTarget, handleColumnDragOver, handleColumnDragLeave, handleColumnDrop,
  } = useTimeGridInteractions({
    hourHeight,
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
    describeError,
    currentUserEmails,
    isMobile,
    onMoveEvent,
  });

  // The days in view. Tab stays in them: events of the weeks loaded on
  // either side are out of the tab order, or Tab walked into them and
  // scrolled the grid off its week.
  const inViewKeys = useMemo(
    () => new Set(days.slice(visibleStartIndex, visibleStartIndex + visibleColumns).map(dayKey)),
    [days, visibleStartIndex, visibleColumns],
  );
  const isInView = useCallback((key: string) => inViewKeys.has(key), [inViewKeys]);
  const spanInView = (startIndex: number, span: number) =>
    startIndex < visibleStartIndex + visibleColumns && startIndex + span > visibleStartIndex;

  const { slotProps, tabStopDayKey } = useTimeGridFocus({
    rootRef,
    headerRef,
    gutterWidth,
    days,
    hours,
    selectedDate,
    onCreate: onCreateAtTime,
    isInView,
  });

  const formatHour = (h: number): string => {
    if (timeFormat === "12h") {
      const d = new Date(2000, 0, 1, h);
      return intlFormatter.dateTime(d, { hour: "numeric", minute: "2-digit", hour12: true });
    }
    return format(new Date(2000, 0, 1, h), "HH:mm");
  };
  // A slot is read out with its whole date: "Wednesday, October 28, 10:00".
  const slotDateLabel = (day: Date) => intlFormatter.dateTime(day, { weekday: "long", month: "long", day: "numeric" });

  // Above every in-column overlay (events z-10, handles z-20, drag z-30) so
  // columns scrolled past the start do not show through the gutter.
  const gutterClass = cn("flex-shrink-0 sticky start-0 z-40 bg-background", isMobile ? "w-10" : "w-14");

  return (
    <div
      ref={rootRef}
      className="flex min-h-0 min-w-0 flex-col flex-1 overflow-auto [overflow-anchor:none] max-md:pb-20"
      onScroll={handleStripScroll}
      role="grid"
      aria-label={t("views.week")}
    >
      <div className="relative flex flex-col" style={{ width: stripWidth, minWidth: stripWidth }}>
      <div ref={startSentinelRef} data-testid="week-start-sentinel" className="absolute inset-y-0 start-0 w-px pointer-events-none" />
      <div ref={endSentinelRef} data-testid="week-end-sentinel" className="absolute inset-y-0 end-0 w-px pointer-events-none" />
      <div ref={headerRef} className="sticky top-0 z-50 bg-background">
      {/* The grid (SR-14): a header row with one column per day, an all-day
          row and an hours row, each with one cell per day. The events sit in
          their day's cell, so a screen reader reads them under the date. */}
      <div className="flex border-b border-border" role="row">
        <div role="gridcell" className={cn(gutterClass, "flex flex-col items-center justify-end gap-1 pb-1")}>
          {canCompact ? (
            <button
              type="button"
              data-week-days-toggle
              onClick={() => useSettingsStore.getState().updateSetting("calendarNarrowWeekAllDays", !allDaysWhenNarrow)}
              aria-pressed={!compact}
              aria-label={tCal("week_all_days")}
              title={tCal("week_all_days")}
              className={cn("rounded-xs px-1 text-[0.625rem] font-medium hover:bg-muted hover:text-foreground", compact ? "text-muted-foreground" : "bg-muted text-foreground")}
            >
              {tCal("week_days_short", { count: columnsPerWeek })}
            </button>
          ) : null}
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
                  "text-[0.6875rem] font-medium first-letter:uppercase",
                  todayCol ? "text-primary" : "text-muted-foreground",
                )}>
                  {intlFormatter.dateTime(day, { weekday: "short" })}
                </div>
                {/* The date opens that day in the day view. */}
                <button
                  type="button"
                  onClick={() => (onOpenDay ?? onSelectDate)(day)}
                  // One date in the tab order, not every loaded day's.
                  tabIndex={dayKey(day) === tabStopDayKey ? 0 : -1}
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
                <PluginDayLabel surface="calendar-day-header" date={dayKey(day)} className="w-full px-1 text-center" />
              </div>
            );
          })}
        </div>
      </div>
      {hasAllDay && (
        <div className="flex border-b border-border" role="row">
          <div
            role="rowheader"
            className={cn(gutterClass, "text-[0.625rem] text-muted-foreground p-1 text-end flex flex-col justify-between")}
            style={{ height: allDayHeight }}
          >
            {/* A long single word ("Ganztägig") must stay inside the narrow gutter of a phone. */}
            <span className="hyphens-auto [overflow-wrap:anywhere]">{t("events.all_day")}</span>
            {isExpandable && (
              <button
                type="button"
                aria-label={isAllDayExpanded ? t("events.show_less") : t("events.show_more")}
                aria-expanded={isAllDayExpanded}
                onClick={() => setIsAllDayExpanded((prev) => !prev)}
                className="self-end mt-auto text-[0.625rem] text-muted-foreground hover:text-foreground flex items-center gap-0.5 rounded px-1 py-0.5 hover:bg-muted transition-colors cursor-pointer"
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
            {days.map((day, dayIndex) => {
              const key = format(day, "yyyy-MM-dd");
              const dayTasks = tasksByDay.get(key) || [];
              const baseRow = dayEventRows[dayIndex];
              const showPreview = pendingPreview?.allDay && isSameDay(pendingPreview.start, day);
              const previewColor = showPreview
                ? paint(calendars.find((c) => c.id === pendingPreview!.calendarId)?.color || "#3b82f6")
                : "";
              return (
                <div
                  key={key}
                  role="gridcell"
                  className={cn("relative bg-background min-h-[28px] border-e border-border last:border-e-0", onCreateAllDay && "cursor-pointer hover:bg-muted/30")}
                  onClick={onCreateAllDay ? () => onCreateAllDay(day) : undefined}
                  onContextMenu={onContextMenuEmpty ? (e) => onContextMenuEmpty(e, day, undefined, true) : undefined}
                >
                  {/* Events starting on this day, drawn across the days they span. */}
                  {allDaySegments.filter((segment) => segment.startIndex === dayIndex).map((segment) => {
                    const calId = getPrimaryCalendarId(segment.event);
                    return (
                      <div
                        key={`${segment.event.id}-${segment.startIndex}-${segment.row}`}
                        className="absolute z-10 px-0.5"
                        style={{
                          insetInlineStart: 1,
                          width: `calc(${segment.span * 100}% + ${segment.span - 2}px)`,
                          top: segment.row * 24 + 2,
                          height: 20,
                        }}
                        onClick={(e) => e.stopPropagation()}
                        onContextMenu={(e) => e.stopPropagation()}
                      >
                        <EventCard
                          event={segment.event}
                          isSelected={segment.event.id === selectedEventId}
                          calendar={calId ? calendarMap.get(calId) : undefined}
                          variant="span"
                          continuesBefore={segment.continuesBefore}
                          continuesAfter={segment.continuesAfter}
                          onClick={(rect) => onSelectEvent(segment.event, rect)}
                          onMouseEnter={(rect) => onHoverEvent?.(segment.event, rect)}
                          onMouseLeave={onHoverLeave}
                          onContextMenu={onContextMenuEvent}
                          onReply={onReplyEvent}
                          currentUserEmails={currentUserEmails}
                          tabbable={spanInView(segment.startIndex, segment.span)}
                        />
                      </div>
                    );
                  })}

                  {showPreview && (
                    <div
                      data-pending-preview
                      className="absolute z-10 px-0.5 pointer-events-none"
                      style={{ insetInlineStart: 1, width: "calc(100% - 2px)", top: baseRow * 24 + 2, height: 20 }}
                    >
                      <div
                        className="h-full rounded-xs px-1.5 text-xs leading-[1rem] font-medium truncate border-2 border-dashed"
                        style={{ borderColor: previewColor, color: previewColor, backgroundColor: `${previewColor}10` }}
                      >
                        {pendingPreview!.title}
                      </div>
                    </div>
                  )}

                  {/* Task chips, stacked under the events of their day (#1107, #1270) */}
                  {dayTasks.map((task, taskIndex) => (
                    <div
                      key={`task-${task.id}-${task.due ?? dayIndex}`}
                      className="absolute z-10 px-0.5"
                      style={{ insetInlineStart: 1, width: "calc(100% - 2px)", top: (baseRow + taskIndex) * 24 + 2, height: 20 }}
                      onClick={(e) => e.stopPropagation()}
                      onContextMenu={(e) => e.stopPropagation()}
                    >
                      <CalendarTaskChip
                        task={task}
                        calendar={calendars.find(c => task.calendarIds[c.id])}
                        onToggleComplete={onToggleTaskComplete}
                        onSelect={onSelectTask}
                        tabbable={inViewKeys.has(key)}
                      />
                    </div>
                  ))}
                </div>
              );
            })}
          </div>
        </div>
      )}


      </div>

      <div>
        <div className="flex relative" style={{ height: gridHeight }} role="row">
          <div role="gridcell" className={gutterClass}>
            {visibleHours.map((h) => (
              <div
                key={h}
                className="relative text-muted-foreground text-end pe-2"
                style={{ height: hourHeight }}
              >
                {/* Midnight goes unlabelled; a later first hour is labelled
                    inside its row, where the header cannot cover it. */}
                {(h > firstHour || firstHour > 0) && (
                  <span aria-hidden="true" className={cn(
                    "absolute end-2 leading-none",
                    h > firstHour ? "top-0 -translate-y-1/2" : "top-1",
                    isMobile ? "text-[0.5625rem]" : "text-[0.625rem]",
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
              const layouted = (pendingLayout?.key === key ? pendingLayout.layouts : dayLayout?.layouts) ?? [];

              return (
                <div
                  key={key}
                  className="relative border-e border-border last:border-e-0"
                  role="gridcell"
                  data-time-column={key}
                  onPointerDown={(e) => handleGridPointerDown(e, key, day)}
                  onPointerMove={handleGridPointerMove}
                  onPointerUp={handleGridPointerUp}
                  onPointerCancel={handleGridPointerCancel}
                  onDragOver={(e) => handleColumnDragOver(e, key)}
                  onDragLeave={handleColumnDragLeave}
                  onDrop={(e) => handleColumnDrop(e, day)}
                >
                  {dayLayout && dayLayout.before > 0 && (
                    <HiddenEventsIndicator
                      count={dayLayout.before}
                      direction="before"
                      onReveal={() => revealMinutes(dayLayout.firstBeforeMinutes ?? 0)}
                      tabbable={inViewKeys.has(key)}
                    />
                  )}
                  {dayLayout && dayLayout.after > 0 && (
                    <HiddenEventsIndicator
                      count={dayLayout.after}
                      direction="after"
                      onReveal={() => revealMinutes(dayLayout.firstAfterMinutes ?? hours.endMinutes)}
                      tabbable={inViewKeys.has(key)}
                    />
                  )}

                  {layouted.map(({ event: ev, column, totalColumns, startMinutes, endMinutes }) => {
                    const durMin = Math.max(15, endMinutes - startMinutes);
                    const clip = clipToDisplayHours(startMinutes, endMinutes, hours);
                    const baseHeight = Math.max(20, (Math.max(15, clip.endMinutes - clip.startMinutes) / 60) * hourHeight);
                    // Short events at the bottom edge stay inside the grid.
                    const baseTop = Math.max(0, Math.min(
                      ((clip.startMinutes - hours.startMinutes) / 60) * hourHeight,
                      gridHeight - baseHeight,
                    ));
                    const isResizing = resizeVisual?.eventId === ev.id;
                    const editable = canEditEvent(ev);
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
                        style={{ top, height, insetInlineStart: `${leftPct}%`, width: `${widthPct}%`, paddingInline: 1 }}
                      >
                        <EventCard
                          event={ev}
                            isSelected={ev.id === selectedEventId}
                          calendar={calId ? calendarMap.get(calId) : undefined}
                          variant="block"
                          onClick={(rect) => onSelectEvent(ev, rect)}
                          onMouseEnter={(rect) => onHoverEvent?.(ev, rect)}
                          onMouseLeave={onHoverLeave}
                          onContextMenu={onContextMenuEvent}
                          onReply={onReplyEvent}
                          currentUserEmails={currentUserEmails}
                          draggable={editable}
                          continuesBefore={clip.clippedStart}
                          continuesAfter={clip.clippedEnd}
                          tabbable={inViewKeys.has(key)}
                        />
                        {/* An edge beyond the visible hours has nothing to grab. */}
                        {editable && !clip.clippedStart && (
                        <div
                          data-resize-handle
                          className="absolute top-0 inset-x-1 h-1 cursor-n-resize z-20 flex items-start justify-center opacity-0 group-hover/event:opacity-100 transition-opacity"
                          aria-hidden="true"
                          onPointerDown={(e) => handleResizePointerDown(ev.id, "top", startMinutes, durMin, e)}
                          onPointerMove={handleResizePointerMove}
                          onPointerUp={handleResizePointerUp}
                        >
                          <div className="w-8 h-0.5 rounded-full bg-foreground/30" />
                        </div>
                        )}
                        {editable && !clip.clippedEnd && (
                        <div
                          data-resize-handle
                          className="absolute bottom-0 inset-x-1 h-1 cursor-s-resize z-20 flex items-end justify-center opacity-0 group-hover/event:opacity-100 transition-opacity"
                          aria-hidden="true"
                          onPointerDown={(e) => handleResizePointerDown(ev.id, "bottom", startMinutes, durMin, e)}
                          onPointerMove={handleResizePointerMove}
                          onPointerUp={handleResizePointerUp}
                        >
                          <div className="w-8 h-0.5 rounded-full bg-foreground/30" />
                        </div>
                        )}
                      </div>
                    );
                  })}

                  {/* An empty hour: Enter or a click creates an event there. */}
                  {visibleHours.map((h) => (
                    <div
                      key={h}
                      role="button"
                      aria-label={`${slotDateLabel(day)}, ${formatHour(h)}`}
                      {...slotProps(day, h, !isMobile)}
                      onClick={() => handleSlotClick(day, h)}
                      onDoubleClick={() => handleSlotDoubleClick(day, h)}
                      onContextMenu={onContextMenuEmpty ? (e) => onContextMenuEmpty(e, day, h, false) : undefined}
                      className="relative border-b border-border/50 hover:bg-muted/30 cursor-pointer transition-colors outline-none focus-visible:after:absolute focus-visible:after:inset-0 focus-visible:after:z-[15] focus-visible:after:pointer-events-none focus-visible:after:ring-2 focus-visible:after:ring-inset focus-visible:after:ring-primary"
                      style={{ height: hourHeight }}
                    />
                  ))}

                  {todayCol && nowMinutes >= hours.startMinutes && nowMinutes <= hours.endMinutes && (
                    <div
                      className="absolute left-0 right-0 z-20 pointer-events-none"
                      style={{ top: ((nowMinutes - hours.startMinutes) / 60) * hourHeight }}
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
                      data-drag-selection
                      // Opaque and above the events (z-10), which showed through a see-through fill.
                      className="absolute left-1 right-1 z-30 rounded-md pointer-events-none border-2 border-primary/60 border-dashed"
                      style={{
                        backgroundColor: "color-mix(in srgb, var(--color-primary) 15%, var(--color-background))",
                        top: ((dragCreate.startMinutes - hours.startMinutes) / 60) * hourHeight,
                        height: ((dragCreate.endMinutes - dragCreate.startMinutes) / 60) * hourHeight,
                      }}
                    >
                      <div className="text-[0.625rem] font-medium text-primary px-1.5 py-0.5">
                        <bdi dir="ltr">{formatSnapTime(dragCreate.startMinutes, timeFormat)} – {formatSnapTime(dragCreate.endMinutes, timeFormat)}</bdi>
                      </div>
                    </div>
                  )}

                  {dropTarget?.dayKey === key && dropTarget.durationMinutes !== undefined && (
                    // The event itself where it will land, as the drag-create selection is drawn (pim-p3-2).
                    <div
                      data-drop-ghost
                      className="absolute left-1 right-1 z-30 rounded-md pointer-events-none border-2 border-primary/60 border-dashed"
                      style={{
                        backgroundColor: "color-mix(in srgb, var(--color-primary) 15%, var(--color-background))",
                        top: ((dropTarget.minutes - hours.startMinutes) / 60) * hourHeight,
                        height: (dropTarget.durationMinutes / 60) * hourHeight,
                      }}
                    />
                  )}

                  {dropTarget?.dayKey === key && (
                    <div
                      className="absolute left-0 right-0 z-30 pointer-events-none"
                      style={{ top: ((dropTarget.minutes - hours.startMinutes) / 60) * hourHeight }}
                    >
                      <div className="flex items-center">
                        <div className="w-2 h-2 rounded-full bg-primary -ms-1" />
                        <div className="flex-1 h-0.5 bg-primary rounded-full" />
                      </div>
                      <div className="absolute -top-4 start-2 text-[0.625rem] font-medium text-primary bg-background/90 px-1 rounded shadow-sm">
                        <bdi dir="ltr">{formatSnapTime(dropTarget.minutes, timeFormat)}{dropTarget.durationMinutes !== undefined && ` – ${formatSnapTime((dropTarget.minutes + dropTarget.durationMinutes) % 1440, timeFormat)}`}</bdi>
                      </div>
                    </div>
                  )}

                  {pendingPreview && pendingLayout?.key === key && (
                    (() => {
                      const { startMinutes: startMin, endMinutes: endMin, column, totalColumns } = pendingLayout.pending;
                      if (endMin <= hours.startMinutes || startMin >= hours.endMinutes) return null;
                      const clip = clipToDisplayHours(startMin, endMin, hours);
                      const cal = calendars.find(c => c.id === pendingPreview.calendarId);
                      const color = paint(cal?.color || "#3b82f6");
                      // Drawn like a saved event, in the column it will take, so the new
                      // event shows where it will land while it is being created.
                      return (
                        <div
                          className="absolute z-30 pointer-events-none"
                          style={{
                            top: ((clip.startMinutes - hours.startMinutes) / 60) * hourHeight,
                            height: Math.max(20, ((clip.endMinutes - clip.startMinutes) / 60) * hourHeight),
                            insetInlineStart: `${(column / totalColumns) * 100}%`,
                            width: `${(1 / totalColumns) * 100}%`,
                            paddingInline: 2,
                          }}
                        >
                          <div
                            data-pending-preview
                            className={cn("h-full rounded-xs overflow-hidden px-1.5 py-0.5 text-xs shadow-md", eventFillClass(tintedEvents, false))}
                            style={eventFillStyle(color, { inactive: false, tinted: tintedEvents })}
                          >
                            <div className="font-medium truncate">
                              {pendingPreview.title}
                            </div>
                            <div className="text-[0.65625rem] opacity-85 truncate">
                              <bdi dir="ltr">{formatSnapTime(startMin, timeFormat)} – {formatSnapTime(endMin, timeFormat)}</bdi>
                            </div>
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
