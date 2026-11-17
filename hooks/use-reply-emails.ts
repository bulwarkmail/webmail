"use client";

import { createContext, useCallback, useContext } from "react";
import type { Calendar, CalendarEvent } from "@/lib/jmap/types";
import type { AccountOwner } from "@/lib/calendar-delegate";
import { useEventUserEmails } from "@/hooks/use-event-user-emails";

const NO_OWNERS: ReadonlyMap<string, AccountOwner> = new Map();

/**
 * The owners of the shared and group accounts whose calendars are on
 * screen, by account id. The calendar provides it; without it every
 * calendar counts as the user's own.
 */
export const CalendarOwnersContext = createContext<ReadonlyMap<string, AccountOwner>>(NO_OWNERS);

/** The owner of a calendar of another person's or a group's account, if known. */
export function ownerOfCalendar(
  owners: ReadonlyMap<string, AccountOwner>,
  calendar: Pick<Calendar, "isShared" | "accountId"> | null | undefined,
): AccountOwner | null {
  if (!calendar?.isShared || !calendar.accountId) return null;
  return owners.get(calendar.accountId) ?? null;
}

/**
 * Whose answer the grid draws for an event (hatched, dashed, struck
 * through): in a calendar of another person's or a group's account its
 * owner's, as the owner sees it in their own calendar (#1760); otherwise
 * the user's, by the login the event is in.
 */
export function useReplyEmailsFor(activeEmails: string[]): (event: CalendarEvent, calendar: Calendar | null | undefined) => string[] {
  const owners = useContext(CalendarOwnersContext);
  const userEmailsFor = useEventUserEmails(activeEmails);
  return useCallback(
    (event, calendar) => ownerOfCalendar(owners, calendar)?.emails ?? userEmailsFor(event),
    [owners, userEmailsFor],
  );
}
