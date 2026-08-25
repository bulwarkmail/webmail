import type { CalendarEvent, Calendar, CalendarRights } from '@/lib/jmap/types';
import { isOrganizer, getUserParticipantId } from '@/lib/calendar-participants';

export type EventEditability = 'editable' | 'rsvp-only' | 'read-only';

export interface EditabilityContext {
  /** Viewer's calendars by id; only their `myRights` is read. */
  calendarsById: ReadonlyMap<string, Pick<Calendar, 'myRights'>>;
  /** Identities + aliases; only refines owner/participant detection, never the gate. */
  userCalendarAddresses: string[];
  /** Client-side external iCal (webcal/ICS) subscriptions - always read-only. */
  isSubscriptionCalendar: (calendarId: string) => boolean;
}

/**
 * Whether new events may be created in / moved into this calendar: writable and
 * not a (read-only) iCal subscription. Bulwark subscriptions are real Stalwart
 * calendars with writable myRights, so the flag must be checked too (issue #762).
 */
export function canCreateEventsIn(
  calendar: Pick<Calendar, 'id' | 'myRights'>,
  isSubscriptionCalendar?: (calendarId: string) => boolean,
): boolean {
  if (isSubscriptionCalendar?.(calendar.id)) return false;
  const r = calendar.myRights;
  return !r || r.mayWriteAll || r.mayWriteOwn;
}

/** Ownerless (plain, non-scheduled) events are editable under `mayWriteOwn`. */
export function eventHasNoOwner(event: CalendarEvent): boolean {
  if (event.organizerCalendarAddress) return false;
  if (event.replyTo && Object.keys(event.replyTo).length > 0) return false;
  if (event.participants) {
    for (const p of Object.values(event.participants)) {
      if (p.roles?.owner) return false;
    }
  }
  return true;
}

/**
 * Editability gated on the calendar's `myRights` FIRST, then identity - so
 * read-only/subscription calendars stay read-only and an alias organizer can't
 * over-open events the user can't write. (Stalwart: organizer identity does not
 * confer calendar write; the ACL does.)
 */
export function getEventEditability(
  event: CalendarEvent,
  ctx: EditabilityContext,
): EventEditability {
  const calIds = Object.keys(event.calendarIds ?? {});

  // Subscriptions have no write path and myRights can't describe them.
  if (calIds.some((id) => ctx.isSubscriptionCalendar(id))) return 'read-only';

  const rights = calIds
    .map((id) => ctx.calendarsById.get(id)?.myRights)
    .filter((r): r is CalendarRights => Boolean(r));

  // Rights not loaded: allow only the user's own origin copy for now.
  if (rights.length === 0) return event.isOrigin ? 'editable' : 'read-only';

  // Every calendar must grant the right (a read-only member blocks edit).
  const may = (k: keyof CalendarRights) => rights.every((r) => r[k]);
  const isOwner =
    isOrganizer(event, ctx.userCalendarAddresses) || eventHasNoOwner(event);

  if (may('mayWriteAll')) return 'editable';
  if (may('mayWriteOwn') && isOwner) return 'editable';

  const isParticipant =
    getUserParticipantId(event, ctx.userCalendarAddresses) != null;
  if (may('mayRSVP') && isParticipant) return 'rsvp-only';

  return 'read-only';
}
