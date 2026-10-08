import { startOfDay } from "date-fns";
import type { CalendarEvent } from "@/lib/jmap/types";
import { formatSnapTime, getTimedEventBoundsForDay, type CalendarWeekSegment } from "@/lib/calendar-utils";

/**
 * The slice of the day the time grids draw (#1164), in minutes from
 * midnight. `restricted` is false when it covers the whole day.
 */
export interface DisplayHours {
  startMinutes: number;
  endMinutes: number;
  restricted: boolean;
}

export const FULL_DAY_HOURS: DisplayHours = { startMinutes: 0, endMinutes: 1440, restricted: false };

/**
 * Settings arrive from other devices unvalidated, so anything that is not a
 * whole hour with start before end shows the full day.
 */
export function resolveDisplayHours(enabled: boolean, startHour: unknown, endHour: unknown): DisplayHours {
  if (!enabled) return FULL_DAY_HOURS;
  if (typeof startHour !== "number" || typeof endHour !== "number") return FULL_DAY_HOURS;
  if (!Number.isInteger(startHour) || !Number.isInteger(endHour)) return FULL_DAY_HOURS;
  if (startHour < 0 || endHour > 24 || endHour <= startHour) return FULL_DAY_HOURS;
  if (startHour === 0 && endHour === 24) return FULL_DAY_HOURS;
  return { startMinutes: startHour * 60, endMinutes: endHour * 60, restricted: true };
}

/** A range boundary as a label; the end of the day reads 24:00, not 00:00. */
export function formatDisplayHour(hour: number, timeFormat: "12h" | "24h"): string {
  if (hour === 24 && timeFormat === "24h") return "24:00";
  return formatSnapTime((hour % 24) * 60, timeFormat);
}

/**
 * The weekdays (0 = Sunday, as `Date.getDay`) the week view shows, or null
 * for all of them. An empty selection would leave nothing to show, so it
 * counts as all days too.
 */
export function resolveWorkingDays(enabled: boolean, days: unknown): Set<number> | null {
  if (!enabled || !Array.isArray(days)) return null;
  const set = new Set(days.filter((d): d is number => Number.isInteger(d) && d >= 0 && d <= 6));
  return set.size === 0 || set.size === 7 ? null : set;
}

export interface DisplayHoursPartition {
  /** Timed events that reach into the visible hours. */
  visible: CalendarEvent[];
  /** Events that end at or before the first visible hour. */
  before: number;
  /** Events that start at or after the last visible hour. */
  after: number;
  /** Start of the earliest event above the visible hours. */
  firstBeforeMinutes: number | null;
  /** Start of the earliest event below the visible hours. */
  firstAfterMinutes: number | null;
}

/**
 * Splits a day's timed events into the ones the grid draws and counts of the
 * ones above and below the visible hours, which are only hidden, never
 * dropped: the views show the counts so they stay reachable.
 */
export function partitionByDisplayHours(
  events: CalendarEvent[],
  day: Date,
  hours: DisplayHours,
): DisplayHoursPartition {
  const result: DisplayHoursPartition = {
    visible: [], before: 0, after: 0, firstBeforeMinutes: null, firstAfterMinutes: null,
  };
  if (!hours.restricted) {
    result.visible = events;
    return result;
  }
  for (const event of events) {
    const bounds = getTimedEventBoundsForDay(event, day);
    if (!bounds) continue;
    // A zero-length event still occupies the minute it starts in.
    const end = Math.max(bounds.endMinutes, bounds.startMinutes + 1);
    if (end <= hours.startMinutes) {
      result.before++;
      if (result.firstBeforeMinutes === null || bounds.startMinutes < result.firstBeforeMinutes) {
        result.firstBeforeMinutes = bounds.startMinutes;
      }
    } else if (bounds.startMinutes >= hours.endMinutes) {
      result.after++;
      if (result.firstAfterMinutes === null || bounds.startMinutes < result.firstAfterMinutes) {
        result.firstAfterMinutes = bounds.startMinutes;
      }
    } else {
      result.visible.push(event);
    }
  }
  return result;
}

export interface ClippedSpan {
  startMinutes: number;
  endMinutes: number;
  clippedStart: boolean;
  clippedEnd: boolean;
}

/** The part of [start, end) inside the visible hours, for drawing. */
export function clipToDisplayHours(startMinutes: number, endMinutes: number, hours: DisplayHours): ClippedSpan {
  const end = Math.max(startMinutes, endMinutes);
  return {
    startMinutes: Math.max(hours.startMinutes, Math.min(startMinutes, hours.endMinutes)),
    endMinutes: Math.min(hours.endMinutes, Math.max(end, hours.startMinutes)),
    clippedStart: startMinutes < hours.startMinutes,
    clippedEnd: end > hours.endMinutes,
  };
}

/** Index of the first of `days` on or after `target`, clamped to the list. */
export function indexOfDayOnOrAfter(days: Date[], target: Date): number {
  if (days.length === 0) return 0;
  const t = startOfDay(target).getTime();
  const index = days.findIndex((d) => startOfDay(d).getTime() >= t);
  return index === -1 ? days.length - 1 : index;
}

/**
 * Maps segments laid out over consecutive `allDays` onto the columns that
 * are actually drawn (`shownIndexByDay[i]` is the column of `allDays[i]`, or
 * -1 when that day is hidden). A segment that only covers hidden days is
 * dropped; one that loses days at an end continues past that end. Rows are
 * left for the caller to repack.
 */
export function remapSegmentsToShownDays(
  segments: CalendarWeekSegment[],
  shownIndexByDay: number[],
): CalendarWeekSegment[] {
  return segments.flatMap((segment) => {
    let first = -1;
    let last = -1;
    for (let i = segment.startIndex; i < segment.startIndex + segment.span; i++) {
      const col = shownIndexByDay[i];
      if (col === undefined || col < 0) continue;
      if (first === -1) first = col;
      last = col;
    }
    if (first === -1) return [];
    const firstDayShown = (shownIndexByDay[segment.startIndex] ?? -1) >= 0;
    const lastDayShown = (shownIndexByDay[segment.startIndex + segment.span - 1] ?? -1) >= 0;
    return [{
      ...segment,
      startIndex: first,
      span: last - first + 1,
      row: -1,
      continuesBefore: segment.continuesBefore || !firstDayShown,
      continuesAfter: segment.continuesAfter || !lastDayShown,
    }];
  });
}
