import { addDays, differenceInCalendarDays, parseISO, startOfDay, subMilliseconds } from "date-fns";
import { parseDuration } from "@/components/calendar/event-card";
import type { CalendarEvent } from "@/lib/jmap/types";

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

export function getEventStartDate(
  event: Pick<CalendarEvent, 'start' | 'utcStart' | 'showWithoutTime'>,
): Date {
  const source = !event.showWithoutTime && event.utcStart ? event.utcStart : event.start;
  return parseISO(source);
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

export function getEventEndDate(event: CalendarEvent): Date {
  if (!event.showWithoutTime && event.utcEnd) {
    return parseISO(event.utcEnd);
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

export function buildTimedFullDayWeekSegments(events: CalendarEvent[], weekDays: Date[]): CalendarWeekSegment[] {
  if (weekDays.length === 0) return [];

  const rawSegments = events.flatMap((event) => {
    const fullDayIndices = weekDays
      .map((day, index) => (isTimedEventFullDayOnDate(event, day) ? index : -1))
      .filter((index) => index >= 0);

    if (fullDayIndices.length === 0) {
      return [];
    }

    const segments: CalendarWeekSegment[] = [];
    let rangeStart = fullDayIndices[0];
    let previousIndex = fullDayIndices[0];

    const pushSegment = (startIndex: number, endIndex: number) => {
      const startDay = weekDays[startIndex];
      const endDay = weekDays[endIndex];
      segments.push({
        event,
        startIndex,
        span: endIndex - startIndex + 1,
        row: -1,
        continuesBefore: isTimedEventFullDayOnDate(event, addDays(startDay, -1)),
        continuesAfter: isTimedEventFullDayOnDate(event, addDays(endDay, 1)),
      });
    };

    for (let index = 1; index < fullDayIndices.length; index++) {
      const currentIndex = fullDayIndices[index];
      if (currentIndex !== previousIndex + 1) {
        pushSegment(rangeStart, previousIndex);
        rangeStart = currentIndex;
      }
      previousIndex = currentIndex;
    }

    pushSegment(rangeStart, previousIndex);
    return segments;
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
