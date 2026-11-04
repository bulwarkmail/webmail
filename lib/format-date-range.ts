/**
 * A date range as the language writes it (pim-13): "2.–8. Nov. 2026" in
 * German, "Nov 2 – 8, 2026" in English, "2026年11月2日～8日" in Japanese.
 * A range glued together by hand ("2. Nov. – 8, 2026") read wrong in every
 * language but English.
 *
 * The dates are display dates (their local fields are the wall clock to
 * show), so no time zone is passed: Intl reads them in the runtime's zone,
 * as toLocaleString did.
 */

type RangeFormatter = Intl.DateTimeFormat & { formatRange?: (start: Date, end: Date) => string };

/** The Intl locale for an app locale: "en" is American English in the app. */
export function intlLocaleOf(locale: string, options?: { persianCalendar?: boolean }): string {
  const base = locale === "en" ? "en-US" : locale;
  return options?.persianCalendar ? `${base}-u-ca-persian` : base;
}

export function formatDateRange(
  locale: string,
  start: Date,
  end: Date,
  options: Intl.DateTimeFormatOptions,
): string {
  let formatter: RangeFormatter;
  try {
    formatter = new Intl.DateTimeFormat(locale, options);
  } catch {
    formatter = new Intl.DateTimeFormat("en-US", options);
  }
  if (typeof formatter.formatRange === "function") {
    try {
      return formatter.formatRange(start, end);
    } catch {
      // An invalid date: fall through to the two dates.
    }
  }
  return `${formatter.format(start)} – ${formatter.format(end)}`;
}
