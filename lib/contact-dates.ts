import type { AnniversaryDate, PartialDate } from "@/lib/jmap/types";
import type { DateLocale } from "@/stores/settings-store";
import { resolveDateLocale } from "@/lib/utils";

/**
 * A contact's date (birthday, anniversary, created) in the UI language:
 * "15. März 1988", "March 15", "1988". A date without a year (vCard
 * "--03-15") or without a day shows only what it has. A date order picked
 * in the region settings (`dateLocale`) gives a numeric date in that order
 * instead: "15/03/1988", "1988-03-15", "15/03".
 */
export function formatContactDate(dateInput: AnniversaryDate | string, locale: string, dateLocale?: DateLocale): string {
  const parts = contactDateParts(dateInput);
  const { year, month, day } = parts;
  try {
    if (month && day) {
      // A leap year, so 29 February survives without a year.
      const d = new Date(Date.UTC(year ?? 2000, month - 1, day));
      if (dateLocale && dateLocale !== "auto") {
        return new Intl.DateTimeFormat(resolveDateLocale(dateLocale, locale), { timeZone: "UTC", month: "2-digit", day: "2-digit", ...(year ? { year: "numeric" } : {}) }).format(d);
      }
      return new Intl.DateTimeFormat(locale, { timeZone: "UTC", month: "long", day: "numeric", ...(year ? { year: "numeric" } : {}) }).format(d);
    }
    if (month) {
      const d = new Date(Date.UTC(year ?? 2000, month - 1, 1));
      return new Intl.DateTimeFormat(locale, { timeZone: "UTC", month: "long", ...(year ? { year: "numeric" } : {}) }).format(d);
    }
    if (year) return String(year);
  } catch { /* an unknown locale: below */ }
  return typeof dateInput === "string" ? dateInput : JSON.stringify(dateInput);
}

/** The year, month and day a contact's date names, whichever it has. */
export function contactDateParts(dateInput: AnniversaryDate | string): { year?: number; month?: number; day?: number } {
  if (typeof dateInput === "object" && dateInput !== null) {
    if (dateInput["@type"] === "Timestamp" && typeof (dateInput as { utc?: unknown }).utc === "string") {
      const d = new Date((dateInput as { utc: string }).utc);
      return isNaN(d.getTime()) ? {} : { year: d.getUTCFullYear(), month: d.getUTCMonth() + 1, day: d.getUTCDate() };
    }
    const pd = dateInput as PartialDate;
    return { year: pd.year, month: pd.month, day: pd.day };
  }
  const s = String(dateInput);
  if (s.startsWith("--")) {
    const [m, d] = s.substring(2).split("-");
    return { month: parseInt(m, 10) || undefined, day: d ? parseInt(d, 10) || undefined : undefined };
  }
  const iso = /^(\d{4})-(\d{2})(?:-(\d{2}))?/.exec(s);
  if (iso) return { year: Number(iso[1]), month: Number(iso[2]), day: iso[3] ? Number(iso[3]) : undefined };
  const d = new Date(s);
  return isNaN(d.getTime()) ? {} : { year: d.getUTCFullYear(), month: d.getUTCMonth() + 1, day: d.getUTCDate() };
}
