import { useCallback } from "react";
import { useTranslations, useLocale } from "next-intl";
import { format } from "date-fns";
import { toJalali, shouldUseJalaliCalendar, JALALI_MONTHS } from "@/lib/jalali-utils";

/**
 * Returns a memoized function that formats a calendar event date
 * using the current locale for day and month names.
 *
 * The string will be in the format: "EEE, MMM d, yyyy"
 *
 * For example: "Wed, Apr 29, 2026" (en)
 *              "Qua, Abr 29, 2026" (pt)
 *
 * When the Jalali calendar is active (fa locale), the format uses
 * Persian day/month names with the Jalali year, e.g.:
 *              "چهارشنبه, ۹ اردیبهشت ۱۴۰۵"
 */
export function useFormatEventDate(): (date: Date) => string {
  const t = useTranslations("calendar");
  const locale = useLocale();
  const isJalali = shouldUseJalaliCalendar(locale);

  return useCallback(
    (date: Date): string => {
      if (isJalali) {
        const { jy, jm, jd } = toJalali(date);
        // Use Gregorian day-of-week for the translation key (date-fns format)
        const dayOfWeek = format(date, "EEE").toLowerCase();
        const monthName = JALALI_MONTHS[jm - 1];
        return `${t(`days.${dayOfWeek}`)}, ${jd} ${monthName} ${jy}`;
      }

      const dayOfWeek = format(date, "EEE").toLowerCase();
      const month = format(date, "MMM").toLowerCase();
      const day = format(date, "d");
      const year = format(date, "yyyy");
      return `${t(`days.${dayOfWeek}`)}, ${t(`months.${month}`)} ${day}, ${year}`;
    },
    [t, isJalali]
  );
}
