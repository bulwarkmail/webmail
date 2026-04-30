import { useCallback } from "react";
import { useTranslations } from "next-intl";
import { format } from "date-fns";

/**
 * Returns a memoized function that formats a calendar event date
 * using the current locale for day and month names.
 * 
 * The string will be in the format: "EEE, MMM d, yyyy"
 * 
 * For example: "Wed, Apr 29, 2026" (en)
 *              "Qua, Abr 29, 2026" (pt)
 */
export function useFormatEventDate(): (date: Date) => string {
  const t = useTranslations("calendar");

  return useCallback(
    (date: Date): string => {
      const dayOfWeek = format(date, "EEE").toLowerCase();
      const month = format(date, "MMM").toLowerCase();
      const day = format(date, "d");
      const year = format(date, "yyyy");
      return `${t(`days.${dayOfWeek}`)}, ${t(`months.${month}`)} ${day}, ${year}`;
    },
    [t]
  );
}
