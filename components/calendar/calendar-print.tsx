"use client";

import { useMemo, type CSSProperties } from "react";
import { useLocale, useTranslations } from "next-intl";
import { addDays, format, isSameDay, parseISO } from "date-fns";
import type { Calendar, CalendarEvent, CalendarTask } from "@/lib/jmap/types";
import type { CalendarViewMode } from "@/stores/calendar-store";
import { useSettingsStore } from "@/stores/settings-store";
import { useCalendarLocale } from "@/hooks/use-calendar-locale";
import { useDisplayDateFormatter } from "@/hooks/use-display-date-formatter";
import { useFormatEventDate } from "@/hooks/use-format-event-date";
import { useContactNameResolver } from "@/hooks/use-contact-name-resolver";
import { PrintRoot } from "@/components/print/print-root";
import { getEventColor } from "./event-card";
import { buildRecurrenceSummary } from "./recurrence-editor";
import { formatEventAlertsLabel } from "./alert-list-editor";
import { STATUS_LABEL } from "./rsvp-buttons";
import { filterTasksForList } from "./task-list-view";
import {
  buildTimedFullDayWeekSegments,
  buildWeekSegments,
  buildWeekSegmentsRaw,
  getEventDisplayEndDate,
  getEventEndDate,
  getEventStartDate,
  getPrimaryCalendarId,
  getTimedEventBoundsForDay,
  isTimedEventFullDayOnDate,
  layoutOverlappingEvents,
  packWeekSegments,
} from "@/lib/calendar-utils";
import { formatDisplayHour, remapSegmentsToShownDays, resolveDisplayHours, resolveWorkingDays, type DisplayHours } from "@/lib/calendar-display-range";
import { groupTasksByDueDay } from "@/lib/calendar-tasks";
import { eventOrganizer, getParticipantList, isDeclinedByUser } from "@/lib/calendar-participants";
import { findMeetingLink, primaryLocationName } from "@/lib/event-links";
import { descriptionAsText } from "@/lib/calendar-description";
import {
  PRINT_LANE_MM,
  PRINT_PAGE_HEIGHT_MM,
  formatPrintTimeZone,
  isCompactTimeBlock,
  groupEventsByDay,
  layoutMonthWeekForPrint,
  monthCellCapacity,
  printHourRange,
  type AgendaDay,
} from "@/lib/calendar-print";
import type { TaskViewFilter } from "@/stores/task-store";
import { useCollectionNames } from "@/hooks/use-collection-names";

type TimeFormat = "12h" | "24h";

/** What the calendar page prints: its current view, or one event. */
export type CalendarPrintContent =
  | { kind: "view" }
  | { kind: "event"; event: CalendarEvent };

export interface CalendarPrintProps {
  content: CalendarPrintContent;
  viewMode: CalendarViewMode;
  /** The month, or day, on screen (the title's date). */
  periodDate: Date;
  /** The first day of the week on screen. */
  weekStart: Date;
  /** The loaded window: what the agenda prints. */
  rangeStart: Date;
  rangeEnd: Date;
  events: CalendarEvent[];
  calendars: Calendar[];
  /** The calendars that are switched on, named in the header. */
  shownCalendars: Calendar[];
  /** Tasks drawn on the grids, when the user shows them there. */
  gridTasks?: CalendarTask[];
  /** The task list's tasks and filter. */
  tasks: CalendarTask[];
  taskFilter: TaskViewFilter;
  selectedCalendarIds: string[];
  timeFormat: TimeFormat;
  timeZone: string;
  currentUserEmails: string[];
  /** A search in progress replaces the view on screen, and so on paper. */
  search?: { query: string; events: CalendarEvent[] } | null;
}

function chipStyle(color: string): CSSProperties {
  return { "--chip": color } as CSSProperties;
}

function useTimeFormatter(timeFormat: TimeFormat) {
  const intlFormatter = useDisplayDateFormatter();
  return (date: Date) => timeFormat === "12h"
    ? intlFormatter.dateTime(date, { hour: "numeric", minute: "2-digit", hour12: true })
    : format(date, "HH:mm");
}

/** The calendar page's print copy. */
export function CalendarPrint(props: CalendarPrintProps) {
  const shownName = useCollectionNames();
  const t = useTranslations("calendar");
  const locale = useLocale();
  const { formatMonthYear, formatWeekRange, formatFullDate } = useCalendarLocale();
  const { content, viewMode } = props;

  const calendarMap = useMemo(() => new Map(props.calendars.map((c) => [c.id, c])), [props.calendars]);

  if (content.kind === "event") {
    const calId = getPrimaryCalendarId(content.event);
    return (
      <PrintRoot orientation="portrait" title={content.event.title || t("events.no_title")}>
        <EventPrintSheet
          event={content.event}
          calendar={calId ? calendarMap.get(calId) : undefined}
          timeFormat={props.timeFormat}
          timeZone={props.timeZone}
        />
      </PrintRoot>
    );
  }

  const meta = (
    <p className="pr-meta">
      {props.shownCalendars.length > 0 && (
        <span>{t("print.calendars", { names: props.shownCalendars.map((c) => shownName.calendar(c)).join(", ") })}</span>
      )}
      {props.shownCalendars.length > 0 && <span className="pr-meta-sep" aria-hidden>·</span>}
      <span>{t("print.time_zone", { zone: formatPrintTimeZone(props.timeZone, locale, props.periodDate) })}</span>
    </p>
  );
  const header = (title: string) => (
    <header className="pr-header">
      <h1 className="pr-title">{title}</h1>
      {meta}
    </header>
  );

  if (props.search) {
    const title = t("print.search", { query: props.search.query });
    return (
      <PrintRoot orientation="portrait" title={title}>
        {header(title)}
        <AgendaPrint
          days={groupEventsByDay(props.search.events)}
          calendarMap={calendarMap}
          timeFormat={props.timeFormat}
          currentUserEmails={props.currentUserEmails}
        />
      </PrintRoot>
    );
  }

  switch (viewMode) {
    case "month": {
      const title = formatMonthYear(props.periodDate);
      return (
        <PrintRoot orientation="landscape" title={title}>
          <div className="pr-page">
            {header(title)}
            <MonthPrint {...props} calendarMap={calendarMap} />
          </div>
        </PrintRoot>
      );
    }
    case "week": {
      const title = formatWeekRange(props.weekStart);
      return (
        <PrintRoot orientation="landscape" title={title}>
          <div className="pr-page">
            {header(title)}
            <WeekPrint {...props} calendarMap={calendarMap} />
          </div>
        </PrintRoot>
      );
    }
    case "day": {
      const title = formatFullDate(props.periodDate);
      return (
        <PrintRoot orientation="portrait" title={title}>
          <div className="pr-page">
            {header(title)}
            <TimeGridPrint
              pageHeightMm={PRINT_PAGE_HEIGHT_MM.portrait}
              days={[props.periodDate]}
              allDays={[props.periodDate]}
              shownIndexByDay={null}
              events={props.events}
              tasks={props.gridTasks}
              calendarMap={calendarMap}
              timeFormat={props.timeFormat}
              currentUserEmails={props.currentUserEmails}
            />
          </div>
        </PrintRoot>
      );
    }
    case "agenda": {
      const title = new Intl.DateTimeFormat(locale, { day: "numeric", month: "long", year: "numeric" })
        .formatRange(props.rangeStart, props.rangeEnd);
      return (
        <PrintRoot orientation="portrait" title={title}>
          {header(title)}
          <AgendaPrint
            days={groupEventsByDay(props.events, { start: props.rangeStart, end: props.rangeEnd })}
            calendarMap={calendarMap}
            timeFormat={props.timeFormat}
            currentUserEmails={props.currentUserEmails}
          />
        </PrintRoot>
      );
    }
    case "tasks": {
      const title = t("views.tasks");
      return (
        <PrintRoot orientation="portrait" title={title}>
          {header(title)}
          <TaskListPrint
            tasks={filterTasksForList(props.tasks, props.selectedCalendarIds, props.taskFilter)}
            calendars={props.calendars}
            timeFormat={props.timeFormat}
          />
        </PrintRoot>
      );
    }
  }
}

// ---- Month ------------------------------------------------------------------

function MonthPrint({
  periodDate, events, gridTasks, timeFormat, currentUserEmails, calendarMap,
}: CalendarPrintProps & { calendarMap: Map<string, Calendar> }) {
  const t = useTranslations("calendar");
  const { getMonthGridDays, dayHeaderKeys, checkIsSameMonth, formatDayNumber, getMonth, monthLabelKeys } = useCalendarLocale();
  const formatTime = useTimeFormatter(timeFormat);

  const gridDays = getMonthGridDays(periodDate);
  const weeks: Date[][] = [];
  for (let i = 0; i + 7 <= gridDays.length; i += 7) weeks.push(gridDays.slice(i, i + 7));
  const tasksByDate = useMemo(() => groupTasksByDueDay(gridTasks), [gridTasks]);
  const capacity = monthCellCapacity(weeks.length, "landscape");
  const columns = { gridTemplateColumns: "repeat(7, minmax(0, 1fr))" };

  return (
    <div className="pr-month">
      <div className="pr-weekdays" style={columns}>
        {dayHeaderKeys.map((d) => <div key={d} className="pr-weekday">{t(`days.${d}`)}</div>)}
      </div>
      {weeks.map((week) => {
        const segments = buildWeekSegments(events, week);
        const dayTasks = week.map((day) => tasksByDate.get(format(day, "yyyy-MM-dd")) ?? []);
        const layout = layoutMonthWeekForPrint(segments, dayTasks, capacity);
        const place = (startIndex: number, span: number, lane: number): CSSProperties => ({
          insetInlineStart: `${(startIndex / 7) * 100}%`,
          width: `${(span / 7) * 100}%`,
          top: `${lane * PRINT_LANE_MM}mm`,
        });
        return (
          <div key={format(week[0], "yyyy-MM-dd")} className="pr-month-week" style={columns}>
            {week.map((day, index) => {
              const inMonth = checkIsSameMonth(day, periodDate);
              const previous = index > 0 ? week[index - 1] : addDays(day, -1);
              const firstOfMonth = !checkIsSameMonth(day, previous);
              return (
                <div key={index} className={`pr-month-day${inMonth ? "" : " is-outside"}`}>
                  <div className="pr-day-num">
                    {firstOfMonth && <span className="pr-day-month">{t(`months.${monthLabelKeys[getMonth(day)]}`)}</span>}
                    {formatDayNumber(day)}
                  </div>
                </div>
              );
            })}
            <div className="pr-lanes">
              {layout.chips.map((chip) => (
                <div
                  key={chip.key}
                  className="pr-lane-item"
                  style={place(chip.startIndex, chip.span, chip.lane)}
                >
                  {chip.item.kind === "event" ? (
                    <EventChip
                      event={chip.item.event}
                      calendar={calendarMap.get(getPrimaryCalendarId(chip.item.event) ?? "")}
                      time={!chip.item.event.showWithoutTime && !chip.continuesBefore && chip.span === 1
                        ? formatTime(getEventStartDate(chip.item.event))
                        : null}
                      filled={chip.item.event.showWithoutTime || chip.span > 1 || chip.continuesBefore || chip.continuesAfter}
                      continuesBefore={chip.continuesBefore}
                      continuesAfter={chip.continuesAfter}
                      currentUserEmails={currentUserEmails}
                    />
                  ) : (
                    <TaskChip task={chip.item.task} calendarMap={calendarMap} />
                  )}
                </div>
              ))}
              {layout.more.map((more) => (
                <div
                  key={`more-${more.dayIndex}`}
                  className="pr-lane-item pr-more"
                  style={place(more.dayIndex, 1, more.lane)}
                >
                  {t("events.more", { count: more.count })}
                </div>
              ))}
            </div>
          </div>
        );
      })}
    </div>
  );
}

function EventChip({
  event, calendar, time, filled, continuesBefore, continuesAfter, currentUserEmails, where,
}: {
  event: CalendarEvent;
  calendar?: Calendar;
  time: string | null;
  /** Tinted with the calendar colour: all-day entries and time-grid blocks. A month's timed entries only get the bar. */
  filled: boolean;
  continuesBefore?: boolean;
  continuesAfter?: boolean;
  currentUserEmails: string[];
  where?: string;
}) {
  const t = useTranslations("calendar");
  const cancelled = event.status === "cancelled";
  const inactive = cancelled || isDeclinedByUser(event, currentUserEmails);
  const classes = [
    "pr-chip",
    filled ? "" : "is-timed",
    inactive ? "is-inactive" : "",
    cancelled ? "is-cancelled" : "",
    continuesBefore ? "continues-before" : "",
    continuesAfter ? "continues-after" : "",
  ].filter(Boolean).join(" ");
  return (
    <span className={classes} style={chipStyle(getEventColor(event, calendar))}>
      {time && <bdi dir="ltr" className="pr-chip-time">{time}</bdi>}
      <bdi className="pr-chip-title">{event.title || t("events.no_title")}</bdi>
      {where && <span className="pr-chip-where">{where}</span>}
    </span>
  );
}

function TaskChip({ task, calendarMap }: { task: CalendarTask; calendarMap: Map<string, Calendar> }) {
  const t = useTranslations("calendar");
  const calId = Object.keys(task.calendarIds).find((id) => calendarMap.has(id));
  const color = (calId && calendarMap.get(calId)?.color) || "#3b82f6";
  const done = task.progress === "completed";
  return (
    <span className={`pr-chip is-timed${done ? " is-inactive is-cancelled" : ""}`} style={chipStyle(color)}>
      <span className="pr-chip-time" aria-hidden>{done ? "☑" : "☐"}</span>
      <bdi className="pr-chip-title">{task.title || t("tasks.no_title")}</bdi>
    </span>
  );
}

// ---- Week and day -----------------------------------------------------------

function WeekPrint({
  weekStart, events, gridTasks, timeFormat, currentUserEmails, calendarMap,
}: CalendarPrintProps & { calendarMap: Map<string, Calendar> }) {
  const hideNonWorkingDays = useSettingsStore((s) => s.calendarHideNonWorkingDays);
  const workingDaysSetting = useSettingsStore((s) => s.calendarWorkingDays);
  const allDays = useMemo(() => Array.from({ length: 7 }, (_, i) => addDays(weekStart, i)), [weekStart]);
  const { days, shownIndexByDay } = useMemo(() => {
    const workingDays = resolveWorkingDays(hideNonWorkingDays, workingDaysSetting);
    if (!workingDays) return { days: allDays, shownIndexByDay: null };
    const shown: Date[] = [];
    const indices = allDays.map((day) => {
      if (!workingDays.has(day.getDay())) return -1;
      shown.push(day);
      return shown.length - 1;
    });
    return shown.length > 0 ? { days: shown, shownIndexByDay: indices } : { days: allDays, shownIndexByDay: null };
  }, [allDays, hideNonWorkingDays, workingDaysSetting]);
  return (
    <TimeGridPrint
      pageHeightMm={PRINT_PAGE_HEIGHT_MM.landscape}
      days={days}
      allDays={allDays}
      shownIndexByDay={shownIndexByDay}
      events={events}
      tasks={gridTasks}
      calendarMap={calendarMap}
      timeFormat={timeFormat}
      currentUserEmails={currentUserEmails}
    />
  );
}

/**
 * The time grid of a week or a day on one sheet: the hour rows share the
 * page's height whatever their number, so a long range is drawn smaller
 * rather than split over pages.
 */
function TimeGridPrint({
  pageHeightMm, days, allDays, shownIndexByDay, events, tasks, calendarMap, timeFormat, currentUserEmails,
}: {
  /** The height of the sheet's content, which the hours share. */
  pageHeightMm: number;
  days: Date[];
  /** The consecutive days `days` are taken from (a week with its non-working days). */
  allDays: Date[];
  shownIndexByDay: number[] | null;
  events: CalendarEvent[];
  tasks?: CalendarTask[];
  calendarMap: Map<string, Calendar>;
  timeFormat: TimeFormat;
  currentUserEmails: string[];
}) {
  const t = useTranslations("calendar");
  const intlFormatter = useDisplayDateFormatter();
  const { formatDayNumber } = useCalendarLocale();
  const formatTime = useTimeFormatter(timeFormat);
  const limitHours = useSettingsStore((s) => s.calendarLimitHours);
  const startHour = useSettingsStore((s) => s.calendarDayStartHour);
  const endHour = useSettingsStore((s) => s.calendarDayEndHour);

  const timedByDay = useMemo(() => days.map((day) => events.filter((event) => {
    if (event.showWithoutTime || isTimedEventFullDayOnDate(event, day)) return false;
    return getTimedEventBoundsForDay(event, day) !== null;
  })), [days, events]);
  const hours: DisplayHours = useMemo(
    () => printHourRange(resolveDisplayHours(limitHours, startHour, endHour), timedByDay.flat(), days),
    [limitHours, startHour, endHour, timedByDay, days],
  );
  const span = hours.endMinutes - hours.startMinutes;
  const hourMarks = Array.from({ length: span / 60 }, (_, i) => hours.startMinutes / 60 + i);

  const allDaySegments = useMemo(() => {
    const segments = [
      ...buildWeekSegmentsRaw(events.filter((e) => e.showWithoutTime), allDays),
      ...buildTimedFullDayWeekSegments(events.filter((e) => !e.showWithoutTime), allDays),
    ];
    return packWeekSegments(shownIndexByDay ? remapSegmentsToShownDays(segments, shownIndexByDay) : segments);
  }, [events, allDays, shownIndexByDay]);
  const tasksByDay = useMemo(() => groupTasksByDueDay(tasks), [tasks]);
  const dayEventLanes = days.map((_, index) => allDaySegments.reduce(
    (lanes, s) => (index >= s.startIndex && index < s.startIndex + s.span ? Math.max(lanes, s.row + 1) : lanes),
    0,
  ));
  const allDayLanes = days.reduce(
    (lanes, day, index) => Math.max(lanes, dayEventLanes[index] + (tasksByDay.get(format(day, "yyyy-MM-dd"))?.length ?? 0)),
    0,
  );

  const columns = { gridTemplateColumns: `12mm repeat(${days.length}, minmax(0, 1fr))` };
  const pct = (minutes: number) => `${((minutes - hours.startMinutes) / span) * 100}%`;
  const place = (startIndex: number, width: number, lane: number): CSSProperties => ({
    insetInlineStart: `${(startIndex / days.length) * 100}%`,
    width: `${(width / days.length) * 100}%`,
    top: `${0.5 + lane * PRINT_LANE_MM}mm`,
  });

  return (
    <div className="pr-tg">
      <div className="pr-tg-row" style={columns}>
        <div className="pr-tg-gutter-head" />
        {days.map((day) => (
          <div key={format(day, "yyyy-MM-dd")} className="pr-tg-dayhead">
            <div className="pr-tg-weekday">{intlFormatter.dateTime(day, { weekday: "short" })}</div>
            <div className="pr-tg-date">{formatDayNumber(day)}</div>
          </div>
        ))}
      </div>

      {allDayLanes > 0 && (
        <div className="pr-tg-row" style={columns}>
          <div className="pr-tg-allday-label">{t("events.all_day")}</div>
          <div
            className="pr-tg-allday"
            style={{ gridColumn: `2 / span ${days.length}`, height: `${allDayLanes * PRINT_LANE_MM + 1}mm` }}
          >
            {allDaySegments.map((segment) => (
              <div
                key={`${segment.event.id}-${segment.startIndex}-${segment.row}`}
                className="pr-lane-item"
                style={place(segment.startIndex, segment.span, segment.row)}
              >
                <EventChip
                  event={segment.event}
                  calendar={calendarMap.get(getPrimaryCalendarId(segment.event) ?? "")}
                  time={null}
                  filled
                  continuesBefore={segment.continuesBefore}
                  continuesAfter={segment.continuesAfter}
                  currentUserEmails={currentUserEmails}
                />
              </div>
            ))}
            {days.map((day, index) => (tasksByDay.get(format(day, "yyyy-MM-dd")) ?? []).map((task, taskIndex) => (
              <div key={`task-${task.id}`} className="pr-lane-item" style={place(index, 1, dayEventLanes[index] + taskIndex)}>
                <TaskChip task={task} calendarMap={calendarMap} />
              </div>
            )))}
          </div>
        </div>
      )}

      <div className="pr-tg-body" style={columns}>
        <div className="pr-tg-hours">
          {hourMarks.map((hour, index) => (
            <span
              key={hour}
              className={`pr-tg-hour-label${index === 0 ? " is-first" : ""}`}
              style={{ top: pct(hour * 60) }}
            >
              <bdi dir="ltr">{formatDisplayHour(hour, timeFormat)}</bdi>
            </span>
          ))}
        </div>
        {days.map((day, dayIndex) => {
          const layouts = layoutOverlappingEvents(timedByDay[dayIndex], day);
          return (
            <div key={format(day, "yyyy-MM-dd")} className="pr-tg-col">
              {hourMarks.map((hour, index) => (
                <div key={hour} className="pr-tg-line" style={{ top: pct(hour * 60), borderTopWidth: index === 0 ? 0 : undefined }} />
              ))}
              {hourMarks.length <= 14 && hourMarks.map((hour) => (
                <div key={`h${hour}`} className="pr-tg-line is-half" style={{ top: pct(hour * 60 + 30) }} />
              ))}
              {layouts.map(({ event, column, totalColumns, startMinutes, endMinutes, continuesBefore, continuesAfter }) => {
                const start = Math.max(hours.startMinutes, startMinutes);
                const end = Math.min(hours.endMinutes, Math.max(endMinutes, startMinutes + 15));
                const location = primaryLocationName(event);
                const startTime = continuesBefore ? "…" : formatTime(getEventStartDate(event));
                const endTime = continuesAfter ? "…" : formatTime(getEventEndDate(event));
                const compact = isCompactTimeBlock(end - start, span, pageHeightMm, allDayLanes);
                return (
                  <div
                    key={event.id}
                    className={`pr-tg-event${compact ? " is-compact" : ""}`}
                    style={{
                      top: pct(start),
                      height: `${((end - start) / span) * 100}%`,
                      insetInlineStart: `${(column / totalColumns) * 100}%`,
                      width: `${(1 / totalColumns) * 100}%`,
                    }}
                  >
                    <EventChip
                      event={event}
                      calendar={calendarMap.get(getPrimaryCalendarId(event) ?? "")}
                      time={compact ? startTime : `${startTime} – ${endTime}`}
                      filled
                      continuesBefore={continuesBefore}
                      continuesAfter={continuesAfter}
                      currentUserEmails={currentUserEmails}
                      where={compact ? undefined : location}
                    />
                  </div>
                );
              })}
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ---- Agenda and search ------------------------------------------------------

function AgendaPrint({
  days, calendarMap, timeFormat, currentUserEmails,
}: {
  days: AgendaDay[];
  calendarMap: Map<string, Calendar>;
  timeFormat: TimeFormat;
  currentUserEmails: string[];
}) {
  const t = useTranslations("calendar");
  const intlFormatter = useDisplayDateFormatter();
  const formatTime = useTimeFormatter(timeFormat);

  if (days.length === 0) return <p className="pr-empty">{t("events.no_events")}</p>;

  const timeLabel = (event: CalendarEvent, day: Date): string => {
    if (event.showWithoutTime) return t("events.all_day");
    const bounds = getTimedEventBoundsForDay(event, day);
    if (!bounds || (bounds.startMinutes === 0 && bounds.endMinutes === 1440)) return t("events.all_day");
    const start = bounds.continuesBefore ? "…" : formatTime(getEventStartDate(event));
    const end = bounds.continuesAfter ? "…" : formatTime(getEventEndDate(event));
    return `${start} – ${end}`;
  };

  const row = (event: CalendarEvent, day: Date) => {
    const calendar = calendarMap.get(getPrimaryCalendarId(event) ?? "");
    const cancelled = event.status === "cancelled";
    const inactive = cancelled || isDeclinedByUser(event, currentUserEmails);
    const meta = [primaryLocationName(event), calendar?.name].filter(Boolean).join(" · ");
    return (
      <div
        key={event.id}
        className={`pr-list-row pr-agenda-row${inactive ? " is-inactive" : ""}${cancelled ? " is-cancelled" : ""}`}
      >
        <div className="pr-agenda-time"><bdi dir="ltr">{timeLabel(event, day)}</bdi></div>
        <div className="pr-agenda-what" style={chipStyle(getEventColor(event, calendar))}>
          <div className="pr-agenda-title"><bdi>{event.title || t("events.no_title")}</bdi></div>
          {meta && <div className="pr-agenda-meta"><bdi>{meta}</bdi></div>}
        </div>
      </div>
    );
  };

  return (
    <div>
      {days.map((group) => {
        const [first, ...rest] = group.events;
        return (
          <section key={group.dateKey}>
            {/* The heading stays with its first event: never alone at a page's foot. */}
            <div className="pr-keep">
              <h2 className="pr-day-heading">
                {intlFormatter.dateTime(group.date, { weekday: "long", day: "numeric", month: "long", year: "numeric" })}
              </h2>
              {first && row(first, group.date)}
            </div>
            {rest.map((event) => row(event, group.date))}
          </section>
        );
      })}
    </div>
  );
}

// ---- Tasks ------------------------------------------------------------------

function priorityKey(priority: number): string | null {
  if (priority >= 1 && priority <= 4) return "tasks.priority_high";
  if (priority === 5) return "tasks.priority_medium";
  if (priority >= 6 && priority <= 9) return "tasks.priority_low";
  return null;
}

function TaskListPrint({ tasks, calendars, timeFormat }: { tasks: CalendarTask[]; calendars: Calendar[]; timeFormat: TimeFormat }) {
  const shownName = useCollectionNames();
  const t = useTranslations("calendar");
  const intlFormatter = useDisplayDateFormatter();
  if (tasks.length === 0) return <p className="pr-empty">{t("tasks.no_tasks")}</p>;
  const columns = { gridTemplateColumns: "4mm minmax(0, 1fr) 34mm 20mm" };
  return (
    <div>
      <div className="pr-column-heads" style={columns}>
        <span />
        <span>{t("form.title")}</span>
        <span>{t("tasks.due_date")}</span>
        <span>{t("tasks.priority")}</span>
      </div>
      {tasks.map((task) => {
        const done = task.progress === "completed";
        const calendar = calendars.find((c) => task.calendarIds[c.id]);
        const due = task.due ? parseISO(task.due) : null;
        const dueLabel = due && !isNaN(due.getTime())
          ? intlFormatter.dateTime(due, task.showWithoutTime
            ? { weekday: "short", day: "numeric", month: "short", year: "numeric" }
            : { weekday: "short", day: "numeric", month: "short", year: "numeric", hour: "numeric", minute: "2-digit", hour12: timeFormat === "12h" })
          : "";
        const priority = priorityKey(task.priority);
        return (
          <div key={task.id} className={`pr-list-row pr-task-row${done ? " is-done" : ""}`}>
            <span className="pr-checkbox" aria-hidden>{done ? "✓" : ""}</span>
            <div>
              <div className="pr-task-title"><bdi>{task.title || t("tasks.no_title")}</bdi></div>
              {calendar && <div className="pr-task-meta"><bdi>{shownName.calendar(calendar)}</bdi></div>}
            </div>
            <div className="pr-task-meta">{dueLabel}</div>
            <div className="pr-task-meta">{priority ? t(priority) : ""}</div>
          </div>
        );
      })}
    </div>
  );
}

// ---- One event --------------------------------------------------------------

export function EventPrintSheet({
  event, calendar, timeFormat, timeZone,
}: {
  event: CalendarEvent;
  calendar?: Calendar;
  timeFormat: TimeFormat;
  timeZone: string;
}) {
  const shownName = useCollectionNames();
  const t = useTranslations("calendar");
  const locale = useLocale();
  const formatEventDate = useFormatEventDate();
  const formatTime = useTimeFormatter(timeFormat);
  const resolveContactName = useContactNameResolver();

  const start = getEventStartDate(event);
  const end = getEventEndDate(event);
  const displayEnd = getEventDisplayEndDate(event);
  const multiDay = !isSameDay(start, displayEnd);
  const when = event.showWithoutTime
    ? multiDay
      ? `${formatEventDate(start)} – ${formatEventDate(displayEnd)} · ${t("events.all_day")}`
      : `${formatEventDate(start)} · ${t("events.all_day")}`
    : multiDay
      ? `${formatEventDate(start)} ${formatTime(start)} – ${formatEventDate(end)} ${formatTime(end)}`
      : `${formatEventDate(start)} · ${formatTime(start)} – ${formatTime(end)}`;

  const location = primaryLocationName(event);
  const meeting = findMeetingLink(event);
  const description = descriptionAsText(event);
  const participants = getParticipantList(event, { resolveName: resolveContactName });
  const organizer = eventOrganizer(event);
  const organizerName = organizer ? (organizer.name || resolveContactName(organizer.email) || "") : "";
  const recurrence = event.recurrenceRules?.length ? buildRecurrenceSummary(event.recurrenceRules[0], t, locale) : null;
  const alerts = formatEventAlertsLabel(event, calendar ? [calendar] : [], t);

  return (
    <article className="pr-sheet">
      <header className="pr-sheet-head">
        <span className="pr-swatch" style={chipStyle(getEventColor(event, calendar))} aria-hidden />
        <div>
          <h1><bdi>{event.title || t("events.no_title")}</bdi></h1>
          {event.status === "tentative" && <p className="pr-sheet-sub">{t("detail.tentative")}</p>}
          {event.status === "cancelled" && <p className="pr-sheet-sub">{t("detail.cancelled")}</p>}
        </div>
      </header>

      <section>
        <dl className="pr-dl">
          <dt>{t("print.when")}</dt>
          <dd>
            <bdi>{when}</bdi>
          </dd>
          <dt>{t("print.time_zone_label")}</dt>
          <dd>{formatPrintTimeZone(timeZone, locale, start)}</dd>
          {location && (<><dt>{t("form.location")}</dt><dd><bdi>{location}</bdi></dd></>)}
          {meeting && (<><dt>{t("print.meeting")}</dt><dd><bdi>{meeting.uri}</bdi></dd></>)}
          {recurrence && (<><dt>{t("print.repeats")}</dt><dd>{recurrence}</dd></>)}
          {alerts && (<><dt>{t("tasks.alert")}</dt><dd>{alerts}</dd></>)}
          {calendar && (<><dt>{t("tasks.calendar")}</dt><dd><bdi>{shownName.calendar(calendar)}</bdi></dd></>)}
          {organizer && (
            <>
              <dt>{t("participants.organizer")}</dt>
              <dd><bdi>{organizerName ? `${organizerName} <${organizer.email}>` : organizer.email}</bdi></dd>
            </>
          )}
        </dl>
      </section>

      {participants.length > 0 && (
        <section className="pr-flow">
          <h2>{t("participants.title")} ({participants.length})</h2>
          {participants.map((p) => (
            <div key={p.id} className="pr-list-row pr-member-row">
              <span>
                <bdi>{p.name || p.email}</bdi>
                {p.isOrganizer && <span className="pr-status"> ({t("participants.organizer_role")})</span>}
              </span>
              <span><bdi>{p.name ? p.email : ""}</bdi></span>
              <span className="pr-status">{t(STATUS_LABEL[p.status] ?? STATUS_LABEL["needs-action"])}</span>
            </div>
          ))}
        </section>
      )}

      {description && (
        <section className="pr-flow">
          <h2>{t("form.description")}</h2>
          <p className="pr-text" dir="auto">{description}</p>
        </section>
      )}
    </article>
  );
}
