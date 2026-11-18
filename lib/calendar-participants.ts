import type { CalendarEvent, CalendarParticipant } from '@/lib/jmap/types';
import { generateUUID } from '@/lib/utils';
import { jmapErrorType } from '@/lib/jmap/jmap-error';

export interface ParticipantInfo {
  id: string;
  name: string;
  email: string;
  status: CalendarParticipant['participationStatus'];
  isOrganizer: boolean;
  /** An attendee whose presence is not required (JSCalendar role `optional`, iCalendar OPT-PARTICIPANT). */
  optional: boolean;
}

export interface StatusCounts {
  accepted: number;
  declined: number;
  tentative: number;
  'needs-action': number;
}

/**
 * The limit a refusal names when the server turned an event down for having
 * too many participants, or null for any other failure. Stalwart 1.0
 * enforces maxParticipantsPerEvent on every create and update, answers to
 * invitations included: invalidProperties on `participants`, "An event
 * cannot have more than 20 participants.".
 */
export function participantLimitOf(error: unknown): number | null {
  if (jmapErrorType(error) !== 'invalidProperties') return null;
  const match = /more than (\d+) participants/i.exec(error instanceof Error ? error.message : '');
  return match ? Number(match[1]) : null;
}

/**
 * Check if a participant matches any of the given email addresses.
 * Checks p.email, p.calendarAddress (mailto:...), and p.sendTo values.
 */
function participantMatchesEmail(p: CalendarParticipant, lowerEmails: string[]): boolean {
  if (p.email && lowerEmails.includes(p.email.toLowerCase())) return true;
  if (p.calendarAddress) {
    const addr = p.calendarAddress.replace(/^mailto:/i, '').toLowerCase();
    if (addr && lowerEmails.includes(addr)) return true;
  }
  if (p.sendTo) {
    for (const addr of Object.values(p.sendTo)) {
      const normalized = addr.replace(/^mailto:/i, '').toLowerCase();
      if (normalized && lowerEmails.includes(normalized)) return true;
    }
  }
  return false;
}

/** Best-effort scheduling address for a participant, without the mailto: scheme. */
function getParticipantEmail(p: CalendarParticipant): string {
  if (p.email) return p.email;
  if (p.calendarAddress) return p.calendarAddress.replace(/^mailto:/i, '');
  if (p.sendTo?.imip) return p.sendTo.imip.replace(/^mailto:/i, '');
  return '';
}

/**
 * Collects the event-level organizer calendar address(es).
 * Stalwart conveys the organizer via `organizerCalendarAddress` / `replyTo`
 * rather than a participant `roles.owner` flag, so self-organized events
 * imported from another server have no owner participant to match against.
 */
export function getEventOrganizerEmails(event: CalendarEvent): string[] {
  const emails: string[] = [];
  if (event.organizerCalendarAddress) {
    emails.push(event.organizerCalendarAddress.replace(/^mailto:/i, '').toLowerCase());
  }
  if (event.replyTo) {
    for (const addr of Object.values(event.replyTo)) {
      emails.push(addr.replace(/^mailto:/i, '').toLowerCase());
    }
  }
  return emails.filter(Boolean);
}

/**
 * Merge the user's calendar addresses (identities + account aliases) so
 * isOrganizer() recognises alias-organized events as the user's own. Identities
 * alone carry only one address each, so an alias organizer looked foreign.
 * De-duplicated case-insensitively (first casing kept); blanks dropped.
 */
export function collectUserCalendarAddresses(
  ...groups: Array<ReadonlyArray<string | null | undefined>>
): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const group of groups) {
    for (const raw of group) {
      const trimmed = raw?.trim();
      if (!trimmed) continue;
      const key = trimmed.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(trimmed);
    }
  }
  return out;
}

export function isOrganizer(event: CalendarEvent, userEmails: string[]): boolean {
  if (userEmails.length === 0) return false;
  const lower = userEmails.map(e => e.toLowerCase());

  if (event.participants) {
    const ownerMatch = Object.values(event.participants).some(p =>
      p.roles?.owner && participantMatchesEmail(p, lower)
    );
    if (ownerMatch) return true;
  }

  // Fall back to the event-level organizer address (Stalwart / imported events
  // mark the organizer here instead of via a participant `owner` role).
  return getEventOrganizerEmails(event).some(email => lower.includes(email));
}

export function getUserParticipantId(event: CalendarEvent, userEmails: string[]): string | null {
  if (!event.participants) return null;
  const lower = userEmails.map(e => e.toLowerCase());
  for (const [id, p] of Object.entries(event.participants)) {
    if (participantMatchesEmail(p, lower)) return id;
  }
  return null;
}

export function getUserStatus(
  event: CalendarEvent,
  userEmails: string[]
): CalendarParticipant['participationStatus'] | null {
  if (!event.participants) return null;
  const lower = userEmails.map(e => e.toLowerCase());
  for (const p of Object.values(event.participants)) {
    if (participantMatchesEmail(p, lower)) return p.participationStatus;
  }
  return null;
}

/**
 * True when the user declined this event. An occurrence carries its override's
 * participants, so one declined instance of an accepted series counts (#1110).
 */
export function isDeclinedByUser(event: CalendarEvent, userEmails: string[] | undefined): boolean {
  if (!userEmails || userEmails.length === 0) return false;
  return getUserStatus(event, userEmails) === 'declined';
}

/** When the same address appears in two participant entries, a real RSVP on
 *  either one beats a missing/"needs-action" one — the duplicate is always the
 *  entry that never replied (the needs-action side). Between two real replies
 *  the first-seen entry wins; such conflicts do not occur in practice. */
function betterStatus(
  current: CalendarParticipant['participationStatus'] | undefined,
  incoming: CalendarParticipant['participationStatus'] | undefined
): CalendarParticipant['participationStatus'] {
  if (current === 'needs-action' && incoming && incoming !== 'needs-action') return incoming;
  return current || 'needs-action';
}

export interface ParticipantListOptions {
  /**
   * Fills `ParticipantInfo.name` for participants whose event data carries no
   * name. Stalwart drops the ORGANIZER display name on its iCalendar
   * round-trip, so the organizer (and attendees added by bare address) render
   * as a bare email until the contact card's name is looked up.
   */
  resolveName?: (email: string) => string | undefined;
}

export function getParticipantList(event: CalendarEvent, options?: ParticipantListOptions): ParticipantInfo[] {
  if (!event.participants) return [];
  // Stalwart rebuilds the ORGANIZER line into a participant that carries only
  // `calendarAddress` — no `roles` at all — so `roles.owner` alone would treat
  // the organizer as a plain attendee on every re-read (#731).
  const organizerEmails = getEventOrganizerEmails(event);
  const resolveName = options?.resolveName;

  // The same address can legitimately arrive twice: the organizer as both the
  // ORGANIZER-derived participant and an ATTENDEE line (server-side
  // scheduling, or events written before #731), or an attendee pasted twice.
  // Render each address once by folding later entries into the first-seen
  // one — otherwise every list and count shows a phantom participant.
  const list: ParticipantInfo[] = [];
  const byEmail = new Map<string, ParticipantInfo>();

  for (const [id, p] of Object.entries(event.participants)) {
    const email = getParticipantEmail(p);
    const key = email.trim().toLowerCase();
    const isOrganizer = !!p.roles?.owner || (!!key && organizerEmails.includes(key));

    const existing = key ? byEmail.get(key) : undefined;
    if (existing) {
      if (!existing.name && p.name) existing.name = p.name;
      if (isOrganizer) existing.isOrganizer = true;
      if (p.roles?.optional) existing.optional = true;
      existing.status = betterStatus(existing.status, p.participationStatus);
      continue;
    }

    const entry: ParticipantInfo = {
      id,
      name: p.name || '',
      email,
      status: p.participationStatus || 'needs-action',
      isOrganizer,
      optional: !!p.roles?.optional,
    };
    if (key) byEmail.set(key, entry);
    list.push(entry);
  }

  for (const entry of list) {
    if (!entry.name && entry.email && resolveName) {
      entry.name = resolveName(entry.email) || '';
    }
    // The organizer owes no reply to their own invitation; a missing status
    // must not read as "pending" next to the organizer marker. Matches
    // getStatusCounts, which excludes the organizer from pending totals.
    if (entry.isOrganizer && entry.status === 'needs-action') {
      entry.status = 'accepted';
    }
    if (entry.isOrganizer) entry.optional = false;
  }
  return list;
}

export function getStatusCounts(event: CalendarEvent): StatusCounts {
  const counts: StatusCounts = { accepted: 0, declined: 0, tentative: 0, 'needs-action': 0 };
  if (!event.participants) return counts;
  const organizerEmails = getEventOrganizerEmails(event);
  for (const p of Object.values(event.participants)) {
    // The organizer is not awaiting their own reply; counting the roles-less
    // participant Stalwart derives from ORGANIZER inflates the pending total.
    const email = getParticipantEmail(p).toLowerCase();
    if (p.roles?.owner || (email && organizerEmails.includes(email))) continue;
    const s = p.participationStatus || 'needs-action';
    if (s in counts) counts[s as keyof StatusCounts]++;
  }
  return counts;
}

export function getParticipantCount(event: CalendarEvent): number {
  if (!event.participants) return 0;
  // Count addresses, not raw entries: an organizer the server emits twice must
  // not inflate the participant badge on event cards and agenda rows. Entries
  // without any address cannot be merged, so they count individually.
  const seen = new Set<string>();
  let count = 0;
  for (const p of Object.values(event.participants)) {
    const key = getParticipantEmail(p).trim().toLowerCase();
    if (key) {
      if (seen.has(key)) continue;
      seen.add(key);
    }
    count++;
  }
  return count;
}

type ParticipationStatus = CalendarParticipant['participationStatus'];

/** Whether `p` is `event`'s organizer: the owner participant, or the one at the organizer's address. */
function isOrganizerEntry(p: CalendarParticipant, organizerEmails: string[]): boolean {
  const email = getParticipantEmail(p).trim().toLowerCase();
  return !!p.roles?.owner || (!!email && organizerEmails.includes(email));
}

/**
 * Whether an attendee of `event` has answered and not declined: someone
 * Stalwart sends a change of the event to, but not a new occurrence
 * override or a new event (see participantsAskedAgain).
 */
export function hasAnsweredAttendees(event: Partial<Pick<CalendarEvent, 'participants' | 'organizerCalendarAddress' | 'replyTo'>>): boolean {
  const organizerEmails = getEventOrganizerEmails(event as CalendarEvent);
  return Object.values(event.participants ?? {}).some((p) => !isOrganizerEntry(p, organizerEmails)
    && !!p.participationStatus && p.participationStatus !== 'needs-action' && p.participationStatus !== 'declined');
}

/**
 * The addresses whose answer stays when the attendees are asked again:
 * those of the user who makes the change. Someone who attends the owner's
 * meeting in a calendar shared with them, and moves it there, is not asked
 * about their own change. Stalwart 0.16 takes the addresses of the user who
 * writes for the account's own and sends them nothing: reset, their answer
 * stayed needs-action in the owner's copy, with nothing asking them to
 * answer again (live on 0.16.23). 1.0 sends them the change either way.
 */
function keptAnswersOf(userEmails: string[]): string[] {
  return userEmails.map((email) => email.trim().toLowerCase()).filter(Boolean);
}

/**
 * `event`'s participants with every attendee asked to answer again - back
 * at needs-action - and the organizer's entries as they are. What its
 * organizer does when an event moves (RFC 5546), and what a new event made
 * from it needs: Stalwart sends a new event, and a new override of one
 * occurrence, only to attendees without an answer (PARTSTAT absent or
 * NEEDS-ACTION; groupware scheduling, send_invite_messages), and a change
 * to an existing one carries each attendee's stored answer. Null when no
 * attendee has answered.
 *
 * `userEmails`, the addresses of the user who makes the change, keep their
 * answer (see keptAnswersOf).
 */
export function participantsAskedAgain(
  event: Partial<Pick<CalendarEvent, 'participants' | 'organizerCalendarAddress' | 'replyTo'>>,
  userEmails: string[] = [],
): Record<string, CalendarParticipant> | null {
  const organizerEmails = getEventOrganizerEmails(event as CalendarEvent);
  const own = keptAnswersOf(userEmails);
  let asked = false;
  const participants: Record<string, CalendarParticipant> = {};
  for (const [id, p] of Object.entries(event.participants ?? {})) {
    if (isOrganizerEntry(p, organizerEmails) || !p.participationStatus || p.participationStatus === 'needs-action'
      || participantMatchesEmail(p, own)) {
      participants[id] = p;
      continue;
    }
    participants[id] = { ...p, participationStatus: 'needs-action' };
    asked = true;
  }
  return asked ? participants : null;
}

/**
 * An event's participants by address (lowercased): the id each was first
 * listed under, its roles, and its answer - a real one over a missing or
 * needs-action one when an address is listed twice (see getParticipantList).
 */
function participantsByAddress(
  participants: CalendarEvent['participants'] | null | undefined,
): Map<string, { id: string; status: ParticipationStatus | undefined; roles: Record<string, boolean> | undefined }> {
  const known = new Map<string, { id: string; status: ParticipationStatus | undefined; roles: Record<string, boolean> | undefined }>();
  for (const [id, p] of Object.entries(participants ?? {})) {
    const key = getParticipantEmail(p).trim().toLowerCase();
    if (!key) continue;
    const seen = known.get(key);
    if (!seen) known.set(key, { id, status: p.participationStatus, roles: p.roles });
    else if ((!seen.status || seen.status === 'needs-action') && p.participationStatus) seen.status = p.participationStatus;
  }
  return known;
}

/**
 * The participants an editor save writes: the organizer, then each attendee
 * once. `existing` is the event's current map. An address already in it
 * keeps its participant id and its answer, so a save neither resets the
 * attendees' answers - the user's own on an invitation included - nor leaves
 * a recurrence override pointing at a participant id that is gone. With
 * `askAgain` every attendee but the organizer answers anew (needs-action),
 * but at the user's own addresses, `userEmails` (keptAnswersOf).
 *
 * An attendee is required unless marked `optional`. Roles the editor does
 * not show (chair, informational, contact; set in another client) stay.
 */
export function buildParticipantMap(
  organizer: { name: string; email: string },
  attendees: { name: string; email: string; optional?: boolean }[],
  existing?: CalendarEvent['participants'] | null,
  options: { askAgain?: boolean; userEmails?: string[] } = {},
): Record<string, Partial<CalendarParticipant>> {
  const participants: Record<string, Partial<CalendarParticipant>> = {};
  const known = participantsByAddress(existing);
  const own = new Set(keptAnswersOf(options.userEmails ?? []));
  const idFor = (key: string) => {
    const id = known.get(key)?.id;
    return id && !(id in participants) ? id : generateUUID();
  };

  // An empty name is not a name: sent as "", it reaches the iCalendar stream as a
  // bare `CN=`, and recipients see a dangling "- Organizer" or a guest listed with
  // nothing before their address. Omitted, clients fall back to the address.
  const named = (name: string) => (name.trim() ? { name: name.trim() } : {});

  // calendarAddress is the scheduling address in draft-ietf-calext-jscalendarbis
  // (implemented by Stalwart); the RFC 8984 sendTo property is retired there and
  // stored as an inert JSPROP, so it is intentionally not sent.
  const organizerKey = organizer.email.trim().toLowerCase();
  const organizerStatus = known.get(organizerKey)?.status;
  participants[idFor(organizerKey)] = {
    '@type': 'Participant',
    ...named(organizer.name),
    email: organizer.email,
    calendarAddress: `mailto:${organizer.email}`,
    // owner only, NOT attendee: with roles.attendee set, Stalwart's server-side
    // scheduling emits the organizer as an ATTENDEE line in addition to the
    // ORGANIZER line, so the recipient sees the organizer listed twice.
    roles: { owner: true },
    participationStatus: organizerStatus && organizerStatus !== 'needs-action' ? organizerStatus : 'accepted',
    scheduleAgent: 'server',
    expectReply: false,
    kind: 'individual',
  };

  // The organizer already has an entry above, and an address must not appear
  // twice in the invite list, so drop both cases case-insensitively (#731).
  const seen = new Set<string>([organizerKey]);

  attendees.forEach((a) => {
    const email = a.email.trim();
    const key = email.toLowerCase();
    if (!key || seen.has(key)) return;
    seen.add(key);

    const kept = Object.fromEntries(Object.entries(known.get(key)?.roles ?? {})
      .filter(([role, on]) => on && role !== 'owner' && role !== 'optional'));
    participants[idFor(key)] = {
      '@type': 'Participant',
      ...named(a.name),
      email,
      calendarAddress: `mailto:${email}`,
      roles: { ...kept, attendee: true, ...(a.optional ? { optional: true } : {}) },
      participationStatus: (options.askAgain && !own.has(key) ? undefined : known.get(key)?.status) ?? 'needs-action',
      scheduleAgent: 'server',
      expectReply: true,
      kind: 'individual',
    };
  });

  return participants;
}

/**
 * The event's own organizer: the organizer participant, else the address in
 * `organizerCalendarAddress` or the retired `replyTo`. Null for an event
 * without one.
 */
export function eventOrganizer(event: CalendarEvent): { name: string; email: string } | null {
  const participant = getParticipantList(event).find((p) => p.isOrganizer && p.email.trim());
  if (participant) return { name: participant.name, email: participant.email.trim() };
  const address = event.organizerCalendarAddress || Object.values(event.replyTo ?? {})[0];
  const email = address?.replace(/^mailto:/i, '').trim();
  return email ? { name: '', email } : null;
}

/**
 * Whether the user writes `event` as its organizer: they organize it under
 * any of `userEmails`, or would on saving it with attendees (an event that
 * names no organizer gets the user, participantFieldsToSave), or the event
 * is its organizer's own copy in someone else's account the user writes to -
 * a calendar shared with them, a group's. Stalwart schedules a change from
 * the addresses of the account the event is in, and `isOrigin` is its word
 * that the event's organizer is one of them (0.16 and 1.0 alike): a
 * sharee's move of the owner's meeting goes out from the owner. An
 * invitation in that account is `isOrigin: false` and stays the account's
 * own answer to make. Decides whether a change of when the event happens
 * asks the attendees again, and whether it is sent, in the editor and
 * elsewhere.
 */
export function userOrganizes(event: CalendarEvent, userEmails: string[]): boolean {
  return !eventOrganizer(event) || isOrganizer(event, userEmails) || event.isOrigin === true;
}

/**
 * A move that does not go through the editor - a drag, a resize - saved
 * the way the editor saves one (participantFieldsToSave): when the user
 * organizes the event (userOrganizes: the owner's copy in a calendar shared
 * with the user counts), its attendees are asked again, and the move goes
 * out to them; anyone else moves their own copy without messages. Stalwart's
 * update carries each attendee's stored answer, and one occurrence that
 * gets its own override reaches only attendees without an answer: a dragged
 * occurrence reached no attendee who had answered, a dragged event kept
 * their answers for the new time. The user's own answer stays.
 */
export function movedEventUpdates<T extends Partial<CalendarEvent>>(
  event: CalendarEvent | undefined,
  updates: T,
  userEmails: string[],
): { updates: T & Partial<Pick<CalendarEvent, 'participants'>>; sendSchedulingMessages: true | undefined } {
  if (!event?.participants || Object.keys(event.participants).length === 0 || !userOrganizes(event, userEmails)) {
    return { updates, sendSchedulingMessages: undefined };
  }
  const participants = participantsAskedAgain(event, userEmails);
  return { updates: participants ? { ...updates, participants } : updates, sendSchedulingMessages: true };
}

export interface ParticipantSaveContext {
  /** The user's first calendar address: the organizer of an event that has none yet. */
  userEmail: string | undefined;
  /** All of the user's calendar addresses (identities, aliases): whether the user organizes the event. */
  userEmails?: string[];
  /** A name for an organizer the event data carries none for (the contact card). */
  resolveName?: (email: string) => string | undefined;
  /**
   * The save changes when the event happens: its start or end instant,
   * whether it is all-day, or the recurrence of a series.
   */
  rescheduled?: boolean;
}

/**
 * The participant fields an editor save writes.
 *
 * With attendees, the participants are rebuilt around the event's own
 * organizer: an invitation keeps whoever sent it, and a series the exact
 * address it is organized under (Stalwart 1.0 checks it on single
 * occurrences). Only an event without an organizer gets the user, and only
 * then is `organizerCalendarAddress` written. Stalwart takes the iCalendar
 * ORGANIZER from it, and from the owner participant when it is not set
 * (0.16 and 1.0 alike), so an event that has an organizer keeps it either
 * way. Participants that stay keep their id and answer
 * (buildParticipantMap), unless the user as the organizer moves the event
 * or changes its recurrence: then the other attendees are asked again, as
 * RFC 5546 has an organizer do when an event is rescheduled, and the
 * server's update asks them with needs-action. The user's own answer stays.
 *
 * Without attendees, an event that had participants loses them, its
 * organizer and the retired `replyTo` older releases wrote.
 */
export function participantFieldsToSave(
  event: CalendarEvent | null | undefined,
  attendees: { name: string; email: string; optional?: boolean }[],
  context: ParticipantSaveContext,
): Partial<Pick<CalendarEvent, 'participants' | 'organizerCalendarAddress' | 'replyTo'>> {
  const { userEmail, resolveName } = context;
  if (attendees.length > 0 && userEmail) {
    const organizer = (event ? eventOrganizer(event) : null) ?? { name: '', email: userEmail };
    const userEmails = [userEmail, ...(context.userEmails ?? [])];
    const askAgain = !!context.rescheduled && (!event || userOrganizes(event, userEmails));
    const fields: Partial<Pick<CalendarEvent, 'participants' | 'organizerCalendarAddress'>> = {
      participants: buildParticipantMap(
        // A new event has no participants yet, so it would store an empty
        // organizer name.
        { name: organizer.name || resolveName?.(organizer.email) || '', email: organizer.email },
        attendees,
        event?.participants,
        { askAgain, userEmails },
      ) as Record<string, CalendarParticipant>,
    };
    if (!event?.organizerCalendarAddress) fields.organizerCalendarAddress = `mailto:${organizer.email}`;
    return fields;
  }
  if (attendees.length === 0 && event?.participants && Object.keys(event.participants).length > 0) {
    return {
      participants: null,
      ...(event.replyTo ? { replyTo: null } : {}),
      ...(event.organizerCalendarAddress ? { organizerCalendarAddress: null } : {}),
    };
  }
  return {};
}
