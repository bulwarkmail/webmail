import type { Calendar } from '@/lib/jmap/types';

// Names compare the way the user reads them: accents and case are ignored, and
// "Team 2" comes before "Team 10". Made on first use: building a collator loads
// the language's sorting data, which cost the page's start ~15 ms on the rig.
let nameCollator: Intl.Collator | null = null;
const collator = () => (nameCollator ??= new Intl.Collator(undefined, { sensitivity: 'base', numeric: true }));

/**
 * JMAP Calendars: a calendar with a lower `sortOrder` is shown first, and
 * calendars with equal `sortOrder` are sorted by name.
 */
export function compareCalendars(a: Calendar, b: Calendar): number {
  return (a.sortOrder ?? 0) - (b.sortOrder ?? 0) || collator().compare(a.name ?? '', b.name ?? '');
}

/**
 * Calendars of one account (and, in the Pro shell, one local account) stay
 * together: the user's own first, then each sharing account, as fetched.
 */
export function calendarAccountKey(calendar: Calendar): string {
  return `${calendar.localAccountId ?? ''}\u0000${calendar.isShared ? calendar.accountId ?? '' : ''}`;
}

/**
 * The calendars in display order: grouped by account in the order the
 * accounts first appear, and by `sortOrder`, then name, within each account.
 */
export function sortCalendars(calendars: Calendar[]): Calendar[] {
  const accountRank = new Map<string, number>();
  for (const calendar of calendars) {
    const key = calendarAccountKey(calendar);
    if (!accountRank.has(key)) accountRank.set(key, accountRank.size);
  }
  return [...calendars].sort((a, b) =>
    accountRank.get(calendarAccountKey(a))! - accountRank.get(calendarAccountKey(b))! || compareCalendars(a, b),
  );
}

/**
 * `sortOrder` values that put `orderedIds` in that order: 1, 2, 3... Only the
 * calendars whose value changes are returned, so a move writes as little as
 * possible.
 */
export function sortOrderUpdates(calendars: Calendar[], orderedIds: string[]): { id: string; sortOrder: number }[] {
  const byId = new Map(calendars.map((calendar) => [calendar.id, calendar]));
  const updates: { id: string; sortOrder: number }[] = [];
  orderedIds.forEach((id, index) => {
    const calendar = byId.get(id);
    if (calendar && calendar.sortOrder !== index + 1) updates.push({ id, sortOrder: index + 1 });
  });
  return updates;
}

/**
 * The ids of the calendar's account in display order once it is moved next to
 * `targetId`: before the target when it moves up, after it when it moves down.
 * Null when the move is not possible (unknown ids, or another account).
 */
export function moveCalendar(calendars: Calendar[], calendarId: string, targetId: string): string[] | null {
  const sorted = sortCalendars(calendars);
  const moving = sorted.find((calendar) => calendar.id === calendarId);
  const target = sorted.find((calendar) => calendar.id === targetId);
  if (!moving || !target || moving === target) return null;
  const key = calendarAccountKey(moving);
  if (calendarAccountKey(target) !== key) return null;
  const group = sorted.filter((calendar) => calendarAccountKey(calendar) === key);
  const movingDown = group.indexOf(moving) < group.indexOf(target);
  const rest = group.filter((calendar) => calendar !== moving);
  rest.splice(rest.indexOf(target) + (movingDown ? 1 : 0), 0, moving);
  return rest.map((calendar) => calendar.id);
}
