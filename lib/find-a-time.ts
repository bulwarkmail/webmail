/**
 * "Suggest times" in the event editor: the next slots in which nobody whose
 * calendar Bulwark could check is busy.
 *
 * The search runs over the organiser's working days and day hours (the
 * calendar settings of #1164), in the effective time zone, on a 30-minute
 * grid. The hours are used even when the calendar doesn't limit the time
 * grids to them: a suggestion at three in the morning helps nobody.
 */

import type { BusyPeriod } from '@/lib/jmap/types';
import { fromWallClock, getWallClock } from '@/lib/timezone';
import { resolveDisplayHours } from '@/lib/calendar-display-range';

export const SEARCH_WORKING_DAYS = 10;
export const MAX_SUGGESTIONS = 5;
export const GRID_MINUTES = 30;
const DEFAULT_WORKING_DAYS = [1, 2, 3, 4, 5];
const DEFAULT_HOURS = { start: 8, end: 20 };

export interface SlotSearchOptions {
  /** The earliest moment a slot may start. */
  now: Date;
  /** The meeting's length. */
  durationMs: number;
  /** The effective IANA time zone the hours and days are read in. */
  timeZone: string;
  /** Weekdays as Date.getDay numbers (0 = Sunday); anything unusable means Monday to Friday. */
  workingDays: unknown;
  dayStartHour: unknown;
  dayEndHour: unknown;
  /** Busy time of everyone who was checked, merged or not. */
  busy: BusyPeriod[];
  maxSlots?: number;
  workingDayCount?: number;
}

export interface Slot {
  start: Date;
  end: Date;
}

interface Day {
  year: number;
  month: number;
  day: number;
}

function workingDaySet(value: unknown): Set<number> {
  const days = Array.isArray(value) ? value.filter((d): d is number => Number.isInteger(d) && d >= 0 && d <= 6) : [];
  return new Set(days.length > 0 ? days : DEFAULT_WORKING_DAYS);
}

/** The day hours to search in minutes from midnight: the user's, else 8 to 20. */
export function searchHours(startHour: unknown, endHour: unknown): { startMinutes: number; endMinutes: number } {
  const hours = resolveDisplayHours(true, startHour, endHour);
  if (!hours.restricted && !(startHour === 0 && endHour === 24)) {
    return { startMinutes: DEFAULT_HOURS.start * 60, endMinutes: DEFAULT_HOURS.end * 60 };
  }
  return { startMinutes: hours.startMinutes, endMinutes: hours.endMinutes };
}

function nextDay(d: Day): Day {
  const date = new Date(Date.UTC(d.year, d.month - 1, d.day + 1));
  return { year: date.getUTCFullYear(), month: date.getUTCMonth() + 1, day: date.getUTCDate() };
}

function weekday(d: Day): number {
  return new Date(Date.UTC(d.year, d.month - 1, d.day)).getUTCDay();
}

function at(d: Day, minutes: number, timeZone: string): Date {
  // 24:00 is midnight of the next day.
  const day = minutes >= 1440 ? nextDay(d) : d;
  const m = minutes % 1440;
  return fromWallClock({ ...day, hour: Math.floor(m / 60), minute: m % 60, second: 0 }, timeZone);
}

/** The working days the search covers, from today on, in `timeZone`. */
function searchDays(now: Date, timeZone: string, workingDays: Set<number>, count: number): Day[] {
  const wall = getWallClock(now, timeZone);
  let d: Day = { year: wall.year, month: wall.month, day: wall.day };
  const days: Day[] = [];
  // At most a year of days, in case the set is somehow empty.
  for (let i = 0; i < 366 && days.length < count; i++) {
    if (workingDays.has(weekday(d))) days.push(d);
    d = nextDay(d);
  }
  return days;
}

/**
 * The span one availability call per person has to cover: from now to the
 * end of the last working day searched.
 */
export function searchWindow(options: Pick<SlotSearchOptions, 'now' | 'timeZone' | 'workingDays' | 'dayStartHour' | 'dayEndHour' | 'workingDayCount'>): { start: Date; end: Date } {
  const days = searchDays(options.now, options.timeZone, workingDaySet(options.workingDays), options.workingDayCount ?? SEARCH_WORKING_DAYS);
  const last = days[days.length - 1];
  const { endMinutes } = searchHours(options.dayStartHour, options.dayEndHour);
  return { start: options.now, end: last ? at(last, endMinutes, options.timeZone) : options.now };
}

function overlaps(busy: Array<{ start: number; end: number }>, start: number, end: number): boolean {
  for (const period of busy) {
    if (period.start < end && period.end > start) return true;
  }
  return false;
}

/**
 * Up to `maxSlots` meeting slots of `durationMs` inside the working hours of
 * the next working days, starting on the grid, that overlap no busy period.
 * Tentative time counts as busy: a suggestion should not ask anyone to drop
 * something.
 */
export function findFreeSlots(options: SlotSearchOptions): Slot[] {
  const max = options.maxSlots ?? MAX_SUGGESTIONS;
  if (!(options.durationMs > 0)) return [];
  const { startMinutes, endMinutes } = searchHours(options.dayStartHour, options.dayEndHour);
  const days = searchDays(options.now, options.timeZone, workingDaySet(options.workingDays), options.workingDayCount ?? SEARCH_WORKING_DAYS);
  const busy = options.busy
    .map((p) => ({ start: Date.parse(p.utcStart), end: Date.parse(p.utcEnd) }))
    .filter((p) => Number.isFinite(p.start) && Number.isFinite(p.end) && p.end > p.start);
  const nowMs = options.now.getTime();
  const slots: Slot[] = [];
  for (const day of days) {
    const dayEnd = at(day, endMinutes, options.timeZone).getTime();
    for (let minutes = startMinutes; minutes < endMinutes; minutes += GRID_MINUTES) {
      const start = at(day, minutes, options.timeZone).getTime();
      const end = start + options.durationMs;
      if (end > dayEnd) break;
      if (start < nowMs) continue;
      if (overlaps(busy, start, end)) continue;
      slots.push({ start: new Date(start), end: new Date(end) });
      if (slots.length >= max) return slots;
    }
  }
  return slots;
}
