import type { ThreadGroup } from "./jmap/types";
import { getWallClock } from "./timezone";

/**
 * The date groups of the message list, as Outlook has them: Today,
 * Yesterday, the weekday for the rest of the last seven days, then Last
 * week, Last month and Older. `weekday-<n>` names the day of the week,
 * 0 for Sunday as in `Date.getDay()`.
 */
export type ListDateGroup = "today" | "yesterday" | `weekday-${number}` | "last_week" | "last_month" | "older";

/** A run of the list under one header; `pinned` holds the pinned threads above the dates. */
export interface ListDateSection {
  key: ListDateGroup | "pinned";
  threads: ThreadGroup[];
}

const DAY_MS = 86_400_000;

/** The calendar day `date` falls on in `timeZone`, as a day count since 1970-01-01. */
function dayNumber(date: Date, timeZone: string): number {
  const w = getWallClock(date, timeZone);
  return Date.UTC(w.year, w.month - 1, w.day) / DAY_MS;
}

/**
 * Which date group `date` goes under, comparing calendar days in `timeZone`.
 * A date in the future is Today. Last month reaches back to the same day of
 * the month before (its last day when that month is shorter).
 */
export function listDateGroup(date: Date | string, now: Date, timeZone: string): ListDateGroup {
  const d = typeof date === "string" ? new Date(date) : date;
  if (Number.isNaN(d.getTime())) return "older";
  const today = dayNumber(now, timeZone);
  const day = dayNumber(d, timeZone);
  const daysAgo = today - day;
  if (daysAgo <= 0) return "today";
  if (daysAgo === 1) return "yesterday";
  if (daysAgo <= 6) return `weekday-${new Date(day * DAY_MS).getUTCDay()}`;
  if (daysAgo <= 13) return "last_week";
  const w = getWallClock(now, timeZone);
  // Day 0 of a month is the last day of the month before it.
  const monthBackLength = new Date(Date.UTC(w.year, w.month - 1, 0)).getUTCDate();
  const monthBack = Date.UTC(w.year, w.month - 2, Math.min(w.day, monthBackLength)) / DAY_MS;
  return day >= monthBack ? "last_month" : "older";
}

/**
 * The date a thread is placed by: its newest message newest first, its
 * oldest one oldest first, as the list order positions it.
 */
export function threadGroupDate(thread: ThreadGroup, oldestFirst: boolean): string {
  if (!oldestFirst) return thread.latestEmail.receivedAt;
  let earliest = thread.latestEmail.receivedAt;
  for (const email of thread.emails) {
    if (Date.parse(email.receivedAt) < Date.parse(earliest)) earliest = email.receivedAt;
  }
  return earliest;
}

/**
 * Splits threads, in list order, into the runs that each get a header:
 * pinned threads first when there are any, then a new run wherever the
 * date group changes.
 */
export function sectionThreadsByDate(
  threads: ThreadGroup[],
  { now, timeZone, oldestFirst }: { now: Date; timeZone: string; oldestFirst: boolean },
): ListDateSection[] {
  const sections: ListDateSection[] = [];
  for (const thread of threads) {
    const key = thread.hasPinned ? "pinned" : listDateGroup(threadGroupDate(thread, oldestFirst), now, timeZone);
    const last = sections[sections.length - 1];
    if (last?.key === key) last.threads.push(thread);
    else sections.push({ key, threads: [thread] });
  }
  return sections;
}

/** A Sunday, to name weekdays from. */
const SUNDAY = Date.UTC(2023, 0, 1);

/** The header text of a date group; `weekday-<n>` is the weekday's full name in `locale`, capitalised. */
export function listDateGroupLabel(
  key: ListDateSection["key"],
  t: (key: string) => string,
  locale: string | undefined,
): string {
  const weekday = /^weekday-(\d)$/.exec(key);
  if (weekday) {
    const name = new Intl.DateTimeFormat(locale, { weekday: "long", timeZone: "UTC" })
      .format(new Date(SUNDAY + Number(weekday[1]) * DAY_MS));
    return name.charAt(0).toLocaleUpperCase(locale) + name.slice(1);
  }
  return key === "pinned" ? t("pinned") : t(`date_groups.${key}`);
}
