"use client";

import { useMemo } from "react";
import { useLocale } from "next-intl";
import { useSettingsStore } from "@/stores/settings-store";
import {
  toJalali,
  jalaliMonthLength,
  startOfJalaliMonth,
  endOfJalaliMonth,
  eachDayOfJalaliMonth,
  getDayHeaderKeys,
  shouldUseJalaliCalendar,
  JALALI_MONTHS,
  type JalaliDate,
} from "@/lib/jalali-utils";
import {
  startOfMonth,
  endOfMonth,
  startOfWeek,
  endOfWeek,
  eachDayOfInterval,
  isSameDay,
  isSameMonth,
} from "date-fns";
import { displayNow, isDisplayToday } from "@/lib/timezone";
import { formatDateRange, intlLocaleOf } from "@/lib/format-date-range";

/**
 * Unified calendar-locale hook.
 *
 * Abstracts away the differences between Gregorian and Jalali calendars so
 * view components can render dates correctly without calendar-specific
 * branching.
 */
export function useCalendarLocale() {
  const locale = useLocale();
  const firstDayOfWeek = useSettingsStore((s) => s.firstDayOfWeek);
  const isJalali = shouldUseJalaliCalendar(locale);

  // Normalize weekStart for date-fns (0 | 1 | 2 | 3 | 4 | 5 | 6)
  const weekStartsOn = useMemo(() => {
    if (firstDayOfWeek === 0) return 0 as const;
    if (firstDayOfWeek === 6) return 6 as const;
    return 1 as const;
  }, [firstDayOfWeek]);

  // Ordered day-header translation keys
  const dayHeaderKeys = useMemo(
    () => getDayHeaderKeys(weekStartsOn),
    [weekStartsOn],
  );

  // ------------------------------------------------------------------
  // Month-grid construction
  // ------------------------------------------------------------------

  /** Build the flat array of Dates that populate a full month grid. */
  const getMonthGridDays = (referenceDate: Date): Date[] => {
    if (isJalali) {
      const { jy, jm } = toJalali(referenceDate);
      return eachDayOfJalaliMonth(jy, jm, weekStartsOn);
    }
    const monthStart = startOfMonth(referenceDate);
    const monthEnd = endOfMonth(referenceDate);
    const gridStart = startOfWeek(monthStart, { weekStartsOn });
    const gridEnd = endOfWeek(monthEnd, { weekStartsOn });
    return eachDayOfInterval({ start: gridStart, end: gridEnd });
  };

  // ------------------------------------------------------------------
  // Day-level queries
  // ------------------------------------------------------------------

  /** Is the given date "today" in the active calendar system? */
  const checkIsToday = (date: Date): boolean => {
    if (isJalali) {
      const now = toJalali(displayNow());
      const target = toJalali(date);
      return now.jy === target.jy && now.jm === target.jm && now.jd === target.jd;
    }
    return isDisplayToday(date);
  };

  /** Does the date belong to the same month as the reference date? */
  const checkIsSameMonth = (date: Date, referenceDate: Date): boolean => {
    if (isJalali) {
      const a = toJalali(date);
      const b = toJalali(referenceDate);
      return a.jy === b.jy && a.jm === b.jm;
    }
    return isSameMonth(date, referenceDate);
  };

  /** Are two dates the same calendar day? */
  const checkIsSameDay = (date1: Date, date2: Date): boolean => {
    if (isJalali) {
      const a = toJalali(date1);
      const b = toJalali(date2);
      return a.jy === b.jy && a.jm === b.jm && a.jd === b.jd;
    }
    return isSameDay(date1, date2);
  };

  // ------------------------------------------------------------------
  // Display formatting
  // ------------------------------------------------------------------

  /** Day-of-month number for a calendar cell (string). */
  const formatDayNumber = (date: Date): string => {
    if (isJalali) {
      return String(toJalali(date).jd);
    }
    return String(date.getDate());
  };

  /** Full month + year label for the toolbar / mini-calendar header. */
  const formatMonthYear = (date: Date): string => {
    if (isJalali) {
      const { jy, jm } = toJalali(date);
      return `${JALALI_MONTHS[jm - 1]} ${jy}`;
    }
    // The language's order: "2026年11月" in Japanese, not "11月 2026".
    return date.toLocaleString(intlLocaleOf(locale), { month: "long", year: "numeric" });
  };

  /** Short month + year for mobile. */
  const formatMonthYearShort = (date: Date): string => {
    if (isJalali) {
      const { jy, jm } = toJalali(date);
      const short = JALALI_MONTHS[jm - 1].slice(0, 3);
      return `${short} ${jy}`;
    }
    return date.toLocaleString(intlLocaleOf(locale), { month: "short", year: "numeric" });
  };

  /** Week range label (e.g. "6 – 12 Farvardin 1404"). */
  const formatWeekRange = (weekStart: Date): string => {
    const weekEnd = new Date(weekStart);
    weekEnd.setDate(weekEnd.getDate() + 6);
    if (isJalali) {
      const start = toJalali(weekStart);
      const end = toJalali(weekEnd);
      if (start.jm === end.jm) {
        return `${start.jd} – ${end.jd} ${JALALI_MONTHS[start.jm - 1]} ${start.jy}`;
      }
      return `${start.jd} ${JALALI_MONTHS[start.jm - 1]} – ${end.jd} ${JALALI_MONTHS[end.jm - 1]} ${end.jy}`;
    }
    // The language's own range (pim-13): "2.–8. Nov. 2026", not "2. Nov. – 8, 2026".
    return formatDateRange(intlLocaleOf(locale), weekStart, weekEnd, {
      day: "numeric",
      month: "short",
      year: "numeric",
    });
  };

  /** Short week range for mobile. */
  const formatWeekRangeShort = (weekStart: Date): string => {
    const weekEnd = new Date(weekStart);
    weekEnd.setDate(weekEnd.getDate() + 6);
    if (isJalali) {
      const start = toJalali(weekStart);
      const end = toJalali(weekEnd);
      return `${start.jd}/${start.jm} – ${end.jd}/${end.jm}`;
    }
    return formatDateRange(intlLocaleOf(locale), weekStart, weekEnd, {
      day: "numeric",
      month: "short",
    });
  };

  /**
   * Any date range in the language's own pattern (pim-13), e.g. a multi-day
   * event: Intl's formatRange, in the Persian calendar for Jalali.
   */
  const formatDateRangeLabel = (start: Date, end: Date, options: Intl.DateTimeFormatOptions): string =>
    formatDateRange(intlLocaleOf(locale, { persianCalendar: isJalali }), start, end, options);

  /** Full date label for accessibility / tooltips. */
  const formatFullDate = (date: Date): string => {
    if (isJalali) {
      const { jy, jm, jd } = toJalali(date);
      const dayOfWeek = date.getDay();
      const dayNames = getDayHeaderKeys(weekStartsOn);
      // Map from Gregorian day index to the correct label from the reordered list
      const dayIdx = (dayOfWeek - weekStartsOn + 7) % 7;
      const dayKey = dayNames[dayIdx];
      return `${dayKey} ${jd} ${JALALI_MONTHS[jm - 1]} ${jy}`;
    }
    return date.toLocaleString(locale === "en" ? "en-US" : locale, {
      weekday: "long",
      month: "long",
      day: "numeric",
      year: "numeric",
    });
  };

  /**
   * Short day label for a phone's title ("Oct 28", "28. Okt."). The weekday
   * is in the day's header right under it, and with it German no longer fit.
   */
  const formatDayShort = (date: Date): string => {
    if (isJalali) {
      const { jm, jd } = toJalali(date);
      return `${jd} ${JALALI_MONTHS[jm - 1]}`;
    }
    return date.toLocaleString(locale === "en" ? "en-US" : locale, {
      month: "short",
      day: "numeric",
    });
  };

  // ------------------------------------------------------------------
  // Calendar-system-aware month/year getters (for navigation, etc.)
  // All return values use **0-based** months to stay compatible with
  // date-fns functions like `setMonth`.
  // ------------------------------------------------------------------

  const getMonth = (date: Date): number => {
    if (isJalali) return toJalali(date).jm - 1; // 0-11
    return date.getMonth(); // 0-11
  };

  const getYear = (date: Date): number => {
    if (isJalali) return toJalali(date).jy;
    return date.getFullYear();
  };

  /** Keys for the month selector dropdown (used by MiniCalendar). */
  const monthLabelKeys = useMemo(() => {
    if (isJalali) {
      return [
        "far", "ord", "kho", "tir", "mor", "sha",
        "meh", "aba", "aza", "dey", "bah", "esf",
      ];
    }
    return [
      "jan", "feb", "mar", "apr", "may", "jun",
      "jul", "aug", "sep", "oct", "nov", "dec",
    ];
  }, [isJalali]);

  return {
    isJalali,
    weekStartsOn,
    dayHeaderKeys,
    getMonthGridDays,
    checkIsToday,
    checkIsSameMonth,
    checkIsSameDay,
    formatDayNumber,
    formatMonthYear,
    formatMonthYearShort,
    formatWeekRange,
    formatWeekRangeShort,
    formatDateRangeLabel,
    formatFullDate,
    formatDayShort,
    getMonth,
    getYear,
    monthLabelKeys,
  } as const;
}
