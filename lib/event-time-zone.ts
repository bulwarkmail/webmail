import { format, isSameDay } from "date-fns";
import type { CalendarEvent } from "@/lib/jmap/types";
import { timeZoneCity as friendlyCity } from "@/lib/time-zone-choices";
import {
  canonicalTimeZone,
  fromDisplayDate,
  fromWallClock,
  getEffectiveTimeZone,
  getTimeZoneOffsetMs,
  toDisplayDate,
  toZonedDisplayDate,
  type WallClock,
} from "@/lib/timezone";

/**
 * The event editor's time zone (pim-2). The form's date and time fields are
 * the wall clock in the zone the event is in, and a save writes them back in
 * that zone: an edit of a meeting in New York keeps it in New York, its start
 * as the server has it. The rest of the calendar works on display dates (the
 * wall clock in the user's zone, lib/timezone.ts); these helpers turn the
 * form's fields into one and back.
 *
 * A zone of null is a floating event: the same wall clock everywhere, so its
 * fields are the display date as it is, and it is saved without a zone.
 */

/**
 * The zone the editor opens an event in: its own, spelled as Intl spells it;
 * none for a timed event without one (floating). A new event, an all-day one
 * (should it become timed) and one whose zone Intl doesn't know take the
 * user's zone, as before.
 */
export function eventFormTimeZone(
  event: Pick<CalendarEvent, "timeZone" | "showWithoutTime"> | null | undefined,
  userZone: string = getEffectiveTimeZone(),
): string | null {
  if (!event || event.showWithoutTime) return userZone;
  if (event.timeZone === null) return null;
  if (!event.timeZone) return userZone;
  return canonicalTimeZone(event.timeZone) ?? userZone;
}

/** A Date whose local fields read the wall clock `display` (a display date) has in `zone`. */
export function displayToZoneWall(display: Date, zone: string | null): Date {
  if (!zone || Number.isNaN(display.getTime())) return display;
  if (zone === getEffectiveTimeZone()) return display;
  return toZonedDisplayDate(fromDisplayDate(display), zone);
}

/** The display date at which the clock in `zone` reads the local fields of `wall`. */
export function zoneWallToDisplay(wall: Date, zone: string | null): Date {
  if (!zone || Number.isNaN(wall.getTime())) return wall;
  if (zone === getEffectiveTimeZone()) return wall;
  return toDisplayDate(fromWallClock({
    year: wall.getFullYear(),
    month: wall.getMonth() + 1,
    day: wall.getDate(),
    hour: wall.getHours(),
    minute: wall.getMinutes(),
    second: wall.getSeconds(),
  }, zone));
}

/**
 * The form's "yyyy-MM-dd" and "HH:mm" as clock fields. Not through a Date: in
 * the browser's own zone a time in its daylight-saving gap (02:30 on the
 * last Sunday of March in Berlin) would move an hour, though it exists in
 * the event's zone.
 */
export function wallFields(date: string, time: string): WallClock {
  const [year, month, day] = date.split("-").map(Number);
  const [hour, minute] = time.split(":").map(Number);
  return { year, month, day, hour: hour || 0, minute: minute || 0, second: 0 };
}

/** The clock fields `ms` later, by the clock. */
export function addToWall(w: WallClock, ms: number): WallClock {
  const d = new Date(Date.UTC(w.year, w.month - 1, w.day, w.hour, w.minute, w.second) + ms);
  return { year: d.getUTCFullYear(), month: d.getUTCMonth() + 1, day: d.getUTCDate(), hour: d.getUTCHours(), minute: d.getUTCMinutes(), second: d.getUTCSeconds() };
}

/** Clock fields compared as a clock reads them: negative, 0 or positive. */
export function compareWall(a: WallClock, b: WallClock): number {
  return Date.UTC(a.year, a.month - 1, a.day, a.hour, a.minute, a.second) - Date.UTC(b.year, b.month - 1, b.day, b.hour, b.minute, b.second);
}

/** The display date at which the clock in `zone` reads `w` (zoneWallToDisplay, from fields). */
export function zoneFieldsToDisplay(w: WallClock, zone: string | null): Date {
  if (!zone || zone === getEffectiveTimeZone()) return new Date(w.year, w.month - 1, w.day, w.hour, w.minute, w.second);
  return toDisplayDate(fromWallClock(w, zone));
}

/**
 * The time from `a` to `b` on the clock in `zone`, as an event's duration
 * counts it: exact time, so 01:00-04:00 in New York on the night the clocks
 * go forward lasts two hours. A floating event (no zone) counts by the clock.
 */
export function zoneWallDurationMs(a: WallClock, b: WallClock, zone: string | null): number {
  if (!zone) return compareWall(b, a);
  return fromWallClock(b, zone).getTime() - fromWallClock(a, zone).getTime();
}

/** "America/New_York" as people say it: "New York". */
export function timeZoneCity(zone: string): string {
  // Settings' names (pim-p2-5): current city names ("Kyiv", not "Kiev").
  return friendlyCity(zone);
}

/** Whether the clocks in `a` and `b` read alike at `instant`. */
export function sameClock(a: string, b: string, instant: Date): boolean {
  if (a === b) return true;
  try {
    return getTimeZoneOffsetMs(instant, a) === getTimeZoneOffsetMs(instant, b);
  } catch {
    return false;
  }
}

export interface ZonedTimes {
  /** The event's zone, by its city: "New York". */
  zone: string;
  /** Start and end on the event's own clock: display-style Dates (read their local fields). */
  start: Date;
  end: Date;
  /** The event's own clock is on another day than the user's at the start. */
  otherDay: boolean;
}

/**
 * When a timed event is on its own clock, for a line under the user's times
 * ("10:00–11:00 New York"): only when its zone's clock reads differently
 * from the user's at the event's start. `start` and `end` are the display
 * dates the views work with. Null for all-day and floating events, and for
 * an event in the user's zone or one with the same clock.
 */
export function eventZonedTimes(
  event: Pick<CalendarEvent, "timeZone" | "showWithoutTime">,
  start: Date,
  end: Date,
  userZone: string = getEffectiveTimeZone(),
): ZonedTimes | null {
  if (event.showWithoutTime || !event.timeZone) return null;
  const zone = canonicalTimeZone(event.timeZone);
  if (!zone) return null;
  const instant = fromDisplayDate(start);
  if (Number.isNaN(instant.getTime()) || sameClock(zone, userZone, instant)) return null;
  const zonedStart = toZonedDisplayDate(instant, zone);
  const zonedEnd = toZonedDisplayDate(fromDisplayDate(end), zone);
  return { zone: timeZoneCity(zone), start: zonedStart, end: zonedEnd, otherDay: !isSameDay(zonedStart, start) };
}

/**
 * The times of eventZonedTimes as text: on the event's clock ("10:00–11:00",
 * with the weekday when its day differs from the user's, or both ends when
 * it spans days) and on the user's (`start`, `end`, display dates).
 */
export function zonedTimesText(
  zoned: ZonedTimes,
  start: Date,
  end: Date,
  timeFormat: string,
  locale: string,
): { times: string; local: string } {
  const time = (d: Date) => format(d, timeFormat);
  let weekday: Intl.DateTimeFormat;
  try {
    weekday = new Intl.DateTimeFormat(locale, { weekday: "short" });
  } catch {
    weekday = new Intl.DateTimeFormat("en", { weekday: "short" });
  }
  const day = (d: Date) => weekday.format(d);
  const span = (from: Date, to: Date, withDay: boolean) => (isSameDay(from, to)
    ? `${withDay ? `${day(from)} ` : ""}${time(from)}–${time(to)}`
    : `${day(from)} ${time(from)} – ${day(to)} ${time(to)}`);
  return { times: span(zoned.start, zoned.end, zoned.otherDay), local: span(start, end, false) };
}
