// Answering a calendar invitation: the reader's invitation banner and the
// plugin call calendar.respond take the same steps, here.
//
// The iMIP REPLY to the organiser is sent by the server: rsvpEvent and
// updateEvent pass sendSchedulingMessages=true to CalendarEvent/set and
// Stalwart queues the iTIP REPLY itself. A reply sent from here as well
// produced duplicate emails.

import type { IJMAPClient } from '@/lib/jmap/client-interface';
import type { CalendarEvent, CalendarParticipant, Email } from '@/lib/jmap/types';
import {
  extractMethodFromRawIcs, findCalendarAttachment, findParticipantByEmails, getInvitationMethod,
  type InvitationMethod,
} from '@/lib/calendar-invitation';

export type RsvpStatus = 'accepted' | 'tentative' | 'declined';
export type ParticipantMatch = { id: string; participant: CalendarParticipant };

/** The calendar store's calls the answer goes through (so plugin hooks run and the calendar shows it). */
export interface RsvpStore {
  rsvpEvent: (client: IJMAPClient, eventId: string, participantId: string, status: string, replyTo?: Record<string, string> | null, scope?: 'occurrence' | 'series', options?: { sentBy?: string }) => Promise<boolean>;
  updateEvent: (client: IJMAPClient, id: string, updates: Partial<CalendarEvent>, sendSchedulingMessages?: boolean) => Promise<boolean>;
  importEvents: (client: IJMAPClient, events: Partial<CalendarEvent>[], calendarId: string, options?: { throwIfNoneImported?: boolean }) => Promise<number | null>;
  /** The store's events right now (read after an import). */
  events: () => CalendarEvent[];
}

export interface RsvpRequest {
  client: IJMAPClient;
  store: RsvpStore;
  /** The invitation as parsed from the message. */
  parsedEvent: Partial<CalendarEvent>;
  /** The copy in the calendar, if it is there. */
  existingEvent: CalendarEvent | null | undefined;
  /** The user's participant as found before (stored copy first, else the invitation). */
  myParticipant: ParticipantMatch | null;
  /** The addresses that pick "your" participant. */
  actingEmails: readonly string[];
  /** The calendar a new copy goes into. */
  calendarId: string | undefined;
  /** The shared or group account the message belongs to, else null. */
  sharedMailAccount: string | null;
  /** Answering for a person as their delegate: SENT-BY names the user. */
  answerOptions?: { sentBy: string };
  /** The stored copy with its participants loaded (or the shared account's copy). */
  resolveExisting: () => Promise<CalendarEvent | null | undefined>;
}

/**
 * What came of an answer: sent; only added to the calendar (the user isn't
 * in its participants); stopped by a plugin (which said why); or failed.
 */
export type RsvpOutcome = 'answered' | 'added' | 'stopped' | 'failed';

function buildParticipantsForRsvp(
  event: Partial<CalendarEvent>,
  participantId: string,
  status: RsvpStatus,
): Record<string, NonNullable<CalendarEvent['participants']>[string]> | null {
  if (!event.participants) return null;
  return Object.fromEntries(
    Object.entries(event.participants).map(([id, participant]) => [
      id,
      { ...participant, participationStatus: id === participantId ? status : participant.participationStatus },
    ]),
  );
}

/**
 * Answer the invitation: on the stored copy when the user is among its
 * participants; by repairing a stored copy that lost its participants; or by
 * adding the invitation to the calendar first and answering on the new copy.
 * Throws what the server refused (said to the user as it is).
 */
export async function answerInvitation(req: RsvpRequest, status: RsvpStatus): Promise<RsvpOutcome> {
  const { client, store, parsedEvent, existingEvent, myParticipant, actingEmails, calendarId, sharedMailAccount, answerOptions } = req;
  const replyTo = parsedEvent.replyTo
    || (parsedEvent.organizerCalendarAddress ? { imip: parsedEvent.organizerCalendarAddress } : null);
  const rsvp = (eventId: string, participantId: string) => (answerOptions
    ? store.rsvpEvent(client, eventId, participantId, status, replyTo, undefined, answerOptions)
    : store.rsvpEvent(client, eventId, participantId, status, replyTo));

  // A copy in a shared or group account may not be loaded yet: look it up
  // there before adding the invitation again.
  const eventForRsvp = existingEvent || sharedMailAccount ? await req.resolveExisting() : null;
  const existingParticipant = eventForRsvp ? findParticipantByEmails(eventForRsvp, actingEmails) : null;
  const canFallbackToParsedParticipant = Boolean(
    existingEvent && myParticipant
    && (!eventForRsvp?.participants || Object.keys(eventForRsvp.participants).length === 0),
  );

  if (eventForRsvp && existingParticipant) {
    // false: a plugin stopped it and said why; keep the old answer.
    return (await rsvp(eventForRsvp.id, existingParticipant.id)) ? 'answered' : 'stopped';
  }
  if (eventForRsvp && canFallbackToParsedParticipant && myParticipant) {
    const repaired = buildParticipantsForRsvp(parsedEvent, myParticipant.id, status);
    if (!repaired) return 'failed';
    const updated = await store.updateEvent(client, eventForRsvp.id, {
      participants: repaired,
      // Stalwart routes the iTIP REPLY via the stored ORGANIZER
      // (organizerCalendarAddress; the RFC 8984 replyTo is retired).
      // Only repair a missing organizer - attendees may not modify it.
      ...(replyTo?.imip && !eventForRsvp.organizerCalendarAddress ? { organizerCalendarAddress: replyTo.imip } : {}),
    }, true);
    return updated ? 'answered' : 'stopped';
  }
  if (eventForRsvp || !calendarId) return 'failed';

  // A refusal (Stalwart 1.0's participant limit, say) is thrown as it is.
  const imported = await store.importEvents(client, [parsedEvent], calendarId, { throwIfNoneImported: true });
  if (imported === null) return 'stopped';
  if (imported <= 0) return 'failed';
  const newEvent = store.events().find(
    (e) => e.uid === parsedEvent.uid && (sharedMailAccount ? e.accountId === sharedMailAccount : !e.isShared),
  );
  const participant = myParticipant || (newEvent ? findParticipantByEmails(newEvent, actingEmails) : null);
  if (!newEvent || !participant) return 'added';
  return (await rsvp(newEvent.id, participant.id)) ? 'answered' : 'stopped';
}

/** The user's participant, unless the user only organises the event (then no answer is due). */
export function attendeeOf(match: ParticipantMatch | null): { participant: ParticipantMatch | null; isOrganizer: boolean } {
  const roles = match?.participant.roles;
  const isOrganizer = roles ? Boolean((roles.owner || roles.chair) && !roles.attendee) : false;
  return { participant: match && !isOrganizer ? match : null, isOrganizer };
}

/** The invitation in a message of the user's own account, read without the banner. */
export interface OwnInvitation {
  parsedEvent: Partial<CalendarEvent>;
  method: InvitationMethod;
}

/**
 * Parse the invitation a message of the signed-in account carries: its
 * first event and its METHOD (from the message, else the raw ICS, since
 * JMAP drops the Content-Type parameters). Null when it carries none.
 */
export async function readOwnInvitation(client: IJMAPClient, email: Email): Promise<OwnInvitation | null> {
  const attachment = findCalendarAttachment(email);
  if (!attachment) return null;
  const accountId = client.getAccountId();
  const [events, rawText] = await Promise.all([
    client.parseCalendarEvents(accountId, attachment.blobId),
    client.fetchBlob(attachment.blobId, 'invite.ics', 'text/calendar', accountId).then((b) => b.text()).catch(() => null),
  ]);
  const parsedEvent = events[0];
  if (!parsedEvent) return null;
  let method = getInvitationMethod(parsedEvent, { email, attachment });
  if (method === 'unknown' && rawText) method = extractMethodFromRawIcs(rawText);
  return { parsedEvent, method };
}
