import type { CalendarEvent, CalendarParticipant } from '@/lib/jmap/types';
import { normalizeAllDayDuration, normalizeCalendarEventLike, sanitizeOutgoingCalendarEventData } from '@/lib/calendar-event-normalization';

/**
 * The pure part of importing iCalendar data into a calendar: reading the
 * CalendarEvent/parse answer and turning a parsed event into the object
 * CalendarEvent/set creates. The calendar store's import (in the browser)
 * and the mailbox migration (on the server) both use it.
 */

/** The events CalendarEvent/parse found in `blobId`; throws when it couldn't read the blob. */
export function readParsedCalendarEvents(result: {
  parsed?: Record<string, unknown>;
  notParsable?: string[];
  notFound?: string[];
}, blobId: string): Partial<CalendarEvent>[] {
  if (result.notParsable && result.notParsable.includes(blobId)) {
    throw new Error('Invalid calendar file format');
  }
  if (result.notFound && result.notFound.includes(blobId)) {
    throw new Error('Uploaded file not found');
  }
  const parsed = result.parsed?.[blobId];
  if (!parsed) return [];
  return (Array.isArray(parsed) ? parsed : [parsed])
    .map((event) => normalizeCalendarEventLike(event as Partial<CalendarEvent>));
}

/**
 * Drop within-file UID duplicates (first occurrence wins).
 * CalendarEvent/parse already merges master + RECURRENCE-ID overrides
 * into one object, so anything still sharing a UID here is a corrupt
 * feed - creating both either fails ("UID already exists") or stores
 * two events under one UID, depending on the Stalwart version.
 */
export function dropDuplicateUids<T extends { uid?: string }>(events: T[]): T[] {
  const seenUids = new Set<string>();
  return events.filter((e) => {
    if (!e.uid) return true;
    if (seenUids.has(e.uid)) return false;
    seenUids.add(e.uid);
    return true;
  });
}

/** A parsed event as CalendarEvent/set creates it in `calendarId`, keeping UID, recurrence and alarms. */
export function prepareImportedEvent(event: Partial<CalendarEvent>, calendarId: string): Partial<CalendarEvent> {
  const src = sanitizeOutgoingCalendarEventData(event);
  let cleanParticipants: Record<string, CalendarParticipant> | null = null;
  if (src.participants) {
    cleanParticipants = {};
    for (const [key, p] of Object.entries(src.participants)) {
      const participant: Record<string, unknown> = {
        '@type': 'Participant',
        name: p.name,
        email: p.email,
        // calendarAddress carries the scheduling address in jscalendarbis
        // (Stalwart); sendTo is retired there, so it only serves as a
        // fallback source for events parsed from legacy RFC 8984 data.
        calendarAddress: p.calendarAddress || p.sendTo?.imip,
        description: p.description,
        kind: p.kind,
        roles: p.roles,
        participationStatus: p.participationStatus,
        participationComment: p.participationComment,
        expectReply: p.expectReply,
        scheduleAgent: p.scheduleAgent,
        scheduleForceSend: p.scheduleForceSend,
        scheduleId: p.scheduleId,
        delegatedTo: p.delegatedTo,
        delegatedFrom: p.delegatedFrom,
        memberOf: p.memberOf,
        locationId: p.locationId,
        language: p.language,
        links: p.links,
      };
      Object.keys(participant).forEach(k => {
        if (participant[k] === undefined || participant[k] === null) delete participant[k];
      });
      cleanParticipants[key] = participant as unknown as CalendarParticipant;
    }
  }

  const data: Partial<CalendarEvent> = {
    calendarIds: { [calendarId]: true },
    uid: src.uid,
    title: src.title,
    description: src.description,
    descriptionContentType: src.descriptionContentType,
    start: src.start,
    // CalendarEvent/parse drops a DTEND equal to DTSTART; without an
    // explicit zero duration Stalwart stores the event ending at
    // 23:59:59 of its start day. (#837)
    duration: src.showWithoutTime ? normalizeAllDayDuration(src.duration) : (src.duration || 'PT0S'),
    timeZone: src.showWithoutTime ? null : src.timeZone,
    showWithoutTime: src.showWithoutTime,
    status: src.status,
    freeBusyStatus: src.freeBusyStatus,
    privacy: src.privacy,
    color: src.color,
    keywords: src.keywords,
    categories: src.categories,
    locale: src.locale,
    // Stalwart derives the iCalendar ORGANIZER solely from
    // organizerCalendarAddress (replyTo is retired in jscalendarbis);
    // dropping it here would strip the ORGANIZER from imported invites
    // and break RSVP replies afterwards.
    organizerCalendarAddress: src.organizerCalendarAddress || src.replyTo?.imip,
    locations: src.locations,
    virtualLocations: src.virtualLocations,
    links: src.links,
    recurrenceRules: src.recurrenceRules,
    recurrenceOverrides: src.recurrenceOverrides,
    excludedRecurrenceRules: src.excludedRecurrenceRules,
    alerts: src.alerts,
    participants: cleanParticipants,
  };
  Object.keys(data).forEach(k => {
    const v = (data as Record<string, unknown>)[k];
    if (v === undefined || v === null) delete (data as Record<string, unknown>)[k];
  });
  return data;
}
