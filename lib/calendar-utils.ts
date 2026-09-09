import { addDays, differenceInCalendarDays, parseISO, startOfDay, subMilliseconds } from "date-fns";
import { parseDuration } from "@/components/calendar/event-card";
import type { CalendarEvent } from "@/lib/jmap/types";
import { toDisplayDate } from "@/lib/timezone";

export interface CalendarWeekSegment {
  event: CalendarEvent;
  startIndex: number;
  span: number;
  row: number;
  continuesBefore: boolean;
  continuesAfter: boolean;
}

export interface TimedEventLayout {
  event: CalendarEvent;
  column: number;
  totalColumns: number;
  startMinutes: number;
  endMinutes: number;
  continuesBefore: boolean;
  continuesAfter: boolean;
}

/**
 * Start of an event as a *display date*: a Date whose local getters read as
 * the wall-clock in the user's effective time zone, which is what the grid
 * math (getHours(), startOfDay, ...) and every view render. Identical to the
 * real instant unless a time zone override is active (#755); convert back
 * with `fromDisplayDate` before turning grid positions into instants.
 */
export function getEventStartDate(
  event: Pick<CalendarEvent, 'start' | 'utcStart' | 'showWithoutTime'>,
): Date {
  // Prefer utcStart for timed events but fall back to start if utcStart is
  // missing or unparseable - a malformed utcStart used to surface as an
  // Invalid Date that crashed downstream format() calls (#316).
  if (!event.showWithoutTime && event.utcStart) {
    const utc = parseISO(event.utcStart);
    if (!isNaN(utc.getTime())) return toDisplayDate(utc);
  }
  return parseISO(event.start);
}

export function packWeekSegments(rawSegments: CalendarWeekSegment[]): CalendarWeekSegment[] {
  rawSegments.sort((left, right) => {
    if (left.startIndex !== right.startIndex) return left.startIndex - right.startIndex;
    if (left.span !== right.span) return right.span - left.span;
    if (left.event.showWithoutTime !== right.event.showWithoutTime) {
      return left.event.showWithoutTime ? -1 : 1;
    }
    const timeDiff = getEventStartDate(left.event).getTime() - getEventStartDate(right.event).getTime();
    if (timeDiff !== 0) return timeDiff;
    return (left.event.title || "").localeCompare(right.event.title || "");
  });

  const rowEndIndices: number[] = [];
  return rawSegments.map((segment) => {
    const segmentEndIndex = segment.startIndex + segment.span - 1;
    let row = rowEndIndices.findIndex((endIndex) => endIndex < segment.startIndex);
    if (row === -1) {
      row = rowEndIndices.length;
      rowEndIndices.push(segmentEndIndex);
    } else {
      rowEndIndices[row] = segmentEndIndex;
    }
    return { ...segment, row };
  });
}

/** End of an event as a display date - see `getEventStartDate`. */
export function getEventEndDate(event: CalendarEvent): Date {
  if (!event.showWithoutTime && event.utcEnd) {
    const utc = parseISO(event.utcEnd);
    if (!isNaN(utc.getTime())) return toDisplayDate(utc);
  }

  const start = getEventStartDate(event);
  if (!event.duration) return start;
  return new Date(start.getTime() + parseDuration(event.duration) * 60000);
}

export function getEventDisplayEndDate(event: CalendarEvent): Date {
  const end = getEventEndDate(event);
  const start = getEventStartDate(event);
  if (!event.showWithoutTime || end.getTime() <= start.getTime()) {
    return end;
  }
  return subMilliseconds(end, 1);
}

export function getEventDayBounds(event: CalendarEvent): { startDay: Date; endDay: Date } {
  return {
    startDay: startOfDay(getEventStartDate(event)),
    endDay: startOfDay(getEventDisplayEndDate(event)),
  };
}

export function getTimedEventBoundsForDay(
  event: CalendarEvent,
  day: Date,
): { startMinutes: number; endMinutes: number; continuesBefore: boolean; continuesAfter: boolean } | null {
  if (event.showWithoutTime) return null;

  const eventStart = getEventStartDate(event);
  const eventEnd = getEventEndDate(event);
  const dayStart = startOfDay(day);
  const nextDayStart = addDays(dayStart, 1);

  if (eventEnd <= dayStart || eventStart >= nextDayStart) {
    return null;
  }

  const clippedStart = eventStart > dayStart ? eventStart : dayStart;
  const clippedEnd = eventEnd < nextDayStart ? eventEnd : nextDayStart;
  const startMinutes = Math.max(0, Math.floor((clippedStart.getTime() - dayStart.getTime()) / 60000));
  const endMinutes = Math.min(1440, Math.ceil((clippedEnd.getTime() - dayStart.getTime()) / 60000));

  return {
    startMinutes,
    endMinutes,
    continuesBefore: eventStart < dayStart,
    continuesAfter: eventEnd > nextDayStart,
  };
}

export function isTimedEventFullDayOnDate(event: CalendarEvent, day: Date): boolean {
  const bounds = getTimedEventBoundsForDay(event, day);
  return bounds?.startMinutes === 0 && bounds?.endMinutes === 1440;
}

export function normalizeAllDayDuration(duration: string | undefined): string | undefined {
  if (!duration) return undefined;
  const totalMinutes = parseDuration(duration);
  const totalDays = Math.max(1, Math.ceil(totalMinutes / (24 * 60)));
  return `P${totalDays}D`;
}

export function buildAllDayDuration(start: Date, inclusiveEnd: Date): string {
  const dayCount = Math.max(1, differenceInCalendarDays(startOfDay(inclusiveEnd), startOfDay(start)) + 1);
  return `P${dayCount}D`;
}

export function buildWeekSegmentsRaw(events: CalendarEvent[], weekDays: Date[]): CalendarWeekSegment[] {
  if (weekDays.length === 0) return [];

  const weekStart = startOfDay(weekDays[0]);
  const weekEnd = startOfDay(weekDays[weekDays.length - 1]);

  const rawSegments = events.flatMap((event) => {
    const { startDay, endDay } = getEventDayBounds(event);
    if (endDay < weekStart || startDay > weekEnd) {
      return [];
    }

    const segmentStart = startDay < weekStart ? weekStart : startDay;
    const segmentEnd = endDay > weekEnd ? weekEnd : endDay;
    const startIndex = differenceInCalendarDays(segmentStart, weekStart);
    const span = differenceInCalendarDays(segmentEnd, segmentStart) + 1;

    return [{
      event,
      startIndex,
      span,
      row: -1,
      continuesBefore: startDay < weekStart,
      continuesAfter: endDay > weekEnd,
    } satisfies CalendarWeekSegment];
  });

  return rawSegments;
}

export function buildWeekSegments(events: CalendarEvent[], weekDays: Date[]): CalendarWeekSegment[] {
  return packWeekSegments(buildWeekSegmentsRaw(events, weekDays));
}

/**
 * Segments for timed events that cover whole days (midnight to midnight)
 * within `weekDays`, which must be consecutive days. The days an event
 * covers in full always form one run, so each event is resolved from its
 * own bounds instead of being tested against every day - the freely
 * scrolling views hand in months of days at a time (#759).
 */
export function buildTimedFullDayWeekSegments(events: CalendarEvent[], weekDays: Date[]): CalendarWeekSegment[] {
  if (weekDays.length === 0) return [];

  const firstDay = startOfDay(weekDays[0]);
  const lastDay = startOfDay(weekDays[weekDays.length - 1]);

  const rawSegments = events.flatMap((event) => {
    if (event.showWithoutTime) return [];
    const eventStart = getEventStartDate(event);
    const eventEnd = getEventEndDate(event);
    const startDay = startOfDay(eventStart);
    // First day whose midnight is not before the event, last day whose next
    // midnight is not after it.
    const firstFull = eventStart.getTime() === startDay.getTime() ? startDay : addDays(startDay, 1);
    const lastFull = addDays(startOfDay(eventEnd), -1);
    if (lastFull < firstFull) return [];

    const segmentStart = firstFull < firstDay ? firstDay : firstFull;
    const segmentEnd = lastFull > lastDay ? lastDay : lastFull;
    if (segmentStart > segmentEnd) return [];

    return [{
      event,
      startIndex: differenceInCalendarDays(segmentStart, firstDay),
      span: differenceInCalendarDays(segmentEnd, segmentStart) + 1,
      row: -1,
      continuesBefore: firstFull < segmentStart,
      continuesAfter: lastFull > segmentEnd,
    } satisfies CalendarWeekSegment];
  });

  return packWeekSegments(rawSegments);
}

export function layoutOverlappingEvents(
  events: CalendarEvent[],
  day: Date,
): TimedEventLayout[] {
  const layoutInputs = events.flatMap((event) => {
    const bounds = getTimedEventBoundsForDay(event, day);
    return bounds ? [{ event, ...bounds }] : [];
  });

  const sorted = layoutInputs.sort((a, b) => {
    const diff = a.startMinutes - b.startMinutes;
    if (diff !== 0) return diff;
    return (b.endMinutes - b.startMinutes) - (a.endMinutes - a.startMinutes);
  });

  const result: TimedEventLayout[] = [];
  let columns: { event: CalendarEvent; end: number }[][] = [];
  let clusterStart = 0;
  let clusterMaxEnd = 0;

  const flushCluster = () => {
    const total = columns.length;
    for (let i = clusterStart; i < result.length; i++) {
      result[i].totalColumns = total;
    }
  };

  for (const event of sorted) {
    if (columns.length > 0 && event.startMinutes >= clusterMaxEnd) {
      flushCluster();
      clusterStart = result.length;
      columns = [];
      clusterMaxEnd = 0;
    }

    let placed = false;
    for (let col = 0; col < columns.length; col++) {
      if (columns[col].every(e => e.end <= event.startMinutes)) {
        columns[col].push({ event: event.event, end: event.endMinutes });
        result.push({ ...event, column: col, totalColumns: 0 });
        placed = true;
        break;
      }
    }
    if (!placed) {
      columns.push([{ event: event.event, end: event.endMinutes }]);
      result.push({ ...event, column: columns.length - 1, totalColumns: 0 });
    }
    clusterMaxEnd = Math.max(clusterMaxEnd, event.endMinutes);
  }

  flushCluster();
  return result;
}

export function formatSnapTime(minutes: number, timeFormat: "12h" | "24h"): string {
  const clamped = Math.max(0, Math.min(1440, minutes));
  const h = Math.floor(clamped / 60) % 24;
  const m = clamped % 60;
  if (timeFormat === "12h") {
    return `${h % 12 || 12}:${String(m).padStart(2, "0")} ${h < 12 ? "AM" : "PM"}`;
  }
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
}

export function getPrimaryCalendarId(event: Pick<CalendarEvent, 'calendarIds'>): string | undefined {
  return Object.keys(event.calendarIds || {})[0];
}

export function formatIsoInTimeZone(date: Date, timeZone: string): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  }).formatToParts(date);
  const map: Record<string, string> = {};
  for (const part of parts) {
    if (part.type !== "literal") map[part.type] = part.value;
  }
  const hour = map.hour === "24" ? "00" : map.hour;
  return `${map.year}-${map.month}-${map.day}T${hour}:${map.minute}:${map.second}`;
}
