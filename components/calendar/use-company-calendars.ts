"use client";

import { useEffect, useMemo, useState } from "react";
import { usePolicyStore } from "@/stores/policy-store";
import { useSettingsStore } from "@/stores/settings-store";
import type { IJMAPClient } from "@/lib/jmap/client-interface";
import type { Calendar, CalendarEvent } from "@/lib/jmap/types";
import type { CompanyFeed } from "@/lib/admin/organisation-policy";
import { companyCalendarId, createCompanyCalendar, loadFeedEvents, toCompanyEvents } from "@/lib/company-calendars";

// Feeds decide for themselves when they are due (refreshMinutes, at least
// an hour); this only looks whether one is.
const CHECK_EVERY_MS = 15 * 60 * 1000;

const NO_FEEDS: CompanyFeed[] = [];

/**
 * The company calendars of the active account's policy, and their events
 * (series not expanded). Feeds the policy no longer lists go away at once;
 * feeds that arrive with a late policy load then.
 */
export function useCompanyCalendars(client: IJMAPClient | null): {
  calendars: Calendar[];
  events: CalendarEvent[];
  /** Calendar ids of the feeds the user hid. */
  hiddenIds: string[];
} {
  const feeds = usePolicyStore((s) => s.policy.organisation?.calendars?.feeds ?? NO_FEEDS);
  const hidden = useSettingsStore((s) => s.hiddenCompanyCalendars);
  const [parsed, setParsed] = useState<Record<string, CalendarEvent[]>>({});
  // Per login, not just per JMAP account id: two servers can reuse ids.
  const accountKey = client ? `${client.getUsername?.() ?? ""}|${client.getAccountId?.() ?? ""}` : "";
  const feedsKey = JSON.stringify(feeds.map((f) => [f.id, f.url, f.refreshMinutes]));

  useEffect(() => {
    if (!client || feeds.length === 0) return;
    let cancelled = false;
    const load = () => {
      for (const feed of feeds) {
        void loadFeedEvents(client, accountKey, feed).then((events) => {
          if (cancelled) return;
          setParsed((current) => ({ ...current, [feed.id]: toCompanyEvents(feed.id, events) }));
        });
      }
    };
    load();
    const timer = setInterval(load, CHECK_EVERY_MS);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
    // feedsKey stands in for the feeds array identity.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [client, accountKey, feedsKey]);

  return useMemo(() => {
    const calendars = feeds.map(createCompanyCalendar);
    const events = feeds.flatMap((feed) => parsed[feed.id] ?? []);
    const hiddenSet = new Set(Array.isArray(hidden) ? hidden : []);
    const hiddenIds = feeds.filter((f) => hiddenSet.has(f.id)).map((f) => companyCalendarId(f.id));
    return { calendars, events, hiddenIds };
  }, [feeds, parsed, hidden]);
}
