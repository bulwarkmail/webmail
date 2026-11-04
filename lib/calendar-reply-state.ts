import type { CalendarEvent } from '@/lib/jmap/types';
import { getUserParticipantId, isOrganizer } from '@/lib/calendar-participants';
import { eventHasNoOwner } from '@/lib/calendar-editability';

/**
 * How the grid draws the user's answer to an invitation (pim-9): not
 * answered yet (outlined and hatched, with a "?" or "Reply" marker) or
 * maybe (dashed outline). Accepted, declined and the user's own events
 * keep their look.
 */
export type GridReplyState = 'needs-action' | 'tentative' | null;

/**
 * The user's open answer to an invitation, by the addresses of the account
 * the event is in (`userEmails`). The organiser, an ownerless event and a
 * cancelled one have nothing to answer.
 */
export function gridReplyState(event: CalendarEvent, userEmails: string[] | undefined): GridReplyState {
  if (!userEmails || userEmails.length === 0) return null;
  if (event.status === 'cancelled') return null;
  if (eventHasNoOwner(event) || isOrganizer(event, userEmails)) return null;
  const id = getUserParticipantId(event, userEmails);
  if (!id) return null;
  // JSCalendar: a participant without a status has not answered.
  const status = event.participants?.[id]?.participationStatus ?? 'needs-action';
  if (status === 'needs-action') return 'needs-action';
  if (status === 'tentative') return 'tentative';
  return null;
}
