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

/**
 * Collects the event-level organizer calendar address(es).
 * Stalwart conveys the organizer via `organizerCalendarAddress` / `replyTo`
 * rather than a participant `roles.owner` flag, so self-organized events
 * imported from another server have no owner participant to match against.
 */
function getEventOrganizerEmails(event: CalendarEvent): string[] {
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
  return Object.entries(event.participants).map(([id, p]) => {
    let email = p.email || '';
    if (!email && p.calendarAddress) {
      email = p.calendarAddress.replace(/^mailto:/i, '');
    }
    if (!email && p.sendTo?.imip) {
      email = p.sendTo.imip.replace(/^mailto:/i, '');
    }
    return {
      id,
      name: p.name || '',
      email,
      status: p.participationStatus || 'needs-action',
      isOrganizer: !!p.roles?.owner,
    };
  });
}

export function getStatusCounts(event: CalendarEvent): StatusCounts {
  const counts: StatusCounts = { accepted: 0, declined: 0, tentative: 0, 'needs-action': 0 };
  if (!event.participants) return counts;
  for (const p of Object.values(event.participants)) {
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

  // An empty name is not a name: sent as "", it reaches the iCalendar stream as a
  // bare `CN=`, and recipients see a dangling "- Organizer" or a guest listed with
  // nothing before their address. Omitted, clients fall back to the address.
  const named = (name: string) => (name.trim() ? { name: name.trim() } : {});

  // calendarAddress is the scheduling address in draft-ietf-calext-jscalendarbis
  // (implemented by Stalwart); the RFC 8984 sendTo property is retired there and
  // stored as an inert JSPROP, so it is intentionally not sent.
  participants[generateId()] = {
    '@type': 'Participant',
    ...named(organizer.name),
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

  attendees.forEach((a) => {
    participants[generateId()] = {
      '@type': 'Participant',
      ...named(a.name),
      email: a.email,
      calendarAddress: `mailto:${a.email}`,
      roles: { attendee: true },
      participationStatus: 'needs-action',
      scheduleAgent: 'server',
      expectReply: true,
      kind: 'individual',
    };
  });

  return participants;
}
