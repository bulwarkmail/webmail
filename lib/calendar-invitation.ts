import { parseISO } from 'date-fns';
import type { Email, Attachment, CalendarEvent, CalendarParticipant, EmailBodyPart } from '@/lib/jmap/types';
import { normalizeCalendarEventLike } from '@/lib/calendar-event-normalization';

export type InvitationMethod =
  | 'publish'
  | 'request'
  | 'reply'
  | 'add'
  | 'cancel'
  | 'refresh'
  | 'counter'
  | 'declinecounter'
  | 'unknown';

export interface InvitationTrustAssessment {
  level: 'trusted' | 'caution' | 'warning';
  reason:
    | 'authentication_failed'
    | 'authentication_missing'
    | 'sender_mismatch'
    | 'sender_mismatch_unverified'
    | null;
  senderEmail: string | null;
  organizerEmail: string | null;
}

export interface InvitationActorSummary {
  name: string | null;
  email: string | null;
  role: 'organizer' | 'attendee';
  participationStatus: CalendarParticipant['participationStatus'] | null;
  participationComment: string | null;
}

const KNOWN_METHODS = new Set<InvitationMethod>([
  'publish',
  'request',
  'reply',
  'add',
  'cancel',
  'refresh',
  'counter',
  'declinecounter',
]);

function parseContentType(value?: string | null): { mimeType: string; params: Record<string, string> } {
  if (!value) {
    return { mimeType: '', params: {} };
  }

  const parts = value.split(';').map((part) => part.trim()).filter(Boolean);
  const [mimeType = '', ...paramParts] = parts;
  const params: Record<string, string> = {};

  for (const part of paramParts) {
    const separatorIndex = part.indexOf('=');
    if (separatorIndex === -1) continue;
    const key = part.slice(0, separatorIndex).trim().toLowerCase();
    const rawValue = part.slice(separatorIndex + 1).trim();
    params[key] = rawValue.replace(/^"|"$/g, '');
  }

  return {
    mimeType: mimeType.toLowerCase(),
    params,
  };
}

export function isCalendarMimeType(value?: string | null): boolean {
  const { mimeType } = parseContentType(value);
  return mimeType === 'text/calendar' || mimeType === 'application/ics' || mimeType === 'application/icalendar';
}

function normalizeInvitationMethod(value?: string | null): InvitationMethod {
  if (!value) return 'unknown';

  const normalized = value.trim().toLowerCase();
  return KNOWN_METHODS.has(normalized as InvitationMethod)
    ? normalized as InvitationMethod
    : 'unknown';
}

function extractMethodFromContentType(value?: string | null): InvitationMethod {
  const { params } = parseContentType(value);
  return normalizeInvitationMethod(params.method);
}

/**
 * Extract METHOD from raw ICS/iCalendar text content.
 * JMAP strips parameters from Content-Type (RFC 8621), so `text/calendar; method=REQUEST`
 * becomes just `text/calendar`. This function reads the METHOD property from the raw
 * VCALENDAR data as a reliable fallback.
 */
export function extractMethodFromRawIcs(rawText: string): InvitationMethod {
  const match = rawText.match(/^METHOD:(\S+)/m);
  return match ? normalizeInvitationMethod(match[1]) : 'unknown';
}

function getHeaderValue(headers: Email['headers'] | undefined, headerName: string): string | null {
  if (!headers) return null;

  const target = headerName.toLowerCase();
  for (const [name, value] of Object.entries(headers)) {
    if (name.toLowerCase() !== target) continue;
    return Array.isArray(value) ? (value[0] ?? null) : value;
  }

  return null;
}

function normalizeEmailAddress(value?: string | null): string | null {
  if (!value) return null;

  const normalized = value.trim().replace(/^mailto:/i, '').toLowerCase();
  return normalized || null;
}

function getPrimaryAddressEmail(addresses?: Array<{ email?: string | null }>): string | null {
  if (!addresses) return null;

  for (const address of addresses) {
    const normalized = normalizeEmailAddress(address.email);
    if (normalized) {
      return normalized;
    }
  }

  return null;
}

function getParticipantEmail(participant: CalendarParticipant): string | null {
  const directEmail = normalizeEmailAddress(participant.email);
  if (directEmail) {
    return directEmail;
  }

  // Stalwart uses calendarAddress (mailto:...) instead of email/sendTo
  if (participant.calendarAddress) {
    const normalized = normalizeEmailAddress(participant.calendarAddress);
    if (normalized) {
      return normalized;
    }
  }

  if (!participant.sendTo) {
    return null;
  }

  for (const address of Object.values(participant.sendTo)) {
    const normalized = normalizeEmailAddress(address);
    if (normalized) {
      return normalized;
    }
  }

  return null;
}

function getParticipantName(participant: CalendarParticipant): string | null {
  return participant.name || getParticipantEmail(participant);
}

function isOrganizerParticipant(participant: CalendarParticipant): boolean {
  return Boolean(participant.roles?.owner || participant.roles?.chair);
}

function getParticipantSignalScore(participant: CalendarParticipant): number {
  let score = 0;

  if (participant.participationStatus && participant.participationStatus !== 'needs-action') {
    score += 2;
  }

  if (participant.participationComment) {
    score += 2;
  }

  if (participant.scheduleStatus?.length) {
    score += 1;
  }

  return score;
}

function getOrganizerEmail(event: Partial<CalendarEvent>): string | null {
  if (event.participants) {
    for (const participant of Object.values(event.participants)) {
      if (isOrganizerParticipant(participant)) {
        return getParticipantEmail(participant);
      }
    }
  }

  // Stalwart uses organizerCalendarAddress instead of roles.owner/chair
  if (event.organizerCalendarAddress) {
    return normalizeEmailAddress(event.organizerCalendarAddress);
  }

  return null;
}

function hasVerifiedAuthentication(email?: Pick<Email, 'authenticationResults'>): boolean {
  const authenticationResults = email?.authenticationResults;
  return Boolean(
    authenticationResults?.dmarc?.result === 'pass'
    || authenticationResults?.dkim?.result === 'pass'
    || authenticationResults?.spf?.result === 'pass'
  );
}

function hasAuthenticationFailure(email?: Pick<Email, 'authenticationResults'>): boolean {
  const authenticationResults = email?.authenticationResults;
  return Boolean(
    authenticationResults?.dmarc?.result === 'fail'
    || authenticationResults?.dkim?.result === 'fail'
    || authenticationResults?.dkim?.result === 'policy'
    || authenticationResults?.dkim?.result === 'permerror'
    || authenticationResults?.spf?.result === 'fail'
    || authenticationResults?.spf?.result === 'softfail'
    || authenticationResults?.spf?.result === 'permerror'
  );
}

function findCalendarBodyPart(parts?: EmailBodyPart[]): Attachment | null {
  if (!parts) return null;

  for (const part of parts) {
    if (isCalendarMimeType(part.type) || part.name?.toLowerCase().endsWith('.ics') || part.name?.toLowerCase().endsWith('.ical')) {
      return {
        partId: part.partId,
        blobId: part.blobId,
        size: part.size,
        name: part.name || 'invite.ics',
        type: part.type,
        charset: part.charset,
        disposition: part.disposition,
        cid: part.cid,
      };
    }

    const nested = findCalendarBodyPart(part.subParts);
    if (nested) {
      return nested;
    }
  }

  return null;
}

function looksLikeReply(event: Partial<CalendarEvent>): boolean {
  if (!event.participants) return false;

  const participants = Object.values(event.participants);
  return participants.some((participant) =>
    participant.roles?.attendee
    && !isOrganizerParticipant(participant)
    && (
      participant.participationStatus !== 'needs-action'
      || !!participant.participationComment
      || !!participant.scheduleStatus?.length
    )
  );
}

export function getInvitationActorSummary(
  event: Partial<CalendarEvent>,
  method: InvitationMethod,
): InvitationActorSummary | null {
  if (!event.participants) {
    return null;
  }

  const participants = Object.values(event.participants);
  let organizer = participants.find((participant) => isOrganizerParticipant(participant)) ?? null;

  // Stalwart uses organizerCalendarAddress instead of roles.owner/chair
  if (!organizer && event.organizerCalendarAddress) {
    organizer = participants.find(
      (p) => p.calendarAddress === event.organizerCalendarAddress
    ) ?? null;
  }

  const attendees = participants.filter((participant) => participant !== organizer && !isOrganizerParticipant(participant));
  const respondingAttendee = [...attendees].sort((left, right) => (
    getParticipantSignalScore(right) - getParticipantSignalScore(left)
  ))[0] ?? null;

  const sourceParticipant = (() => {
    switch (method) {
      case 'reply':
      case 'counter':
      case 'refresh':
        return respondingAttendee;
      case 'declinecounter':
      case 'request':
      case 'publish':
      case 'add':
      case 'cancel':
        return organizer ?? respondingAttendee;
      default:
        return respondingAttendee ?? organizer;
    }
  })();

  if (!sourceParticipant) {
    return null;
  }

  return {
    name: getParticipantName(sourceParticipant),
    email: getParticipantEmail(sourceParticipant),
    role: isOrganizerParticipant(sourceParticipant) ? 'organizer' : 'attendee',
    participationStatus: sourceParticipant.participationStatus ?? null,
    participationComment: sourceParticipant.participationComment ?? null,
  };
}

function getMethodFromEmail(email?: Pick<Email, 'headers' | 'attachments' | 'textBody' | 'htmlBody'>, attachment?: Pick<Attachment, 'type'> | null): InvitationMethod {
  const explicitAttachmentMethod = extractMethodFromContentType(attachment?.type);
  if (explicitAttachmentMethod !== 'unknown') {
    return explicitAttachmentMethod;
  }

  if (email?.attachments) {
    for (const item of email.attachments) {
      if (!isCalendarMimeType(item.type)) continue;
      const method = extractMethodFromContentType(item.type);
      if (method !== 'unknown') return method;
    }
  }

  for (const bodyPart of [findCalendarBodyPart(email?.textBody), findCalendarBodyPart(email?.htmlBody)]) {
    const method = extractMethodFromContentType(bodyPart?.type);
    if (method !== 'unknown') return method;
  }

  return extractMethodFromContentType(getHeaderValue(email?.headers, 'Content-Type'));
}

export function findCalendarAttachment(email: Email): Attachment | null {
  if (email.attachments) {
    for (const att of email.attachments) {
      if (
        isCalendarMimeType(att.type) ||
        att.name?.toLowerCase().endsWith('.ics') ||
        att.name?.toLowerCase().endsWith('.ical')
      ) {
        return att;
      }
    }
  }

  const inlineAttachment = findCalendarBodyPart(email.textBody) || findCalendarBodyPart(email.htmlBody);
  if (inlineAttachment) return inlineAttachment;

  return null;
}

export function getInvitationMethod(
  event: Partial<CalendarEvent>,
  options?: {
    email?: Pick<Email, 'headers' | 'attachments' | 'textBody' | 'htmlBody'>;
    attachment?: Pick<Attachment, 'type'> | null;
  }
): InvitationMethod {
  const explicitMethod = getMethodFromEmail(options?.email, options?.attachment);
  if (explicitMethod !== 'unknown') {
    return explicitMethod;
  }

  if (event.status === 'cancelled') {
    return 'cancel';
  }

  if (looksLikeReply(event)) {
    return 'reply';
  }

  if (event.participants && Object.keys(event.participants).length > 0) {
    const hasOrganizer = Object.values(event.participants).some(
      (p: CalendarParticipant) => isOrganizerParticipant(p)
    );
    if (hasOrganizer) {
      return 'request';
    }
  }

  return 'unknown';
}

export function getInvitationTrustAssessment(
  event: Partial<CalendarEvent>,
  email?: Pick<Email, 'from' | 'replyTo' | 'authenticationResults'>,
  method: InvitationMethod = getInvitationMethod(event)
): InvitationTrustAssessment {
  const organizerEmail = getOrganizerEmail(event);
  const senderEmail = getPrimaryAddressEmail(email?.from) || getPrimaryAddressEmail(email?.replyTo);
  const verifiedAuthentication = hasVerifiedAuthentication(email);
  const authenticationFailure = hasAuthenticationFailure(email);
  const senderMismatch = Boolean(senderEmail && organizerEmail && senderEmail !== organizerEmail);
  const expectsAuthenticatedTransport = method !== 'unknown';

  if (senderMismatch && (authenticationFailure || !verifiedAuthentication)) {
    return {
      level: 'warning',
      reason: 'sender_mismatch_unverified',
      senderEmail,
      organizerEmail,
    };
  }

  if (authenticationFailure) {
    return {
      level: 'warning',
      reason: 'authentication_failed',
      senderEmail,
      organizerEmail,
    };
  }

  if (senderMismatch) {
    return {
      level: 'caution',
      reason: 'sender_mismatch',
      senderEmail,
      organizerEmail,
    };
  }

  if (expectsAuthenticatedTransport && !verifiedAuthentication) {
    return {
      level: 'caution',
      reason: 'authentication_missing',
      senderEmail,
      organizerEmail,
    };
  }

  return {
    level: 'trusted',
    reason: null,
    senderEmail,
    organizerEmail,
  };
}

export interface EventSummary {
  title: string;
  start: string | null;
  end: string | null;
  isAllDay: boolean;
  location: string | null;
  organizer: string | null;
  organizerEmail: string | null;
  attendeeCount: number;
}

export function formatEventSummary(event: Partial<CalendarEvent>): EventSummary {
  const normalizedEvent = normalizeCalendarEventLike(event);
  let location: string | null = null;
  if (normalizedEvent.locations) {
    const firstLocation = Object.values(normalizedEvent.locations)[0];
    if (firstLocation?.name) {
      location = firstLocation.name;
    }
  }

  let organizer: string | null = null;
  let organizerEmail: string | null = null;
  let attendeeCount = 0;

  if (normalizedEvent.participants) {
    for (const p of Object.values(normalizedEvent.participants)) {
      if (p.roles?.owner || p.roles?.chair) {
        organizer = p.name || getParticipantEmail(p) || null;
        organizerEmail = getParticipantEmail(p);
      }
      if (p.roles?.attendee || p.roles?.required) {
        attendeeCount++;
      }
    }
  }

  // Stalwart provides organizerCalendarAddress instead of roles.owner/chair
  if (!organizerEmail && normalizedEvent.organizerCalendarAddress) {
    organizerEmail = normalizeEmailAddress(normalizedEvent.organizerCalendarAddress);
    if (!organizer && normalizedEvent.participants) {
      // Find the participant matching the organizer address for their name
      for (const p of Object.values(normalizedEvent.participants)) {
        if (p.calendarAddress === normalizedEvent.organizerCalendarAddress) {
          organizer = p.name || organizerEmail;
          break;
        }
      }
    }
    if (!organizer) organizer = organizerEmail;
  }

  const isAllDay = normalizedEvent.showWithoutTime ?? false;

  let end: string | null = null;
  if (normalizedEvent.utcEnd) {
    end = normalizedEvent.utcEnd;
  } else if (normalizedEvent.start && normalizedEvent.duration) {
    end = addDurationToDate(normalizedEvent.start, normalizedEvent.duration, normalizedEvent.timeZone);
  }

  // For all-day events, prefer the local start (no timezone) to avoid
  // UTC conversion shifting the displayed date in non-UTC timezones.
  const start = isAllDay
    ? (normalizedEvent.start || null)
    : (normalizedEvent.utcStart || normalizedEvent.start || null);

  return {
    title: normalizedEvent.title || '',
    start,
    end,
    isAllDay,
    location,
    organizer,
    organizerEmail,
    attendeeCount,
  };
}

function addDurationToDate(start: string, duration: string, _timeZone?: string | null): string | null {
  const match = duration.match(/^P(?:(\d+)W)?(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?$/);
  if (!match) return null;

  const weeks = parseInt(match[1] || '0');
  const days = parseInt(match[2] || '0') + weeks * 7;
  const hours = parseInt(match[3] || '0');
  const minutes = parseInt(match[4] || '0');
  const seconds = parseInt(match[5] || '0');

  const date = parseISO(start);
  if (isNaN(date.getTime())) return null;

  const isUTC = start.endsWith('Z') || start.includes('+');

  if (isUTC) {
    date.setUTCDate(date.getUTCDate() + days);
    date.setUTCHours(date.getUTCHours() + hours);
    date.setUTCMinutes(date.getUTCMinutes() + minutes);
    date.setUTCSeconds(date.getUTCSeconds() + seconds);
    return date.toISOString();
  }

  date.setDate(date.getDate() + days);
  date.setHours(date.getHours() + hours);
  date.setMinutes(date.getMinutes() + minutes);
  date.setSeconds(date.getSeconds() + seconds);

  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  const h = String(date.getHours()).padStart(2, '0');
  const min = String(date.getMinutes()).padStart(2, '0');
  const s = String(date.getSeconds()).padStart(2, '0');
  return `${y}-${m}-${d}T${h}:${min}:${s}`;
}

export function findParticipantByEmail(
  event: Partial<CalendarEvent>,
  email: string
): { id: string; participant: CalendarParticipant } | null {
  if (!event.participants || !email) return null;

  const lowerEmail = email.toLowerCase();
  for (const [id, p] of Object.entries(event.participants)) {
    if (p.email?.toLowerCase() === lowerEmail) {
      return { id, participant: p };
    }
    // Stalwart uses calendarAddress (mailto:...) instead of email/sendTo
    if (p.calendarAddress) {
      const addr = p.calendarAddress.replace('mailto:', '').toLowerCase();
      if (addr === lowerEmail) {
        return { id, participant: p };
      }
    }
    if (p.sendTo) {
      for (const addr of Object.values(p.sendTo)) {
        if (addr.replace('mailto:', '').toLowerCase() === lowerEmail) {
          return { id, participant: p };
        }
      }
    }
  }
  return null;
}
