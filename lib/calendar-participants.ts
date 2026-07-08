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

export function isOrganizer(event: CalendarEvent, userEmails: string[]): boolean {
  if (!event.participants) return false;
  const lower = userEmails.map(e => e.toLowerCase());
  return Object.values(event.participants).some(p =>
    p.roles?.owner && participantMatchesEmail(p, lower)
  );
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

  // calendarAddress is the scheduling address in draft-ietf-calext-jscalendarbis
  // (implemented by Stalwart); the RFC 8984 sendTo property is retired there and
  // stored as an inert JSPROP, so it is intentionally not sent.
  participants[generateId()] = {
    '@type': 'Participant',
    name: organizer.name,
    email: organizer.email,
    calendarAddress: `mailto:${organizer.email}`,
    roles: { owner: true, attendee: true },
    participationStatus: 'accepted',
    scheduleAgent: 'server',
    expectReply: false,
    kind: 'individual',
  };

  attendees.forEach((a) => {
    participants[generateId()] = {
      '@type': 'Participant',
      name: a.name,
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
