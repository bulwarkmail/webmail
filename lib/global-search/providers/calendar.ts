import { matchesTerms, type ParsedQuery } from '@/lib/global-search/query-parser';
import { getActiveLocalAccountId, indexAccounts } from '@/lib/global-search/accounts';
import type { CalendarHit, SearchAccount, SearchProvider } from '@/lib/global-search/types';
import { textConditions } from '@/lib/jmap/search-utils';
import type { Calendar, CalendarEvent, CalendarEventFilter } from '@/lib/jmap/types';
import { useCalendarStore } from '@/stores/calendar-store';

/** The text an event is found by: title, description, places and participants. */
export function eventFields(event: CalendarEvent): string[] {
  const fields: string[] = [event.title, event.description];
  for (const location of Object.values(event.locations ?? {})) if (location?.name) fields.push(location.name);
  for (const participant of Object.values(event.participants ?? {})) {
    const p = participant as { name?: string | null; email?: string | null };
    if (p.name) fields.push(p.name);
    if (p.email) fields.push(p.email);
  }
  return fields;
}

function calendarOf(event: CalendarEvent, calendars: Calendar[]): Calendar | undefined {
  for (const id of Object.keys(event.calendarIds ?? {})) {
    const calendar = calendars.find((c) => c.id === id || c.originalId === id);
    if (calendar?.name) return calendar;
  }
  return undefined;
}

function firstLocation(event: CalendarEvent): string {
  for (const location of Object.values(event.locations ?? {})) if (location?.name) return location.name;
  return '';
}

export function isRecurringEvent(event: CalendarEvent): boolean {
  return Boolean(event.recurrenceId) || (Array.isArray(event.recurrenceRules) && event.recurrenceRules.length > 0);
}

function toHit(event: CalendarEvent, account: SearchAccount, source: 'local' | 'remote', calendars: Calendar[]): CalendarHit {
  const location = firstLocation(event);
  const calendar = calendarOf(event, calendars);
  return {
    kind: 'calendar',
    serverUrl: account.serverUrl,
    localAccountId: account.localAccountId,
    jmapAccountId: event.accountId ?? account.client.getCalendarsAccountId(),
    id: event.originalId ?? event.id,
    accountLabel: account.label,
    title: event.title || '',
    subtitle: [calendar?.name ?? '', location].filter(Boolean).join(' · '),
    ...(calendar ? { collection: { kind: 'calendar' as const, name: calendar.name, isShared: calendar.isShared, rest: location } } : {}),
    date: event.start ?? null,
    source,
    event,
    isRecurring: isRecurringEvent(event),
  };
}

/**
 * `after:`/`before:` are calendar days; the server compares against instants.
 * Several text parts (see splitSearchText) go out as an AND of single-key
 * conditions, the bounds included: when it expands recurrences, 1.0 accepts
 * only one AND group, and a condition with several keys is a group itself.
 */
export function calendarFilterFor(parsed: ParsedQuery): CalendarEventFilter {
  const after = parsed.after ? `${parsed.after}T00:00:00Z` : undefined;
  const before = parsed.before ? `${parsed.before}T23:59:59Z` : undefined;
  const texts = textConditions(parsed.text).map(({ text }): CalendarEventFilter => ({ text }));
  if (texts.length === 1) {
    const filter = texts[0];
    if (after) filter.after = after;
    if (before) filter.before = before;
    return filter;
  }
  const bounds: CalendarEventFilter[] = [];
  if (after) bounds.push({ after });
  if (before) bounds.push({ before });
  return { operator: 'AND', conditions: [...bounds, ...texts] };
}

export const calendarProvider: SearchProvider = {
  kind: 'calendar',

  supports: (account) => account.client.supportsCalendars(),

  local: (parsed, accounts, limit) => {
    const byId = indexAccounts(accounts);
    const active = getActiveLocalAccountId();
    const { events, calendars } = useCalendarStore.getState();
    const hits: CalendarHit[] = [];
    // The store holds expanded occurrences; a matching series should appear
    // once, not once per occurrence in the visible window.
    const seenSeries = new Set<string>();
    for (const event of events) {
      const localAccountId = event.localAccountId ?? active;
      if (!localAccountId) continue;
      const account = byId.get(localAccountId);
      if (!account) continue;
      if (!matchesTerms(parsed.terms, eventFields(event))) continue;
      if (parsed.after && event.start && event.start.slice(0, 10) < parsed.after) continue;
      if (parsed.before && event.start && event.start.slice(0, 10) > parsed.before) continue;
      if (event.uid) {
        const seriesKey = `${localAccountId} ${event.uid}`;
        if (seenSeries.has(seriesKey)) continue;
        seenSeries.add(seriesKey);
      }
      hits.push(toHit(event, account, 'local', calendars));
      if (hits.length >= limit) break;
    }
    return hits;
  },

  remote: async (parsed, account, { limit, signal }) => {
    const events = await account.client.queryAllCalendarEvents(
      calendarFilterFor(parsed),
      [{ property: 'start', isAscending: false }],
      limit,
      { signal },
    );
    if (signal.aborted) throw Object.assign(new Error('aborted'), { name: 'AbortError' });
    const { calendars } = useCalendarStore.getState();
    const hits = events.slice(0, limit).map((event) => toHit(
      { ...event, localAccountId: account.localAccountId },
      account,
      'remote',
      calendars,
    ));
    return { hits, hasMore: events.length >= limit };
  },
};
