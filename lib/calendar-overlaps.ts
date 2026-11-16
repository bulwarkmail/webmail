import type { CalendarEvent } from '@/lib/jmap/types';
import { getEventEndDate, getEventStartDate } from '@/lib/calendar-utils';
import { isDeclinedByUser } from '@/lib/calendar-participants';

/** The time an event in the editor takes, in display dates; an all-day one runs from midnight to midnight. */
export interface OverlapWindow {
  start: Date;
  end: Date;
  allDay: boolean;
}

/**
 * Loaded events that share time with the one in the editor (#1685), first
 * one first. Events that don't take the time are left out: shown as free,
 * cancelled, or declined by the user. All-day events are compared with
 * all-day events only, so a holiday doesn't warn about every meeting on it.
 * `excludeUid` is the edited event's own UID, which covers every occurrence
 * of its series. Events that only touch (one ends as the next starts) don't
 * overlap.
 */
export function findOverlappingEvents(
  window: OverlapWindow,
  events: readonly CalendarEvent[],
  options: { excludeUid?: string | null; userEmailsFor?: (event: CalendarEvent) => string[] } = {},
): CalendarEvent[] {
  const from = window.start.getTime();
  const to = window.end.getTime();
  if (Number.isNaN(from) || Number.isNaN(to) || to < from) return [];
  const found: Array<{ event: CalendarEvent; start: number }> = [];
  for (const event of events) {
    if (!event.start) continue;
    if (options.excludeUid && event.uid === options.excludeUid) continue;
    if (!!event.showWithoutTime !== window.allDay) continue;
    if (event.freeBusyStatus === 'free' || event.status === 'cancelled') continue;
    const start = getEventStartDate(event).getTime();
    const end = getEventEndDate(event).getTime();
    if (Number.isNaN(start) || Number.isNaN(end)) continue;
    // An event that lasts no time is a moment: it counts from its start.
    const until = Math.max(end, start + 1);
    const overlaps = from === to ? start <= from && from < until : start < to && from < until;
    if (!overlaps) continue;
    if (isDeclinedByUser(event, options.userEmailsFor?.(event))) continue;
    found.push({ event, start });
  }
  return found.sort((a, b) => a.start - b.start).map((f) => f.event);
}
