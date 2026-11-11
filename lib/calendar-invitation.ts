import type { Email, Attachment, CalendarEvent, CalendarParticipant, EmailBodyPart } from '@/lib/jmap/types';
import { normalizeCalendarEventLike } from '@/lib/calendar-event-normalization';
import { authenticationResultsUsable, hasAlignedAuthenticationPass } from '@/lib/email-headers';
import { fromWallClock, getTimeZoneOffsetMs, isValidTimeZone, parseLocalDateTime, type WallClock } from '@/lib/timezone';
import { applyOverridePatch } from '@/lib/recurrence-instances';

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
    | 'attendee_mismatch'
    | 'attendee_mismatch_unverified'
    | null;
  senderEmail: string | null;
  organizerEmail: string | null;
  /** The attendee who answers in a reply, counter or refresh. */
  attendeeEmail: string | null;
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

/** The organizer of a stored event: its ORGANIZER address first, as the server keeps it. */
function storedEventOrganizer(event: Partial<CalendarEvent>): string | null {
  return normalizeEmailAddress(event.organizerCalendarAddress) ?? getOrganizerEmail(event);
}

/**
 * Whether the message's From address is the organizer of every one of
 * `events`, the stored copies a cancellation would remove. Only the
 * organizer cancels a meeting (RFC 5546 3.2.5), and the organizer named
 * inside the cancellation is the sender's own text, so the stored events
 * decide. An event without an organizer has nobody who could cancel it.
 */
export function isFromOrganizerOf(
  events: readonly Partial<CalendarEvent>[],
  email: Pick<Email, 'from'> | undefined,
): boolean {
  const sender = getPrimaryAddressEmail(email?.from);
  return !!sender && events.length > 0 && events.every((event) => storedEventOrganizer(event) === sender);
}

/** The organizer of the first of `events` that names one, for the notice that names both addresses. */
export function storedOrganizerEmail(events: readonly Partial<CalendarEvent>[]): string | null {
  for (const event of events) {
    const organizer = storedEventOrganizer(event);
    if (organizer) return organizer;
  }
  return null;
}

/**
 * Whether the server's checks tie the message to its From domain. Only an
 * aligned pass counts: a sender passes SPF for their own envelope domain, or
 * signs with their own DKIM key, and still writes the organizer's address in
 * From. With no DMARC policy on that domain the verdict is `dmarc=none`, and
 * the bare `spf=pass` made the forged invitation look trusted. A pass in a
 * header that was not written on receipt counts for nothing, as for the
 * booking cards (authenticationResultsUsable).
 */
function hasVerifiedAuthentication(email?: Pick<Email, 'from' | 'authenticationResults' | 'authenticationResultsOnReceipt'>): boolean {
  if (!authenticationResultsUsable(email)) return false;
  return hasAlignedAuthenticationPass(email?.authenticationResults, getPrimaryAddressEmail(email?.from) ?? undefined);
}

/**
 * A failed check that leaves the From domain unauthenticated. A DMARC fail
 * always counts; one mechanism failing does not when another aligned pass
 * vouches for the sender, as when a relay breaks SPF but the author's DKIM
 * signature still verifies (#1403).
 */
function hasAuthenticationFailure(email: Pick<Email, 'authenticationResults'> | undefined, verified: boolean): boolean {
  const authenticationResults = email?.authenticationResults;
  if (authenticationResults?.dmarc?.result === 'fail') return true;
  if (verified) return false;
  return Boolean(
    authenticationResults?.dkim?.result === 'fail'
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

/**
 * `ownAddresses` are the reader's own addresses. Mail from another user on
 * the reader's domains that carries no Authentication-Results header at all
 * was handed in by a signed-in user rather than received from outside:
 * Stalwart adds the header to everything that arrives on port 25 (#1374).
 *
 * `internalMailDomains` are the organisation's other domains, as the
 * "External" sender chip counts them (lib/external-mail.ts internalDomains,
 * in ASCII form; a domain covers its subdomains): a server that hosts
 * several domains hands mail between them over the same way (#1593). The
 * missing header stays the condition, so a listed domain hosted elsewhere,
 * whose mail arrives on port 25, is still checked. A message with a header
 * that was not written on receipt is not internal, and its pass does not
 * verify it (hasVerifiedAuthentication).
 */
export function getInvitationTrustAssessment(
  event: Partial<CalendarEvent>,
  email?: Pick<Email, 'from' | 'replyTo' | 'authenticationResults' | 'authenticationResultsOnReceipt'>,
  method: InvitationMethod = getInvitationMethod(event),
  ownAddresses: string[] = [],
  internalMailDomains: readonly string[] = []
): InvitationTrustAssessment {
  const organizerEmail = getOrganizerEmail(event);
  const senderEmail = getPrimaryAddressEmail(email?.from) || getPrimaryAddressEmail(email?.replyTo);
  // A reply, counter or refresh is sent by the attendee who answers; the
  // organizer is usually the user reading it.
  const fromAttendee = method === 'reply' || method === 'counter' || method === 'refresh';
  const attendeeEmail = fromAttendee ? getInvitationActorSummary(event, method)?.email ?? null : null;
  const expectedEmail = fromAttendee ? attendeeEmail : organizerEmail;
  const verifiedAuthentication = hasVerifiedAuthentication(email);
  const authenticationFailure = hasAuthenticationFailure(email, verifiedAuthentication);
  const senderMismatch = Boolean(senderEmail && expectedEmail && senderEmail !== expectedEmail);
  const senderDomain = senderEmail?.split('@').pop();
  const internal = Boolean(email && !email.authenticationResults && senderDomain
    && (ownAddresses.some((address) => address.toLowerCase().split('@').pop() === senderDomain)
      || internalMailDomains.some((domain) => senderDomain === domain || senderDomain.endsWith(`.${domain}`))));
  const expectsAuthenticatedTransport = method !== 'unknown' && !internal;
  const addresses = { senderEmail, organizerEmail, attendeeEmail };

  if (senderMismatch && (authenticationFailure || !verifiedAuthentication)) {
    return {
      level: 'warning',
      reason: fromAttendee ? 'attendee_mismatch_unverified' : 'sender_mismatch_unverified',
      ...addresses,
    };
  }

  if (authenticationFailure) {
    return {
      level: 'warning',
      reason: 'authentication_failed',
      ...addresses,
    };
  }

  if (senderMismatch) {
    return {
      level: 'caution',
      reason: fromAttendee ? 'attendee_mismatch' : 'sender_mismatch',
      ...addresses,
    };
  }

  if (expectsAuthenticatedTransport && !verifiedAuthentication) {
    return {
      level: 'caution',
      reason: 'authentication_missing',
      ...addresses,
    };
  }

  return {
    level: 'trusted',
    reason: null,
    ...addresses,
  };
}

export interface EventSummary {
  title: string;
  start: string | null;
  end: string | null;
  isAllDay: boolean;
  /** Timed event without a usable time zone: start/end are wall-clock times to show as they are. */
  isFloating: boolean;
  /** The zone a timed event is in, when Intl knows it; null otherwise. */
  timeZone?: string | null;
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
  const { start, end, isFloating } = resolveSummaryTimes(normalizedEvent, isAllDay);

  return {
    title: normalizedEvent.title || '',
    start,
    end,
    isAllDay,
    isFloating,
    timeZone: !isAllDay && !isFloating && normalizedEvent.timeZone && isValidTimeZone(normalizedEvent.timeZone)
      ? normalizedEvent.timeZone
      : null,
    location,
    organizer,
    organizerEmail,
    attendeeCount,
  };
}

const HAS_UTC_OFFSET = /(?:Z|[+-]\d{2}:?\d{2})$/i;

/** Wall-clock arithmetic on plain fields, independent of any zone. */
function shiftWallClock(w: WallClock, days: number, seconds: number): WallClock {
  const d = new Date(0);
  d.setUTCFullYear(w.year, w.month - 1, w.day + days);
  d.setUTCHours(w.hour, w.minute, w.second + seconds, 0);
  return {
    year: d.getUTCFullYear(),
    month: d.getUTCMonth() + 1,
    day: d.getUTCDate(),
    hour: d.getUTCHours(),
    minute: d.getUTCMinutes(),
    second: d.getUTCSeconds(),
  };
}

function formatLocalDateTime(w: WallClock): string {
  const pad = (n: number, len = 2) => String(n).padStart(len, '0');
  return `${pad(w.year, 4)}-${pad(w.month)}-${pad(w.day)}T${pad(w.hour)}:${pad(w.minute)}:${pad(w.second)}`;
}

/** Days (nominal) and seconds (exact) of an ISO 8601 / JSCalendar duration. */
function parseDurationParts(duration: string): { days: number; seconds: number } | null {
  const match = duration.match(/^P(?:(\d+)W)?(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?$/);
  if (!match) return null;
  return {
    days: Number(match[1] || 0) * 7 + Number(match[2] || 0),
    seconds: Number(match[3] || 0) * 3600 + Number(match[4] || 0) * 60 + Number(match[5] || 0),
  };
}

function isValidInstant(value: string | null | undefined): value is string {
  return typeof value === 'string' && HAS_UTC_OFFSET.test(value) && !Number.isNaN(new Date(value).getTime());
}

/**
 * Start and end of an event for display. Timed events come back as UTC
 * instants (ISO strings ending in `Z`) so they can be shown in the user's
 * zone; all-day and floating events come back as LocalDateTime strings that
 * must be shown as the wall clock they are (#1252).
 *
 * CalendarEvent/parse returns `start` as a LocalDateTime in `timeZone` and
 * no `utcStart`, so reading `start` as an instant showed the organizer's
 * wall clock as if it were the user's.
 */
function resolveSummaryTimes(
  event: Partial<CalendarEvent>,
  isAllDay: boolean,
): { start: string | null; end: string | null; isFloating: boolean } {
  const duration = event.duration ? parseDurationParts(event.duration) : null;
  const localStart = event.start ? parseLocalDateTime(event.start) : null;

  if (isAllDay) {
    // The date is the same everywhere: never convert it through a zone.
    if (!localStart) return { start: event.start || null, end: null, isFloating: false };
    let end: string | null = null;
    if (duration) {
      end = formatLocalDateTime(shiftWallClock(localStart, duration.days, duration.seconds));
    } else if (event.utcEnd) {
      const endDate = parseLocalDateTime(event.utcEnd.slice(0, 10));
      if (endDate) end = formatLocalDateTime(endDate);
    }
    return { start: formatLocalDateTime(localStart), end, isFloating: false };
  }

  const addExact = (instant: Date, days: number, seconds: number) =>
    new Date(instant.getTime() + (days * 86400 + seconds) * 1000).toISOString();

  if (isValidInstant(event.utcStart)) {
    const end = isValidInstant(event.utcEnd)
      ? event.utcEnd
      : duration ? addExact(new Date(event.utcStart), duration.days, duration.seconds) : null;
    return { start: event.utcStart, end, isFloating: false };
  }

  if (isValidInstant(event.start)) {
    const end = isValidInstant(event.utcEnd)
      ? event.utcEnd
      : duration ? addExact(new Date(event.start), duration.days, duration.seconds) : null;
    return { start: new Date(event.start).toISOString(), end, isFloating: false };
  }

  if (!localStart) return { start: event.start || null, end: null, isFloating: false };

  if (event.timeZone && isValidTimeZone(event.timeZone)) {
    const timeZone = event.timeZone;
    const startInstant = fromWallClock(localStart, timeZone);
    let end: string | null = null;
    if (isValidInstant(event.utcEnd)) {
      end = event.utcEnd;
    } else if (duration) {
      // Days are nominal (same wall clock N days later in the event's zone),
      // hours/minutes/seconds are exact.
      const dayShifted = fromWallClock(shiftWallClock(localStart, duration.days, 0), timeZone);
      end = addExact(dayShifted, 0, duration.seconds);
    }
    return { start: startInstant.toISOString(), end, isFloating: false };
  }

  // Floating time (no zone, or one we can't resolve): same wall clock everywhere.
  const end = duration
    ? formatLocalDateTime(shiftWallClock(localStart, duration.days, duration.seconds))
    : null;
  return { start: formatLocalDateTime(localStart), end, isFloating: true };
}

export interface InvitationDisplayTime {
  date: Date;
  /**
   * True when `date` carries a wall clock in its UTC fields (all-day or
   * floating). Format it with `timeZone: 'UTC'` so it is not converted.
   */
  wallClock: boolean;
}

function toInvitationDisplayTime(value: string | null): InvitationDisplayTime | null {
  if (!value) return null;
  if (HAS_UTC_OFFSET.test(value)) {
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? null : { date, wallClock: false };
  }
  const w = parseLocalDateTime(value);
  if (!w) return null;
  const date = new Date(0);
  date.setUTCFullYear(w.year, w.month - 1, w.day);
  date.setUTCHours(w.hour, w.minute, w.second, 0);
  return { date, wallClock: true };
}

/**
 * What the invitation banner shows for an event summary. All-day events get
 * their last day (the stored end is exclusive), or no end for a single day.
 */
export function getInvitationDisplayRange(
  summary: Pick<EventSummary, 'start' | 'end' | 'isAllDay'>,
): { start: InvitationDisplayTime; end: InvitationDisplayTime | null } | null {
  const start = toInvitationDisplayTime(summary.start);
  if (!start) return null;
  let end = toInvitationDisplayTime(summary.end);
  if (end && summary.isAllDay) {
    const lastDay = new Date(end.date.getTime());
    lastDay.setUTCDate(lastDay.getUTCDate() - 1);
    end = lastDay.getTime() > start.date.getTime() ? { date: lastDay, wallClock: true } : null;
  } else if (end && end.date.getTime() <= start.date.getTime()) {
    // Zero-duration event (utcEnd == utcStart): no separate end to show.
    end = null;
  }
  return { start, end };
}

/** How the banner writes times: the app's language, the user's zone and clock. */
export interface InvitationFormatOptions {
  locale: string;
  /** The user's zone (getEffectiveTimeZone). */
  timeZone: string;
  hour12: boolean;
}

function formatterFor(locale: string, options: Intl.DateTimeFormatOptions): Intl.DateTimeFormat {
  try {
    return new Intl.DateTimeFormat(locale, options);
  } catch {
    return new Intl.DateTimeFormat('en', options);
  }
}

type RangeFormatter = Intl.DateTimeFormat & { formatRange?: (start: Date, end: Date) => string };

/** `start` to `end` as Intl writes a range: the date once when both are on one day ("Thu, Nov 5, 10:00 – 11:30"). */
function formatRange(formatter: Intl.DateTimeFormat, start: Date, end: Date | null): string {
  if (!end) return formatter.format(start);
  const ranged = formatter as RangeFormatter;
  if (typeof ranged.formatRange === 'function') return ranged.formatRange(start, end);
  return `${formatter.format(start)} – ${formatter.format(end)}`;
}

/**
 * The banner's "when" line (pim-23): on the user's clock, the date once for
 * an event within one day ("Thu, Nov 5, 10:00 – 11:30", Intl's range
 * format). A timed event whose zone's clock reads differently from the
 * user's gets its own times after it: "Thu, Nov 5, 16:00 – 17:30 (10:00 –
 * 11:30 New York)". An event in the user's zone shows no zone: "GMT+1" on
 * every invitation told nobody anything. All-day and floating events are a
 * wall clock, the same everywhere.
 */
export function formatInvitationSchedule(
  summary: Pick<EventSummary, 'start' | 'end' | 'isAllDay'> & { timeZone?: string | null },
  options: InvitationFormatOptions,
): string {
  const range = getInvitationDisplayRange(summary);
  if (!range) return summary.start ?? '';
  const wallClock = range.start.wallClock;
  const parts: Intl.DateTimeFormatOptions = summary.isAllDay
    ? { weekday: 'short', month: 'short', day: 'numeric' }
    : { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', hour12: options.hour12 };
  const zone = wallClock ? 'UTC' : options.timeZone;
  const text = formatRange(formatterFor(options.locale, { ...parts, timeZone: zone }), range.start.date, range.end?.date ?? null);
  if (wallClock || summary.isAllDay || !summary.timeZone || !isValidTimeZone(summary.timeZone)) return text;

  const eventZone = summary.timeZone;
  const start = range.start.date;
  if (getTimeZoneOffsetMs(start, eventZone) === getTimeZoneOffsetMs(start, options.timeZone)) return text;
  // Its own times: without the date when its day there is the user's day.
  const day = (z: string) => formatterFor('en-CA', { timeZone: z, year: 'numeric', month: '2-digit', day: '2-digit' }).format(start);
  const own: Intl.DateTimeFormatOptions = day(eventZone) === day(options.timeZone)
    ? { hour: 'numeric', minute: '2-digit', hour12: options.hour12 }
    : parts;
  const ownText = formatRange(formatterFor(options.locale, { ...own, timeZone: eventZone }), start, range.end?.date ?? null);
  const city = (eventZone.split('/').pop() || eventZone).replace(/_/g, ' ');
  return `${text} (${ownText} ${city})`;
}

/**
 * The ux_pim_event key of the banner's line once the user has answered an
 * invitation (pim-23), "You accepted on {date}." in place of the prompt to
 * answer; null while it is unanswered, and for any other message.
 */
export function invitationAnsweredKey(
  method: InvitationMethod,
  status: string | null | undefined,
  withDate: boolean,
): string | null {
  if (method !== 'request') return null;
  if (status !== 'accepted' && status !== 'declined' && status !== 'tentative') return null;
  return `answered_${status}${withDate ? '' : '_nodate'}`;
}

/**
 * When the user answered: just now in this banner, else the time the server
 * keeps for the answer (scheduleUpdated), else the last change of their copy
 * of the event, which an answer is. Null when none of them is known.
 */
export function invitationAnsweredAt(
  answeredNow: Date | null,
  participant: Pick<CalendarParticipant, 'scheduleUpdated'> | null | undefined,
  copyUpdated: string | null | undefined,
): Date | null {
  if (answeredNow) return answeredNow;
  for (const value of [participant?.scheduleUpdated, copyUpdated]) {
    if (!value) continue;
    const date = new Date(value);
    if (!Number.isNaN(date.getTime())) return date;
  }
  return null;
}

/**
 * The participant matching the first of `emails` found in the event. The
 * user's identities, primary first: an invite may be addressed to an alias
 * identity rather than the primary address (#1283).
 */
/**
 * An invitation to a series is answered as a series: the answer is the series'
 * own, and occurrences answered no on their own are listed apart (pim-p2-8).
 * The card said "You declined" for a weekly meeting when one week was declined,
 * read from whichever occurrence the calendar held first. `master` is the
 * series as stored, with its recurrenceOverrides; `declined` holds the
 * recurrence ids (wall clock in the event's zone), oldest first.
 */
export function seriesAnswers(
  master: Partial<CalendarEvent>,
  emails: readonly string[],
): { status: string | null; declined: string[] } {
  const own = findParticipantByEmails(master, emails);
  const status = own?.participant.participationStatus ?? null;
  const declined: string[] = [];
  for (const [recurrenceId, patch] of Object.entries(master.recurrenceOverrides ?? {})) {
    if (!patch || typeof patch !== 'object' || (patch as { excluded?: unknown }).excluded === true) continue;
    const occurrence = applyOverridePatch(master, patch as Record<string, unknown>);
    const mine = findParticipantByEmails(occurrence, emails);
    if (mine?.participant.participationStatus === 'declined' && status !== 'declined') declined.push(recurrenceId);
  }
  return { status, declined: declined.sort() };
}

/** Whether a parsed invitation is for a whole series, not one occurrence of it. */
export function isSeriesInvitation(event: Partial<CalendarEvent> | null | undefined): boolean {
  return !!event?.recurrenceRules?.length && !event.recurrenceId;
}

export function findParticipantByEmails(
  event: Partial<CalendarEvent>,
  emails: readonly string[]
): { id: string; participant: CalendarParticipant } | null {
  for (const email of emails) {
    const found = findParticipantByEmail(event, email);
    if (found) return found;
  }
  return null;
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
