// Area c, calendar: answering an invitation (calendar.respond) and deleting
// an event so it can be taken back (calendar.deleteEvent with an undo token,
// calendar.undoDelete).

import type { CalendarEvent, Calendar } from '../../jmap/types';
import type { IJMAPClient } from '../../jmap/client-interface';
import { useAuthStore } from '@/stores/auth-store';
import { useCalendarStore } from '@/stores/calendar-store';
import { useSettingsStore } from '@/stores/settings-store';
import { findParticipantByEmails, getInvitationTrustAssessment } from '../../calendar-invitation';
import { answerInvitation, attendeeOf, readOwnInvitation, type RsvpStatus } from '../../calendar-rsvp';
import { readId, sessionClient } from '../host-api-input';
import { readNamedEmail } from '../host-api-mail';
import { doCalendarDeleteEvent } from '../host-api-calendar';
import { issueUndoToken, redeemUndoToken } from './c.undo';
import type { EventDeleteResult, InvitationResponseView } from './c.types';

const STATUSES: readonly RsvpStatus[] = ['accepted', 'tentative', 'declined'];

/** Every address the user sends as, primary first, lowercased. */
function identityEmails(): string[] {
  const { primaryIdentity, identities } = useAuthStore.getState();
  const emails = [primaryIdentity?.email, ...identities.map((i) => i.email)]
    .filter((address): address is string => Boolean(address))
    .map((address) => address.toLowerCase());
  return [...new Set(emails)];
}

function ownCalendars(): Calendar[] {
  return useCalendarStore.getState().calendars.filter((c) => !c.isShared && !c.isTasksOnly);
}

/** The copy of the invitation in the user's own calendar, with its participants loaded. */
async function ownCopy(client: IJMAPClient, uid: string | undefined): Promise<CalendarEvent | null> {
  if (!uid) return null;
  const known = useCalendarStore.getState().events.find((e) => e.uid === uid && !e.isShared);
  if (known) return known;
  const found = (await client.queryCalendarEvents({ uid })).find((e) => !e.recurrenceId) ?? null;
  if (found) {
    useCalendarStore.setState((s) => (s.events.some((e) => e.id === found.id) ? s : { events: [...s.events, found] }));
  }
  return found;
}

/**
 * Answer the invitation a message of the user's own account carries, the
 * way the reader's banner answers it: the calendar store writes the answer
 * and the server sends the reply to the organiser. Resolves to what was
 * answered, or null when another plugin stopped it. Refuses a message that
 * is no invitation (a reply, a cancellation), an event the user organises,
 * one whose sender doesn't check out, and works only while invitations are
 * read (the setting) and the account has a calendar.
 */
export async function doCalendarRespond(emailIdArg: unknown, statusArg: unknown): Promise<InvitationResponseView | null> {
  const method = 'calendar.respond';
  const emailId = readId(emailIdArg, method, 'emailId');
  if (!STATUSES.includes(statusArg as RsvpStatus)) throw new Error(`${method}: status must be one of ${STATUSES.join(', ')}`);
  const status = statusArg as RsvpStatus;
  const client = sessionClient(method);
  if (!useSettingsStore.getState().calendarInvitationParsingEnabled) {
    throw new Error(`${method}: reading invitations is switched off in Settings > Calendar`);
  }
  const calendarState = useCalendarStore.getState();
  if (!calendarState.supportsCalendar) throw new Error(`${method}: this account has no calendar`);

  const named = await readNamedEmail(client, emailId, method);
  if (!named) throw new Error(`${method}: no message with id "${emailId}"`);
  // Mail of a shared or group mailbox is answered as that account: only in
  // the reader. Search results name the user's own account too.
  if (named.accountId !== undefined && named.accountId !== client.getAccountId()) throw new Error(`${method}: answer invitations of other accounts in the reader`);
  const { email } = named;

  const invitation = await readOwnInvitation(client, email);
  if (!invitation) throw new Error(`${method}: the message has no invitation`);
  const { parsedEvent, method: itip } = invitation;
  if (itip !== 'request') throw new Error(`${method}: the message is not an invitation that asks for an answer`);

  const emails = identityEmails();
  const sender = email.from?.[0]?.email?.toLowerCase();
  if (!(sender && emails.includes(sender))) {
    const trust = getInvitationTrustAssessment(parsedEvent, email, itip, emails);
    if (trust?.level === 'warning') throw new Error(`${method}: the invitation may not come from who it names; answer it in the reader`);
  }

  const existing = await ownCopy(client, parsedEvent.uid);
  const { participant: myParticipant, isOrganizer } = attendeeOf(
    (existing ? findParticipantByEmails(existing, emails) : null) ?? findParticipantByEmails(parsedEvent, emails),
  );
  if (isOrganizer) throw new Error(`${method}: the user organises this event`);
  const calendars = ownCalendars();
  const calendarId = (calendars.find((c) => c.isDefault) ?? calendars[0])?.id;

  const store = useCalendarStore.getState();
  const outcome = await answerInvitation({
    client,
    store: { rsvpEvent: store.rsvpEvent, updateEvent: store.updateEvent, importEvents: store.importEvents, events: () => useCalendarStore.getState().events },
    parsedEvent,
    existingEvent: existing,
    myParticipant,
    actingEmails: emails,
    calendarId,
    sharedMailAccount: null,
    resolveExisting: async () => {
      if (!existing) return null;
      if (existing.participants && Object.keys(existing.participants).length > 0) return existing;
      const hydrated = await client.getCalendarEvent(existing.id);
      if (!hydrated) return existing;
      useCalendarStore.setState((s) => ({ events: s.events.map((e) => (e.id === hydrated.id ? hydrated : e)) }));
      return hydrated;
    },
  }, status);
  if (outcome === 'stopped') return null;
  if (outcome === 'added') throw new Error(`${method}: the event was added to the calendar, but the user is not among its participants, so no answer was sent`);
  if (outcome === 'failed') throw new Error(`${method}: the invitation could not be answered`);
  const organizer = parsedEvent.organizerCalendarAddress ?? parsedEvent.replyTo?.imip ?? null;
  return {
    status,
    title: parsedEvent.title ?? '',
    start: parsedEvent.start ?? null,
    organizer: organizer ? organizer.replace(/^mailto:/i, '') : null,
  };
}

// ─── Delete with undo ─────────────────────────────────────────

/** What the server sets itself, and the app's own fields: left out when the event is created again. */
const NOT_RECREATED = [
  'id', 'created', 'updated', 'sequence', 'isDraft', 'isOrigin', 'baseEventId', 'blobId', 'utcStart', 'utcEnd',
  'originalId', 'originalCalendarIds', 'accountId', 'accountName', 'isShared',
] as const;

/** A single event of the user's own calendars: the only kind an undo can put back as it was. */
function restorable(event: CalendarEvent | null, id: string): event is CalendarEvent {
  return !!event && event.id === id && !event.isShared && !event.recurrenceId
    && !(event.recurrenceRules && event.recurrenceRules.length > 0)
    && !(event.recurrenceOverrides && Object.keys(event.recurrenceOverrides).length > 0);
}

/**
 * calendar.deleteEvent as before (one occurrence when given an occurrence's
 * id; never sends cancellations), and now with an undo token for a single
 * event of the user's own calendars. The host keeps the copy; undoDelete
 * creates it again with the same uid.
 */
export async function doCalendarDeleteWithUndo(pluginId: string, idArg: unknown): Promise<EventDeleteResult> {
  const method = 'calendar.deleteEvent';
  const id = readId(idArg, method);
  const client = sessionClient(method);
  const event = await client.getCalendarEvent(id).catch(() => null);
  if (!restorable(event, id)) {
    await doCalendarDeleteEvent(id);
    return { undoToken: null };
  }
  if (!useCalendarStore.getState().events.some((e) => e.id === id)) {
    useCalendarStore.setState((s) => ({ events: [...s.events, event] }));
  }
  const deleted = await useCalendarStore.getState().deleteEvent(client, id, false);
  if (!deleted) return { undoToken: null };
  const copy: Record<string, unknown> = { ...event };
  for (const key of NOT_RECREATED) delete copy[key];
  return { undoToken: issueUndoToken(pluginId, client.getAccountId(), 'event', copy) };
}

/** Puts back an event calendar.deleteEvent deleted, from the host's copy. Sends no invitations. */
export async function doCalendarUndoDelete(pluginId: string, tokenArg: unknown): Promise<{ id: string } | null> {
  const method = 'calendar.undoDelete';
  const client = sessionClient(method);
  const copy = redeemUndoToken<Partial<CalendarEvent>>(method, pluginId, client.getAccountId(), 'event', tokenArg);
  const created = await useCalendarStore.getState().createEvent(client, copy, false);
  return created ? { id: created.id } : null;
}
