import type { Calendar, CalendarEvent } from '@/lib/jmap/types';
import { sanitizeOutgoingCalendarEventData } from '@/lib/calendar-event-normalization';
import { generateUUID } from '@/lib/utils';
import { canCreateEventsIn } from '@/lib/calendar-editability';
import { CALENDAR_COLORS } from '@/lib/shared-calendar-colors';

/**
 * Which calendars something new can go into, and how a chooser groups them
 * when several accounts are signed in (pim-p2-2, p2-3, p2-4, p2-13).
 *
 * In the aggregated view every calendar carries the local account it came
 * from (`localAccountId`); with one account none does, and there is one group.
 */

/** What a chooser needs of a signed-in account. */
export interface TargetAccount {
  id: string;
  email?: string;
  username?: string;
}

/** The account's address, as the account menu names it. Never the display name: two accounts of one person share it. */
export function accountAddress(account: TargetAccount | undefined): string {
  return account?.email || account?.username || account?.id || '';
}

/** The local account a calendar belongs to; '' with one account. */
export function calendarAccountKey(calendar: Pick<Calendar, 'localAccountId'>): string {
  return calendar.localAccountId ?? '';
}

/**
 * Calendars a new event can go into: they show in the grid (not a task
 * list), are writable and not a feed. `keepId` stays listed whatever it is,
 * so an event that already sits in a task list keeps its one option.
 */
export function eventTargets(
  calendars: Calendar[],
  isSubscriptionCalendar?: (id: string) => boolean,
  keepId?: string,
): Calendar[] {
  return calendars.filter((c) => c.id === keepId || (!c.isTasksOnly && !c.isCompany && canCreateEventsIn(c, isSubscriptionCalendar)));
}

/**
 * Calendars a task can go into: task lists. A task list is a calendar that
 * holds only tasks, or one that holds tasks already (`holdingTasks`). An
 * account with neither keeps its default calendar, which is where both
 * Stalwarts put a task when nothing else is chosen; without it that account
 * couldn't take a task at all.
 */
export function taskTargets(
  calendars: Calendar[],
  isSubscriptionCalendar?: (id: string) => boolean,
  options: { keepId?: string; holdingTasks?: Iterable<string> } = {},
): Calendar[] {
  const holding = new Set(options.holdingTasks ?? []);
  const writable = calendars.filter((c) => !c.isCompany && canCreateEventsIn(c, isSubscriptionCalendar));
  const lists = writable.filter((c) => c.isTasksOnly || holding.has(c.id));
  const covered = new Set(lists.map(calendarAccountKey));
  const fallbacks: Calendar[] = [];
  for (const cal of writable) {
    const key = calendarAccountKey(cal);
    if (covered.has(key) || cal.isShared) continue;
    const own = writable.filter((c) => calendarAccountKey(c) === key && !c.isShared);
    const pick = own.find((c) => c.isDefault) ?? own[0];
    if (pick) fallbacks.push(pick);
    covered.add(key);
  }
  const chosen = new Set([...lists, ...fallbacks].map((c) => c.id));
  return calendars.filter((c) => chosen.has(c.id) || c.id === options.keepId);
}

export interface CalendarGroup<T extends Pick<Calendar, 'localAccountId'> = Calendar> {
  /** The local account id, '' for calendars of the one signed-in account. */
  key: string;
  /** The account's address; null when there's only one group. */
  label: string | null;
  calendars: T[];
}

/**
 * Calendars by account: the active one first, then the others in the order
 * they were added, each named by its address. One group without a label
 * when only one account is there.
 */
export function groupCalendarsByAccount<T extends Pick<Calendar, 'localAccountId'>>(
  calendars: T[],
  accounts: TargetAccount[],
  activeAccountId: string | null | undefined,
): CalendarGroup<T>[] {
  const byKey = new Map<string, T[]>();
  for (const cal of calendars) {
    const key = calendarAccountKey(cal);
    byKey.set(key, [...(byKey.get(key) ?? []), cal]);
  }
  if (byKey.size <= 1) {
    const [key = ''] = byKey.keys();
    return calendars.length > 0 ? [{ key, label: null, calendars }] : [];
  }
  const order = [
    ...(activeAccountId ? [activeAccountId] : []),
    ...accounts.map((a) => a.id).filter((id) => id !== activeAccountId),
    ...byKey.keys(),
  ];
  const groups: CalendarGroup<T>[] = [];
  for (const key of order) {
    const list = byKey.get(key);
    if (!list) continue;
    byKey.delete(key);
    const account = accounts.find((a) => a.id === key);
    groups.push({ key, label: key ? accountAddress(account) || key : null, calendars: list });
  }
  return groups;
}

/** Whether a calendar belongs to the account on screen. With one account, all do. */
function ofAccount(cal: Calendar, activeAccountId: string | null | undefined): boolean {
  return !cal.localAccountId || cal.localAccountId === activeAccountId;
}

/**
 * The calendar a new event preselects: the one last picked for the account
 * on screen, else that account's default calendar, else its first own one.
 * Another account's calendar only when the active one has none.
 */
export function preferredTarget(
  targets: Calendar[],
  activeAccountId: string | null | undefined,
  lastPicked?: Record<string, string>,
): Calendar | undefined {
  const accountKey = targets.some((c) => c.localAccountId) ? (activeAccountId ?? '') : '';
  const remembered = lastPicked?.[accountKey];
  const mine = targets.filter((c) => ofAccount(c, activeAccountId));
  return (remembered ? mine.find((c) => c.id === remembered) : undefined)
    ?? mine.find((c) => c.isDefault && !c.isShared)
    ?? mine.find((c) => !c.isShared)
    ?? mine[0]
    ?? targets.find((c) => c.isDefault)
    ?? targets[0];
}

/** The key `preferredTarget` remembers a pick under. */
export function rememberKey(calendar: Pick<Calendar, 'localAccountId'>): string {
  return calendarAccountKey(calendar);
}

/**
 * Each account's default calendar in a colour of its own (pim-p2-3). Both
 * Stalwarts give every new account's default calendar the same blue, so two
 * accounts' meetings looked alike. Only for display: the server keeps its
 * colour, and a colour the user set on the server that differs stays.
 */
export function distinctAccountDefaultColors<T extends Calendar>(calendars: T[]): T[] {
  const accounts = new Set(calendars.map(calendarAccountKey));
  if (accounts.size < 2) return calendars;
  const norm = (c: string | null | undefined) => (c ?? CALENDAR_COLORS[0]).toLowerCase();
  const used = new Set(calendars.map((c) => norm(c.color)));
  const taken = new Set<string>();
  const changed = new Map<string, string>();
  for (const cal of calendars) {
    if (!cal.isDefault || cal.isShared || !cal.localAccountId) continue;
    const color = norm(cal.color);
    if (!taken.has(color)) {
      taken.add(color);
      continue;
    }
    const next = CALENDAR_COLORS.find((c) => !used.has(c.toLowerCase()))
      ?? CALENDAR_COLORS.find((c) => !taken.has(c.toLowerCase()))
      ?? CALENDAR_COLORS[0];
    used.add(next.toLowerCase());
    taken.add(next.toLowerCase());
    changed.set(cal.id, next);
  }
  if (changed.size === 0) return calendars;
  return calendars.map((c) => (changed.has(c.id) ? { ...c, color: changed.get(c.id)! } : c));
}

/**
 * Where "Copy to <account>" puts an event (pim-p2-16): for every other
 * signed-in account with a calendar for events, that account's own default
 * one (or its first). An event moves only within its own account, since the
 * update goes to its own server, so the other account gets a copy.
 */
export function copyTargetsFor(
  event: Pick<CalendarEvent, 'localAccountId'>,
  targets: Calendar[],
  accounts: TargetAccount[],
): Array<{ account: TargetAccount; calendar: Calendar }> {
  const from = event.localAccountId;
  if (!from) return [];
  const result: Array<{ account: TargetAccount; calendar: Calendar }> = [];
  for (const account of accounts) {
    if (account.id === from) continue;
    const own = targets.filter((c) => c.localAccountId === account.id && !c.isShared);
    const calendar = own.find((c) => c.isDefault) ?? own[0];
    if (calendar) result.push({ account, calendar });
  }
  return result;
}

/**
 * The new event for a copy in another account: the same time, place, text
 * and repeat rule, under a new UID. Not its participants: the copy is the
 * user's own entry, and creating it must not invite anyone or answer for
 * the other account. Skipped occurrences stay skipped; changed ones don't
 * carry over, since they hold the participants' answers.
 */
export function buildCopyToCalendarData(event: CalendarEvent, calendarId: string): Partial<CalendarEvent> {
  const data: Partial<CalendarEvent> = {
    uid: generateUUID(),
    title: event.title,
    description: event.description,
    start: event.start,
    duration: event.duration,
    timeZone: event.timeZone,
    showWithoutTime: event.showWithoutTime,
    calendarIds: { [calendarId]: true },
    status: event.status === 'cancelled' ? 'cancelled' : 'confirmed',
    freeBusyStatus: event.freeBusyStatus,
    privacy: event.privacy,
  };
  if (event.descriptionContentType) data.descriptionContentType = event.descriptionContentType;
  if (event.locations) data.locations = structuredClone(event.locations);
  if (event.virtualLocations) data.virtualLocations = structuredClone(event.virtualLocations);
  if (event.alerts) data.alerts = structuredClone(event.alerts);
  if (event.recurrenceRules?.length) {
    data.recurrenceRules = structuredClone(event.recurrenceRules);
    if (event.excludedRecurrenceRules?.length) data.excludedRecurrenceRules = structuredClone(event.excludedRecurrenceRules);
    const skipped = Object.entries(event.recurrenceOverrides ?? {}).filter(([, patch]) => (patch as { excluded?: boolean } | null)?.excluded === true);
    if (skipped.length) data.recurrenceOverrides = Object.fromEntries(skipped.map(([id]) => [id, { excluded: true }])) as CalendarEvent['recurrenceOverrides'];
  }
  return sanitizeOutgoingCalendarEventData(data);
}
