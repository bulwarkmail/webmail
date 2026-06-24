/**
 * Jalali (Persian/Shamsi) calendar utilities.
 *
 * All internal date handling remains Gregorian (ISO 8601). The functions
 * in this module convert Gregorian ↔ Jalali at the display layer only.
 *
 * Uses `jalaali-js` for the underlying calendar math.
 */
import * as jalaali from 'jalaali-js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** A Jalali date represented as year, month (1-12), day (1-31). */
export interface JalaliDate {
  /** Jalali year (e.g. 1405) */
  jy: number;
  /** Jalali month (1 = Farvardin, 12 = Esfand) */
  jm: number;
  /** Jalali day of month (1-31) */
  jd: number;
}

// ---------------------------------------------------------------------------
// Gregorian ↔ Jalali conversion
// ---------------------------------------------------------------------------

/** Convert a Gregorian Date to its Jalali equivalent. */
export function toJalali(date: Date): JalaliDate {
  const { jy, jm, jd } = jalaali.toJalaali(date);
  return { jy, jm, jd };
}

/** Convert a Jalali date to a Gregorian Date. */
export function toGregorian(jy: number, jm: number, jd: number): Date {
  const { gy, gm, gd } = jalaali.toGregorian(jy, jm, jd);
  return new Date(gy, gm - 1, gd);
}

// ---------------------------------------------------------------------------
// Jalali month / day info
// ---------------------------------------------------------------------------

/** Full Persian month names (Farvardin … Esfand). */
export const JALALI_MONTHS: readonly string[] = [
  'فروردین',
  'اردیبهشت',
  'خرداد',
  'تیر',
  'مرداد',
  'شهریور',
  'مهر',
  'آبان',
  'آذر',
  'دی',
  'بهمن',
  'اسفند',
];

/** Number of days in a Jalali month (handles leap years). */
export function jalaliMonthLength(jy: number, jm: number): number {
  return jalaali.jalaaliMonthLength(jy, jm);
}

/** Is the given Jalali year a leap year? */
export function isJalaliLeapYear(jy: number): boolean {
  return jalaali.isLeapJalaaliYear(jy);
}

// ---------------------------------------------------------------------------
// Calendar grid helpers (analogous to date-fns startOfWeek / eachDayOfInterval)
// ---------------------------------------------------------------------------

/**
 * Return the first day of the Jalali month (Gregorian Date) aligned to the
 * week grid so the month view can be rendered.  `weekStartsOn` follows the
 * same convention as `date-fns`: 0=Sun, 1=Mon, …, 6=Sat.
 */
export function startOfJalaliMonth(
  jy: number,
  jm: number,
  weekStartsOn: number = 6,
): Date {
  const firstDay = toGregorian(jy, jm, 1);
  const dayOfWeek = firstDay.getDay(); // 0=Sun … 6=Sat
  const offset = (dayOfWeek - weekStartsOn + 7) % 7;
  const result = new Date(firstDay);
  result.setDate(result.getDate() - offset);
  return result;
}

/**
 * Return the last day of the Jalali month (Gregorian Date) aligned to the
 * week grid.
 */
export function endOfJalaliMonth(
  jy: number,
  jm: number,
  weekStartsOn: number = 6,
): Date {
  const lastDay = toGregorian(jy, jm, jalaliMonthLength(jy, jm));
  const dayOfWeek = lastDay.getDay();
  const offset = (weekStartsOn - dayOfWeek + 6) % 7;
  const result = new Date(lastDay);
  result.setDate(result.getDate() + offset);
  return result;
}

/**
 * Build a flat array of Gregorian Dates covering the entire calendar grid
 * for a Jalali month (from the week-aligned start to the week-aligned end).
 */
export function eachDayOfJalaliMonth(
  jy: number,
  jm: number,
  weekStartsOn: number = 6,
): Date[] {
  const start = startOfJalaliMonth(jy, jm, weekStartsOn);
  const end = endOfJalaliMonth(jy, jm, weekStartsOn);
  const days: Date[] = [];
  const cursor = new Date(start);
  while (cursor <= end) {
    days.push(new Date(cursor));
    cursor.setDate(cursor.getDate() + 1);
  }
  return days;
}

// ---------------------------------------------------------------------------
// Locale-aware day header order
// ---------------------------------------------------------------------------

/**
 * Return the array of day-abbreviation translation keys in the correct order
 * for the given `firstDayOfWeek` (0=Sun … 6=Sat).
 *
 * Usage:
 *   const dayHeaders = getDayHeaderKeys(firstDayOfWeek);
 *   dayHeaders.map((key) => t(`calendar.days.${key}`))
 */
export function getDayHeaderKeys(
  firstDayOfWeek: number,
): readonly string[] {
  const ALL: readonly string[] = [
    'sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat',
  ] as const;
  return [...ALL.slice(firstDayOfWeek), ...ALL.slice(0, firstDayOfWeek)];
}

// ---------------------------------------------------------------------------
// Locale detection helper
// ---------------------------------------------------------------------------

/**
 * Should the UI render dates using the Jalali calendar?
 *
 * Currently this is keyed off the `fa` locale. Administrators who want a
 * different locale with Jalali dates can extend this logic later.
 */
export function shouldUseJalaliCalendar(locale: string): boolean {
  return locale === 'fa';
}

/** Default `firstDayOfWeek` for a given locale. */
export function defaultFirstDayOfWeek(locale: string): number {
  if (locale === 'fa') return 6; // Saturday
  return 1; // Monday (ISO convention)
}
