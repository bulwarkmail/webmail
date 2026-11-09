/**
 * Answering an invitation for someone else (#634).
 *
 * A delegate with edit access (mayWriteAll) to another person's calendar
 * answers an invitation in that calendar as its owner: the patch sets the
 * owner's participationStatus with `sentBy = "mailto:<delegate>"` in the
 * owner's account, and Stalwart sends the organiser a REPLY from the owner
 * with ATTENDEE;SENT-BY (live on 0.16 and 1.0,
 * local-data/enterprise-pack-facts.md part 6 §2). mayRSVP alone is refused
 * by the server. A group account's members answer as the group without
 * SENT-BY: a member is not a delegate.
 *
 * Who "you" are depends on the calendar: in an account of another person or
 * a group, its owner's addresses pick the participant, not the user's own.
 *
 * Stalwart 0.16 counts the delegate's and the owner's addresses as local, so
 * with both invited it refuses the change ("Cannot modify address of the
 * event", verified live). There the owner bar is not offered when the user is
 * invited too.
 */

import type { Calendar, CalendarEvent, CalendarParticipant, Principal } from '@/lib/jmap/types';
import { eventHasNoOwner } from '@/lib/calendar-editability';
import { getUserParticipantId, isOrganizer } from '@/lib/calendar-participants';

type Status = CalendarParticipant['participationStatus'];

/** The owner of a shared account, as Bulwark shows and matches it. */
export interface AccountOwner {
  name: string;
  /** Lower-case addresses the owner's participant may carry. */
  emails: string[];
  isGroup: boolean;
}

/** The owner from Principal/get, else from the session's account name. */
export function accountOwnerOf(principal: Principal | null | undefined, accountName: string | undefined): AccountOwner | null {
  const emails = new Set<string>();
  if (principal?.email) emails.add(principal.email.trim().toLowerCase());
  if (accountName?.includes('@')) emails.add(accountName.trim().toLowerCase());
  if (emails.size === 0) return null;
  const name = principal?.description?.trim() || principal?.name?.trim() || accountName || [...emails][0];
  return { name, emails: [...emails], isGroup: principal?.type === 'group' };
}

export interface AnswerTarget {
  kind: 'self' | 'owner';
  /** The store event the answer is written to. */
  eventId: string;
  participantId: string;
  status: Status | null;
  /** `mailto:<user>` when answering for a person; left out otherwise. */
  sentBy?: string;
  /** Whose answer it is, for an owner target. */
  ownerName?: string;
}

export interface AnswerView {
  targets: AnswerTarget[];
  /** Why there is no bar for the owner, when they are invited. */
  note: { kind: 'no_write' | 'also_invited'; owner: string } | null;
  /** Who answered last for the participant shown, when someone did for them (sentBy). */
  answeredBy: string | null;
}

function addressOf(sentBy: unknown): string | null {
  if (typeof sentBy !== 'string' || !sentBy.trim()) return null;
  return sentBy.trim().replace(/^mailto:/i, '');
}

export interface ResolveAnswerInput {
  event: CalendarEvent;
  /** The event's calendar as the store holds it. */
  calendar?: Pick<Calendar, 'isShared' | 'myRights'> | null;
  /** The signed-in user's addresses; the first is the one answers are sent by. */
  userEmails: string[];
  /** Whether the existing rules let the user answer for themselves on this event (canUserRsvp). */
  canRsvpSelf: boolean;
  /** The owner of the event's account, for an event in a shared calendar. */
  owner: AccountOwner | null;
  /** The user's own copy of the event (same uid, own calendar), if loaded. */
  ownCopy?: CalendarEvent | null;
  /** The server is Stalwart 0.16 (see the module comment). */
  server016: boolean;
}

/** Which answer bars an event shows, and what to say instead of one. */
export function resolveAnswerTargets(input: ResolveAnswerInput): AnswerView {
  const { event, calendar, userEmails, owner, ownCopy } = input;
  const selfId = getUserParticipantId(event, userEmails);
  const selfTarget = (): AnswerTarget[] => (input.canRsvpSelf && selfId
    ? [{ kind: 'self', eventId: event.id, participantId: selfId, status: event.participants?.[selfId]?.participationStatus ?? null }]
    : []);
  const ownCopyTarget = (): AnswerTarget[] => {
    if (!ownCopy) return [];
    const id = getUserParticipantId(ownCopy, userEmails);
    return id ? [{ kind: 'self', eventId: ownCopy.id, participantId: id, status: ownCopy.participants?.[id]?.participationStatus ?? null }] : [];
  };

  if (calendar?.isShared && owner) {
    const ownerId = getUserParticipantId(event, owner.emails);
    // Members of a group often have the group's address as an identity of
    // their own: the group's participant is still answered as the group.
    const ownersOwn = ownerId && (ownerId !== selfId || owner.isGroup);
    if (ownersOwn && !isOrganizer(event, owner.emails) && !eventHasNoOwner(event)) {
      const participant = event.participants![ownerId!];
      const answeredBy = addressOf(participant.sentBy);
      if (!calendar.myRights?.mayWriteAll) {
        return { targets: selfTarget(), note: { kind: 'no_write', owner: owner.name }, answeredBy };
      }
      const alsoInvited = !!selfId && selfId !== ownerId;
      if (input.server016 && alsoInvited) {
        return { targets: ownCopyTarget(), note: { kind: 'also_invited', owner: owner.name }, answeredBy };
      }
      const delegate = userEmails[0]?.trim().toLowerCase();
      const ownerTarget: AnswerTarget = {
        kind: 'owner',
        eventId: event.id,
        participantId: ownerId!,
        status: participant.participationStatus ?? null,
        ownerName: owner.name,
        // Always the mailto: form: Stalwart passes sentBy through unchecked,
        // and RFC 5545's SENT-BY needs a cal-address.
        ...(!owner.isGroup && delegate ? { sentBy: `mailto:${delegate}` } : {}),
      };
      return { targets: [ownerTarget, ...(alsoInvited ? ownCopyTarget() : [])], note: null, answeredBy };
    }
  }

  const answeredBy = selfId ? addressOf(event.participants?.[selfId]?.sentBy) : null;
  return { targets: selfTarget(), note: null, answeredBy };
}

/**
 * The sentBy part of an answer's patch: the delegate's address when one
 * answers for the owner, null to clear an old one when the participant
 * answers themselves (Stalwart keeps the old SENT-BY on the next reply
 * otherwise), nothing when there is nothing to change.
 */
export function sentByPatchValue(participant: Pick<CalendarParticipant, 'sentBy'> | undefined, sentBy: string | undefined): string | null | undefined {
  if (sentBy) return sentBy;
  return participant?.sentBy ? null : undefined;
}
