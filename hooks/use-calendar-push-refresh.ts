"use client";

import { useEffect, useRef } from "react";
import { changesAnyType, subscribePushStateChanges } from "@/lib/push-events";

const CALENDAR_TYPES = ["Calendar", "CalendarEvent"] as const;
// A save often reports Calendar and CalendarEvent in quick succession (and
// the slow poll of shared accounts can follow the live stream): one reload.
const REFRESH_DELAY_MS = 300;

/** What the changes pushed within one refresh delay touched. */
export interface CalendarPushChanges {
  /** A calendar itself changed (name, colour, sharing): reload the list. */
  calendars: boolean;
  /**
   * The accounts whose events changed, or null for all of them (a
   * background login's change, whose account ids are another login's).
   */
  eventAccountIds: string[] | null;
}

/**
 * Runs `refresh` when push reports a calendar or event change (#1349), with
 * what changed, so a change in one account reloads that account (#1857).
 * Changes of background logins count only when the view shows their
 * calendars too (`includeBackground`, the Pro shell's merged view).
 */
export function useCalendarPushRefresh(
  refresh: (changes: CalendarPushChanges) => void,
  { enabled, includeBackground }: { enabled: boolean; includeBackground: boolean },
): void {
  const refreshRef = useRef(refresh);
  refreshRef.current = refresh;
  const includeBackgroundRef = useRef(includeBackground);
  includeBackgroundRef.current = includeBackground;

  useEffect(() => {
    if (!enabled) return;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let pending: CalendarPushChanges = { calendars: false, eventAccountIds: [] };
    const unsubscribe = subscribePushStateChanges((change, _client, role) => {
      if (role !== "active" && !includeBackgroundRef.current) return;
      if (!changesAnyType(change, CALENDAR_TYPES)) return;
      if (changesAnyType(change, ["Calendar"])) pending.calendars = true;
      if (role !== "active") {
        pending.eventAccountIds = null;
      } else if (pending.eventAccountIds) {
        for (const [accountId, types] of Object.entries(change.changed)) {
          if (types && "CalendarEvent" in types && !pending.eventAccountIds.includes(accountId)) {
            pending.eventAccountIds.push(accountId);
          }
        }
      }
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => {
        timer = null;
        const changes = pending;
        pending = { calendars: false, eventAccountIds: [] };
        refreshRef.current(changes);
      }, REFRESH_DELAY_MS);
    });
    return () => {
      unsubscribe();
      if (timer) clearTimeout(timer);
    };
  }, [enabled]);
}
