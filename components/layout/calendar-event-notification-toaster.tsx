"use client";

import { useEffect, useRef } from "react";
import { useTranslations } from "next-intl";
import type { IJMAPClient } from "@/lib/jmap/client-interface";
import { useCalendarEventNotificationStore } from "@/stores/calendar-event-notification-store";
import { useCalendarStore } from "@/stores/calendar-store";
import { toast } from "@/stores/toast-store";

/** More notifications at once than this come as one summary toast. */
const MAX_SEPARATE_TOASTS = 3;

/**
 * Shows pending CalendarEventNotifications (someone invited you, changed or
 * cancelled an event you take part in) as toasts, refreshes the events in
 * view so the change is visible, and acknowledges them on the server.
 */
export function CalendarEventNotificationToaster({ client }: { client: IJMAPClient | null }) {
  const t = useTranslations("calendar_event_notifications");
  const pending = useCalendarEventNotificationStore((s) => s.pending);
  const acknowledge = useCalendarEventNotificationStore((s) => s.acknowledge);
  const handled = useRef(new Set<string>());

  // Initial pull; pushes call fetch() from the email store's state handler.
  useEffect(() => {
    if (!client) return;
    void useCalendarEventNotificationStore.getState().fetch(client);
  }, [client]);

  useEffect(() => {
    if (!client || pending.length === 0) return;
    const fresh = pending.filter((n) => !handled.current.has(n.id));
    if (fresh.length === 0) return;
    for (const n of fresh) handled.current.add(n.id);
    // Drafts are the user's own unsent scheduling changes - nothing to announce.
    const announced = fresh.filter((n) => !n.isDraft);
    // A script that writes into many calendars leaves hundreds of these at
    // once: one line for all of them instead of a toast each.
    const summed = announced.length > MAX_SEPARATE_TOASTS;
    if (summed) toast.info(t("summary", { count: announced.length }));
    for (const n of summed ? [] : announced) {
      const kind = n.type === "created" ? "invited" : n.type === "destroyed" ? "cancelled" : "updated";
      const message = t(kind, {
        name: n.changedBy?.name || n.changedBy?.email || t("someone"),
        title: n.event?.title || t("untitled"),
      });
      if (kind === "cancelled") toast.warning(message, n.comment || undefined);
      else toast.info(message, n.comment || undefined);
    }
    const calendarStore = useCalendarStore.getState();
    if (calendarStore.supportsCalendar && calendarStore.dateRange) {
      void calendarStore.fetchEvents(client, calendarStore.dateRange.start, calendarStore.dateRange.end);
    }
    void acknowledge(client, fresh.map((n) => n.id));
  }, [client, pending, acknowledge, t]);

  return null;
}
