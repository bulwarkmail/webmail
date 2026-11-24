// Forwarding a meeting invitation to someone who isn't invited (#1797).
//
// RFC 5546 §3.2.2.6: an attendee forwards the organiser's REQUEST, with the
// same UID, organiser and attendees, and the organiser decides whether the
// new person joins. The new person's answer goes to the organiser as a
// REPLY (lib/calendar-rsvp.ts joins them as an attendee for it). The
// forward is an ordinary message: the composer opens with the invitation
// attached, and the user picks who gets it.

import type { IJMAPClient } from '@/lib/jmap/client-interface';
import type { CalendarEvent } from '@/lib/jmap/types';
import type { ParsedMailto } from '@/lib/protocol-handlers/mailto';
import { eventToICS } from '@/lib/calendar-ics-export';
import {
  findParticipantByEmails, formatEventSummary, formatInvitationSchedule, getInvitationActorSummary,
  type InvitationFormatOptions, type InvitationMethod,
} from '@/lib/calendar-invitation';
import { isOrganizer } from '@/lib/calendar-participants';

export const FORWARD_ICS_NAME = 'invite.ics';

/** A meeting: an event with participants, which an invitation can name a new person to. */
export function isForwardableMeeting(event: Pick<CalendarEvent, 'uid' | 'participants'>): boolean {
  return Boolean(event.uid && event.participants && Object.keys(event.participants).length > 0);
}

export interface ForwardLabels {
  /** The prefix of a forwarded subject ("Fwd:"). */
  subjectPrefix: string;
  /** The line above the details ("Forwarded invitation"). */
  heading: string;
  when: (value: string) => string;
  where: (value: string) => string;
  organizer: (value: string) => string;
}

/** The subject and the plain-text body of the forward: what, when, where and who organises it. */
export function invitationForwardText(
  event: Partial<CalendarEvent>,
  labels: ForwardLabels,
  format: InvitationFormatOptions,
): { subject: string; body: string } {
  const summary = formatEventSummary(event);
  const title = summary.title || event.title || '';
  const organizer = summary.organizer && summary.organizerEmail && summary.organizer !== summary.organizerEmail
    ? `${summary.organizer} <${summary.organizerEmail}>`
    : summary.organizerEmail || summary.organizer;
  const lines = [
    `---------- ${labels.heading} ----------`,
    title,
    summary.start ? labels.when(formatInvitationSchedule(summary, format)) : '',
    summary.location ? labels.where(summary.location) : '',
    organizer ? labels.organizer(organizer) : '',
  ].filter(Boolean);
  return {
    subject: `${labels.subjectPrefix} ${title}`.trim(),
    body: `\n\n${lines.join('\n')}\n`,
  };
}

/**
 * The composer draft that forwards `event`: no recipients yet, the details
 * in the body, and the invitation (METHOD:REQUEST) attached as a file the
 * new person's calendar reads.
 */
export async function buildInvitationForward(
  client: Pick<IJMAPClient, 'uploadBlob'>,
  event: CalendarEvent,
  text: { subject: string; body: string },
): Promise<ParsedMailto> {
  const ics = eventToICS(event, { method: 'REQUEST' });
  const file = new File([ics], FORWARD_ICS_NAME, { type: 'text/calendar' });
  const blob = await client.uploadBlob(file);
  return {
    to: [],
    cc: [],
    bcc: [],
    subject: text.subject,
    body: text.body,
    inApp: true,
    attachments: [{ blobId: blob.blobId, name: FORWARD_ICS_NAME, type: 'text/calendar', size: blob.size }],
  };
}

/**
 * Who answered the organiser's meeting without being invited to it: the
 * invitation was forwarded to them. The organiser decides whether they
 * join (RFC 5546 §3.2.2.6); Stalwart leaves the meeting as it is. Null for
 * anything else: another method, an event the user doesn't organise, a
 * person already in it, a "no", or a stored copy without its participants
 * loaded (which can't tell).
 */
export function uninvitedReplier(
  stored: CalendarEvent | null | undefined,
  reply: Partial<CalendarEvent> | null | undefined,
  method: InvitationMethod,
  userEmails: string[],
): { email: string; name?: string; status: 'accepted' | 'tentative' } | null {
  if (method !== 'reply' || !stored || !reply) return null;
  if (!stored.participants || Object.keys(stored.participants).length === 0) return null;
  if (!isOrganizer(stored, userEmails)) return null;
  const actor = getInvitationActorSummary(reply, 'reply');
  const status = actor?.participationStatus;
  if (!actor?.email || (status !== 'accepted' && status !== 'tentative')) return null;
  if (findParticipantByEmails(stored, [actor.email])) return null;
  return { email: actor.email, ...(actor.name ? { name: actor.name } : {}), status };
}
