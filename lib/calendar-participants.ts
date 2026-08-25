import type { CalendarEvent, CalendarParticipant } from '@/lib/jmap/types';
import { generateUUID } from '@/lib/utils';

export interface ParticipantInfo {
  id: string;
  name: string;
  email: string;
  status: CalendarParticipant['participationStatus'];
  isOrganizer: boolean;
}

export interface StatusCounts {
  accepted: number;
  declined: number;
  tentative: number;
  'needs-action': number;
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

export function getParticipantList(event: CalendarEvent): ParticipantInfo[] {
  if (!event.participants) return [];
  // Stalwart rebuilds the ORGANIZER line into a participant that carries only
  // `calendarAddress` — no `roles` at all — so `roles.owner` alone would treat
  // the organizer as a plain attendee on every re-read (#731).
  const organizerEmails = getEventOrganizerEmails(event);
  return Object.entries(event.participants).map(([id, p]) => {
    const email = getParticipantEmail(p);
    return {
      id,
      name: p.name || '',
      email,
      status: p.participationStatus || 'needs-action',
      isOrganizer: !!p.roles?.owner || (!!email && organizerEmails.includes(email.toLowerCase())),
    };
  });
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
  return Object.keys(event.participants).length;
}

export function buildParticipantMap(
  organizer: { name: string; email: string },
  attendees: { name: string; email: string }[]
): Record<string, Partial<CalendarParticipant>> {
  const participants: Record<string, Partial<CalendarParticipant>> = {};

  const generateId = () => generateUUID();

  // calendarAddress is the scheduling address in draft-ietf-calext-jscalendarbis
  // (implemented by Stalwart); the RFC 8984 sendTo property is retired there and
  // stored as an inert JSPROP, so it is intentionally not sent.
  participants[generateId()] = {
    '@type': 'Participant',
    name: organizer.name,
    email: organizer.email,
    calendarAddress: `mailto:${organizer.email}`,
    // owner only, NOT attendee: with roles.attendee set, Stalwart's server-side
    // scheduling emits the organizer as an ATTENDEE line in addition to the
    // ORGANIZER line, so the recipient sees the organizer listed twice.
    roles: { owner: true },
    participationStatus: 'accepted',
    scheduleAgent: 'server',
    expectReply: false,
    kind: 'individual',
  };

  // The organizer already has an entry above, and an address must not appear
  // twice in the invite list, so drop both cases case-insensitively (#731).
  const seen = new Set<string>([organizer.email.trim().toLowerCase()]);

  attendees.forEach((a) => {
    const email = a.email.trim();
    const key = email.toLowerCase();
    if (!key || seen.has(key)) return;
    seen.add(key);

    participants[generateId()] = {
      '@type': 'Participant',
      name: a.name,
      email,
      calendarAddress: `mailto:${email}`,
      roles: { attendee: true },
      participationStatus: 'needs-action',
      scheduleAgent: 'server',
      expectReply: true,
      kind: 'individual',
    };
  });

  return participants;
}
