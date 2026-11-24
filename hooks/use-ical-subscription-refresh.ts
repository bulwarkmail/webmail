"use client";

import { useEffect } from 'react';
import { useAuthStore } from '@/stores/auth-store';
import { useCalendarStore } from '@/stores/calendar-store';
import { usePolicyStore } from '@/stores/policy-store';
import { isPopoutWindow } from '@/lib/popout/window-role';
import { SUBSCRIPTION_CHECK_MS } from '@/lib/ical-subscription-refresh';
import { debug } from '@/lib/debug';

/**
 * Refreshes the signed-in login's iCal subscriptions that are due, when the
 * app loads and then every few minutes, on whatever page is open (#716).
 * They used to refresh only while the calendar page was open. Each
 * subscription goes by its own interval, and one tab fetches a feed for all
 * (lib/ical-subscription-refresh). A pop-out window leaves it to the main one.
 */
export function useICalSubscriptionRefresh(): void {
  const client = useAuthStore((s) => s.client);
  const signedIn = useAuthStore((s) => s.isAuthenticated);
  const calendarAllowed = usePolicyStore((s) => s.isFeatureEnabled('calendarEnabled'));
  const supportsCalendar = useCalendarStore((s) => s.supportsCalendar);
  const hasSubscriptions = useCalendarStore((s) => s.icalSubscriptions.length > 0);

  useEffect(() => {
    if (!client || !signedIn || !calendarAllowed || !supportsCalendar || !hasSubscriptions || isPopoutWindow()) return;
    const check = () => {
      useCalendarStore.getState().refreshAllSubscriptions(client).catch((error: unknown) => {
        debug.warn('calendar', 'Subscription refresh failed:', error);
      });
    };
    check();
    const timer = setInterval(check, SUBSCRIPTION_CHECK_MS);
    return () => clearInterval(timer);
  }, [client, signedIn, calendarAllowed, supportsCalendar, hasSubscriptions]);
}
