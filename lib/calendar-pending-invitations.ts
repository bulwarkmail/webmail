// The invitations the user hasn't answered yet (#1669), for the list in the
// calendar's sidebar: upcoming meetings of the user's own calendars where
// their answer is still "needs action", soonest first, one per series.

import type { IJMAPClient } from '@/lib/jmap/client-interface';
import type { CalendarEvent } from '@/lib/jmap/types';
import { gridReplyState } from '@/lib/calendar-reply-state';

/** How far ahead the list looks. */
export const PENDING_LOOKAHEAD_DAYS = 180;
/** Most events one look reads. */
const PENDING_QUERY_LIMIT = 500;

function startOf(event: CalendarEvent): string {
  return event.utcStart || event.start || '';
}

/**
 * The events of `events` the user still has to answer: their participant
 * says "needs action", they don't organise it, and it isn't cancelled.
 * Shared calendars are left out: an invitation there is the owner's.
 */
export function pendingInvitations(
  events: CalendarEvent[],
  userEmailsFor: (event: CalendarEvent) => string[],
): CalendarEvent[] {
  const seen = new Set<string>();
  return events
    .filter((event) => !event.isShared && gridReplyState(event, userEmailsFor(event)) === 'needs-action')
    .sort((a, b) => startOf(a).localeCompare(startOf(b)))
    .filter((event) => {
      const key = event.uid || event.id;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
}

/**
 * The event an answer goes to: a series as a whole, not the occurrence the
 * server expanded (which the list shows as the series' next date).
 */
export function answerTargetId(event: CalendarEvent): string {
  return event.recurrenceId && event.baseEventId ? event.baseEventId : event.id;
}

/** The user's own events from `now` on, as the server has them (it may list each occurrence of a series). */
export function fetchUpcomingEvents(client: Pick<IJMAPClient, 'queryCalendarEvents'>, now: Date, signal?: AbortSignal): Promise<CalendarEvent[]> {
  const before = new Date(now.getTime() + PENDING_LOOKAHEAD_DAYS * 24 * 60 * 60 * 1000);
  return client.queryCalendarEvents(
    { after: now.toISOString(), before: before.toISOString() },
    [{ property: 'start', isAscending: true }],
    PENDING_QUERY_LIMIT,
    undefined,
    { signal },
  );
}
