"use client";

import { useEffect, useRef } from "react";
import { changesAnyType, subscribePushStateChanges } from "@/lib/push-events";

const CALENDAR_TYPES = ["Calendar", "CalendarEvent"] as const;
// A save often reports Calendar and CalendarEvent in quick succession (and
// the slow poll of shared accounts can follow the live stream): one reload.
const REFRESH_DELAY_MS = 300;

/**
 * Runs `refresh` when push reports a calendar or event change (#1349).
 * Changes of background logins count only when the view shows their
 * calendars too (`includeBackground`, the Pro shell's merged view).
 */
export function useCalendarPushRefresh(
  refresh: () => void,
  { enabled, includeBackground }: { enabled: boolean; includeBackground: boolean },
): void {
  const refreshRef = useRef(refresh);
  refreshRef.current = refresh;
  const includeBackgroundRef = useRef(includeBackground);
  includeBackgroundRef.current = includeBackground;

  useEffect(() => {
    if (!enabled) return;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const unsubscribe = subscribePushStateChanges((change, _client, role) => {
      if (role !== "active" && !includeBackgroundRef.current) return;
      if (!changesAnyType(change, CALENDAR_TYPES)) return;
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => {
        timer = null;
        refreshRef.current();
      }, REFRESH_DELAY_MS);
    });
    return () => {
      unsubscribe();
      if (timer) clearTimeout(timer);
    };
  }, [enabled]);
}
