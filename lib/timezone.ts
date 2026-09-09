import { isSameDay } from "date-fns";
import { useSettingsStore } from "@/stores/settings-store";

/**
 * User-selectable display time zone (#755).
 *
 * Privacy-hardened browsers (LibreWolf, Tor Browser, resistFingerprinting)
 * report UTC to every page, so `Intl.DateTimeFormat().resolvedOptions()`
 * cannot be trusted as "the user's zone". The `timeZone` setting lets the
 * user pin an IANA zone that overrides browser detection everywhere we turn
 * an instant into a wall-clock time: mail timestamps, the calendar grid,
 * new-event zones and the `timeZone` argument on JMAP calendar queries.
 *
 * Two families of helpers live here:
 *
 *  - `getEffectiveTimeZone()` for code that formats a real instant with Intl
 *    (`toLocaleString(..., { timeZone })`). Nothing else changes.
 *  - `toDisplayDate()` / `fromDisplayDate()` for the calendar, whose grid math
 *    runs on the *local* getters of `Date` (`getHours()`, date-fns
 *    `startOfDay`, ...). Rather than teaching every view about zones, an
 *    instant is shifted once at the boundary into a "display date" whose
 *    local fields read as the wall-clock in the effective zone, and shifted
 *    back when the user's grid interaction has to become a real instant.
 *    Both are identity functions unless an override differing from the
 *    browser zone is active, so existing behaviour is untouched by default.
 */

/** Sentinel for "follow the browser" - the default. */
export const AUTO_TIME_ZONE = "auto";

/** The zone the browser reports; `UTC` when detection fails (SSR, old engines). */
// Resolving the zone builds an Intl formatter, which costs tens of
// microseconds; the calendar grids convert every event for every day they
// show, so the answer is kept. The browser zone does not change within a
// page's lifetime in practice.
let browserTimeZone: string | null = null;

export function getBrowserTimeZone(): string {
  if (browserTimeZone) return browserTimeZone;
  try {
    browserTimeZone = Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  } catch {
    browserTimeZone = "UTC";
  }
  return browserTimeZone;
}

const validityCache = new Map<string, boolean>();

/** True when `Intl` accepts `tz` as a time zone identifier. */
export function isValidTimeZone(tz: unknown): tz is string {
  if (typeof tz !== "string" || !tz) return false;
  let valid = validityCache.get(tz);
  if (valid === undefined) {
    try {
      new Intl.DateTimeFormat("en-US", { timeZone: tz });
      valid = true;
    } catch {
      valid = false;
    }
    validityCache.set(tz, valid);
  }
  return valid;
}

/**
 * Resolve a stored `timeZone` setting to a concrete IANA zone. `auto`, empty
 * or unknown values (a zone synced from a browser with a newer tz database,
 * a hand-edited import) fall back to the browser zone instead of throwing
 * later inside Intl.
 */
export function resolveTimeZone(setting: string | null | undefined, browserTimeZone = getBrowserTimeZone()): string {
  if (!setting || setting === AUTO_TIME_ZONE) return browserTimeZone;
  return isValidTimeZone(setting) ? setting : browserTimeZone;
}

/** The zone all instants should be displayed in: the user's override, else the browser's. */
export function getEffectiveTimeZone(): string {
  return resolveTimeZone(useSettingsStore.getState().timeZone);
}

/** True when the user's override is active and differs from the browser zone. */
export function isTimeZoneOverridden(): boolean {
  return getEffectiveTimeZone() !== getBrowserTimeZone();
}

export interface WallClock {
  year: number;
  /** 1-12 */
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
}

// Constructing Intl.DateTimeFormat is expensive (ICU data lookup); cache one
// formatter per zone - the calendar calls into this for every event.
const wallClockFormatterCache = new Map<string, Intl.DateTimeFormat>();

function getWallClockFormatter(timeZone: string): Intl.DateTimeFormat {
  let formatter = wallClockFormatterCache.get(timeZone);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat("en-US", {
      timeZone,
      hourCycle: "h23",
      year: "numeric",
      month: "numeric",
      day: "numeric",
      hour: "numeric",
      minute: "numeric",
      second: "numeric",
    });
    wallClockFormatterCache.set(timeZone, formatter);
  }
  return formatter;
}

/** Wall-clock fields of `date` as seen in `timeZone`. */
export function getWallClock(date: Date, timeZone: string): WallClock {
  const parts = getWallClockFormatter(timeZone).formatToParts(date);
  const map: Record<string, number> = {};
  for (const part of parts) {
    if (part.type !== "literal") map[part.type] = Number(part.value);
  }
  return {
    year: map.year,
    month: map.month,
    day: map.day,
    // Some engines still emit "24" at midnight despite hourCycle h23.
    hour: map.hour === 24 ? 0 : map.hour,
    minute: map.minute,
    second: map.second,
  };
}

/** UTC offset of `timeZone` at the given instant, in milliseconds (east = positive). */
export function getTimeZoneOffsetMs(date: Date, timeZone: string): number {
  const w = getWallClock(date, timeZone);
  const asUtc = Date.UTC(w.year, w.month - 1, w.day, w.hour, w.minute, w.second);
  // Intl drops sub-second precision; compare against the whole-second instant.
  return asUtc - Math.floor(date.getTime() / 1000) * 1000;
}

/** Build a Date whose *local* fields equal the given wall-clock (years < 100 included). */
function localDateFromWallClock(w: WallClock, milliseconds: number): Date {
  const d = new Date(0);
  d.setFullYear(w.year, w.month - 1, w.day);
  d.setHours(w.hour, w.minute, w.second, milliseconds);
  return d;
}

/**
 * Shift an instant into a Date whose local getters read as its wall-clock in
 * `timeZone` (date-fns-tz's `toZonedTime`). The result is NOT the same
 * instant unless the zones agree - only use it for local-field arithmetic
 * and rendering.
 */
export function toZonedDisplayDate(date: Date, timeZone: string): Date {
  if (isNaN(date.getTime())) return date;
  return localDateFromWallClock(getWallClock(date, timeZone), date.getMilliseconds());
}

/**
 * Interpret the local fields of `wall` as a wall-clock in `timeZone` and
 * return the real instant (date-fns-tz's `fromZonedTime`). Two offset
 * lookups handle wall-clocks next to a DST transition.
 */
export function fromZonedDisplayDate(wall: Date, timeZone: string): Date {
  if (isNaN(wall.getTime())) return wall;
  const asUtc = Date.UTC(
    wall.getFullYear(), wall.getMonth(), wall.getDate(),
    wall.getHours(), wall.getMinutes(), wall.getSeconds(), wall.getMilliseconds(),
  );
  const guess = asUtc - getTimeZoneOffsetMs(new Date(asUtc), timeZone);
  return new Date(asUtc - getTimeZoneOffsetMs(new Date(guess), timeZone));
}

/**
 * Instant -> display date for the calendar grid. Identity unless the user's
 * time zone override differs from the browser zone.
 */
export function toDisplayDate(date: Date): Date {
  const timeZone = getEffectiveTimeZone();
  if (timeZone === getBrowserTimeZone()) return date;
  return toZonedDisplayDate(date, timeZone);
}

/** Display date (from the calendar grid) -> real instant. Inverse of `toDisplayDate`. */
export function fromDisplayDate(date: Date): Date {
  const timeZone = getEffectiveTimeZone();
  if (timeZone === getBrowserTimeZone()) return date;
  return fromZonedDisplayDate(date, timeZone);
}

/** "Now" as a display date - what the clock on the wall in the effective zone reads. */
export function displayNow(): Date {
  return toDisplayDate(new Date());
}

/** Is the display date `date` on today's calendar day in the effective zone? */
export function isDisplayToday(date: Date): boolean {
  return isSameDay(date, displayNow());
}

// A compact fallback for engines without Intl.supportedValuesOf (Safari < 15.4).
// One representative zone per UTC offset band plus the common capitals.
const FALLBACK_TIME_ZONES = [
  "UTC",
  "Pacific/Honolulu", "America/Anchorage", "America/Los_Angeles", "America/Denver",
  "America/Phoenix", "America/Chicago", "America/Mexico_City", "America/New_York",
  "America/Toronto", "America/Bogota", "America/Halifax", "America/Sao_Paulo",
  "America/Argentina/Buenos_Aires", "Atlantic/Azores", "Europe/London", "Europe/Lisbon",
  "Europe/Dublin", "Europe/Paris", "Europe/Berlin", "Europe/Madrid", "Europe/Rome",
  "Europe/Amsterdam", "Europe/Zurich", "Europe/Vienna", "Europe/Prague", "Europe/Warsaw",
  "Europe/Stockholm", "Europe/Athens", "Europe/Helsinki", "Europe/Kyiv", "Europe/Istanbul",
  "Europe/Moscow", "Asia/Jerusalem", "Asia/Dubai", "Asia/Tehran", "Asia/Karachi",
  "Asia/Kolkata", "Asia/Dhaka", "Asia/Bangkok", "Asia/Jakarta", "Asia/Shanghai",
  "Asia/Hong_Kong", "Asia/Singapore", "Asia/Taipei", "Asia/Seoul", "Asia/Tokyo",
  "Australia/Perth", "Australia/Adelaide", "Australia/Sydney", "Pacific/Auckland",
  "Africa/Cairo", "Africa/Johannesburg", "Africa/Lagos", "Africa/Nairobi",
];

/**
 * All IANA zone identifiers the runtime knows (a short fallback list on
 * engines without Intl.supportedValuesOf), sorted with plain `UTC` first -
 * ICU's list omits it, and it is exactly what a privacy-conscious user may
 * want to pin.
 */
export function listTimeZones(): string[] {
  let zones: string[] = FALLBACK_TIME_ZONES;
  try {
    const intl = Intl as unknown as { supportedValuesOf?: (key: string) => string[] };
    const supported = intl.supportedValuesOf?.("timeZone");
    if (supported && supported.length > 0) zones = supported;
  } catch {
    // keep the static list
  }
  return ["UTC", ...zones.filter((zone) => zone !== "UTC").sort()];
}
