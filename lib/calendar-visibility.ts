/**
 * Which calendars the user showed or hid, kept with the synced settings
 * (calendarVisibility), so a sign-out or another browser doesn't bring a
 * hidden calendar back (#1845). Only a calendar the user picked has an entry;
 * the others follow the calendar's defaults.
 *
 * Login (AccountEntry.id) -> the calendar's id within that login -> shown.
 * The id within a login is the store id without the `<login>::` prefix the
 * calendar gets while several logins are shown: its own id, or
 * `<accountId>:<id>` for a calendar of an account shared with the login.
 */

import type { Calendar } from '@/lib/jmap/types';
import { BIRTHDAY_CALENDAR_ID } from '@/lib/birthday-calendar';

export type CalendarVisibilityChoices = Record<string, Record<string, boolean>>;

const LOGIN_DELIMITER = '::';

type CalendarRef = Pick<Calendar, 'id'> & Partial<Pick<Calendar, 'localAccountId' | 'isTasksOnly'>>;

/** Where `calendar`'s choice is kept; `login` names the login of a calendar without a prefix. Null for birthdays, which are a setting of their own. */
export function visibilityKeyOf(calendar: CalendarRef, login: string | null): { login: string; key: string } | null {
  if (calendar.id === BIRTHDAY_CALENDAR_ID) return null;
  const owner = calendar.localAccountId ?? login;
  if (!owner) return null;
  const prefix = calendar.localAccountId ? `${calendar.localAccountId}${LOGIN_DELIMITER}` : '';
  const key = prefix && calendar.id.startsWith(prefix) ? calendar.id.slice(prefix.length) : calendar.id;
  return { login: owner, key };
}

/** The user's choice for `calendar`, or undefined when there is none. */
export function visibilityChoiceOf(choices: CalendarVisibilityChoices, calendar: CalendarRef, login: string | null): boolean | undefined {
  const at = visibilityKeyOf(calendar, login);
  return at ? choices[at.login]?.[at.key] : undefined;
}

/** `choices` with `calendar` shown or hidden. */
export function withVisibilityChoice(
  choices: CalendarVisibilityChoices,
  calendar: CalendarRef,
  login: string | null,
  shown: boolean,
): CalendarVisibilityChoices {
  const at = visibilityKeyOf(calendar, login);
  if (!at || choices[at.login]?.[at.key] === shown) return choices;
  return { ...choices, [at.login]: { ...choices[at.login], [at.key]: shown } };
}

/** `selection` with the choices for `calendars` applied: a shown one in it, a hidden one out. */
export function applyVisibilityChoices(
  selection: string[],
  calendars: CalendarRef[],
  choices: CalendarVisibilityChoices,
  login: string | null,
): string[] {
  const result = [...selection];
  const selected = new Set(selection);
  const hidden = new Set<string>();
  for (const calendar of calendars) {
    const choice = visibilityChoiceOf(choices, calendar, login);
    if (choice === true && !selected.has(calendar.id)) {
      result.push(calendar.id);
      selected.add(calendar.id);
    } else if (choice === false) {
      hidden.add(calendar.id);
    }
  }
  return hidden.size > 0 ? result.filter((id) => !hidden.has(id)) : result;
}

/**
 * The calendars this browser kept hidden before the choices were synced, as
 * choices of the logins that have none yet: each calendar it knows and
 * doesn't show. Task lists stay out; the event grid never shows them.
 */
export function choicesFromLocalSelection(
  choices: CalendarVisibilityChoices,
  selection: string[],
  known: string[],
  calendars: CalendarRef[],
  login: string | null,
): CalendarVisibilityChoices {
  const shown = new Set(selection);
  const seen = new Set(known);
  let next = choices;
  for (const calendar of calendars) {
    if (calendar.isTasksOnly || shown.has(calendar.id) || !seen.has(calendar.id)) continue;
    const at = visibilityKeyOf(calendar, login);
    if (!at || choices[at.login]) continue;
    next = { ...next, [at.login]: { ...next[at.login], [at.key]: false } };
  }
  return next;
}

/** A calendarVisibility value from storage, a synced blob or a file: anything malformed is dropped. */
export function sanitizeVisibilityChoices(value: unknown): CalendarVisibilityChoices {
  const out: CalendarVisibilityChoices = {};
  if (!value || typeof value !== 'object' || Array.isArray(value)) return out;
  for (const [login, map] of Object.entries(value)) {
    if (login === '__proto__' || login.length > 320 || !map || typeof map !== 'object' || Array.isArray(map)) continue;
    const entries = Object.entries(map).filter(([key, shown]) => key !== '__proto__' && key.length <= 400 && typeof shown === 'boolean');
    if (entries.length > 0) out[login] = Object.fromEntries(entries) as Record<string, boolean>;
  }
  return out;
}
