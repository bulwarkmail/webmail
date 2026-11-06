"use client";

import { useEffect, useRef } from "react";
import { useTranslations } from "next-intl";
import type { IJMAPClient } from "@/lib/jmap/client-interface";
import type { ShareNotification } from "@/lib/jmap/types";
import { useShareNotificationStore } from "@/stores/share-notification-store";
import { useEmailStore } from "@/stores/email-store";
import { useCalendarStore } from "@/stores/calendar-store";
import { useContactStore } from "@/stores/contact-store";
import { useFileStore } from "@/stores/file-store";
import { toast } from "@/stores/toast-store";

/** What happened to the user's rights, for the message wording. */
export function shareNotificationKind(n: ShareNotification): "shared" | "changed" | "revoked" {
  if (!n.oldRights || Object.keys(n.oldRights).length === 0) return "shared";
  if (!n.newRights || Object.keys(n.newRights).length === 0) return "revoked";
  return "changed";
}

const OBJECT_KEYS: Record<string, string> = {
  Mailbox: "folder",
  Calendar: "calendar",
  AddressBook: "address_book",
  FileNode: "files",
};

/** From this many notifications by one person, one toast says how many. */
export const SUMMARY_FROM = 3;

export type ShareToast =
  | { type: "single"; notification: ShareNotification; object: string }
  | { type: "summary"; changedBy: ShareNotification["changedBy"]; count: number; revoked: boolean };

/**
 * The toasts for a batch of notifications: one each, unless one person changed
 * SUMMARY_FROM or more at once (a sharing script, an admin setting up a team)
 * or the object's name is unknown. Stalwart sends an empty name, and the bare
 * object id ("b") means nothing to anyone. Then one toast per person with the
 * count.
 */
export function shareNotificationToasts(
  notifications: ShareNotification[],
  nameOf: (n: ShareNotification) => string | undefined,
): ShareToast[] {
  const byPerson = new Map<string, ShareNotification[]>();
  for (const n of notifications) {
    const key = n.changedBy?.principalId || n.changedBy?.email || n.changedBy?.name || "";
    byPerson.set(key, [...(byPerson.get(key) ?? []), n]);
  }
  const toasts: ShareToast[] = [];
  for (const group of byPerson.values()) {
    const named = group.map((n) => ({ notification: n, object: n.name || nameOf(n) || "" }));
    if (group.length < SUMMARY_FROM && named.every((n) => n.object)) {
      for (const n of named) toasts.push({ type: "single", ...n });
      continue;
    }
    toasts.push({
      type: "summary",
      changedBy: group[0].changedBy,
      count: group.length,
      revoked: group.every((n) => shareNotificationKind(n) === "revoked"),
    });
  }
  return toasts;
}

/** The name of the shared collection as the stores list it, if they do. */
function storedName(n: ShareNotification): string | undefined {
  const same = (c: { id: string; originalId?: string; accountId?: string }) =>
    (c.originalId ?? c.id) === n.objectId && (!c.accountId || c.accountId === n.objectAccountId);
  switch (n.objectType) {
    case "Mailbox":
      return useEmailStore.getState().mailboxes.find(same)?.name;
    case "Calendar":
      return useCalendarStore.getState().calendars.find(same)?.name;
    case "AddressBook":
      return useContactStore.getState().addressBooks.find(same)?.name;
    default:
      return undefined;
  }
}

/**
 * Shows pending ShareNotifications as toasts, refreshes the collection list
 * the change belongs to (so a newly shared folder / calendar / address book
 * appears without a reload) and acknowledges them on the server. A name the
 * server leaves out is looked up in the lists, before the refresh (a revoked
 * share is gone after it) and after it (a new share appears only then).
 */
export function ShareNotificationToaster({ client }: { client: IJMAPClient | null }) {
  const t = useTranslations("share_notifications");
  const pending = useShareNotificationStore((s) => s.pending);
  const acknowledge = useShareNotificationStore((s) => s.acknowledge);
  const handled = useRef(new Set<string>());

  // Initial pull; pushes call fetch() from the email store's state handler.
  useEffect(() => {
    if (!client) return;
    void useShareNotificationStore.getState().fetch(client);
  }, [client]);

  useEffect(() => {
    if (!client || pending.length === 0) return;
    const fresh = pending.filter((n) => !handled.current.has(n.id));
    if (fresh.length === 0) return;
    for (const n of fresh) handled.current.add(n.id);
    const touched = new Set(fresh.map((n) => n.objectType));
    const names = new Map(fresh.map((n) => [n.id, n.name || storedName(n)]));
    const refreshes: Promise<unknown>[] = [];
    if (touched.has("Mailbox")) refreshes.push(useEmailStore.getState().fetchMailboxes(client));
    if (touched.has("Calendar") && useCalendarStore.getState().supportsCalendar) {
      refreshes.push(useCalendarStore.getState().fetchCalendars(client));
    }
    if (touched.has("AddressBook")) refreshes.push(useContactStore.getState().fetchAddressBooks(client));
    if (touched.has("FileNode")) refreshes.push(useFileStore.getState().refresh());
    void (async () => {
      await Promise.allSettled(refreshes);
      for (const n of fresh) if (!names.get(n.id)) names.set(n.id, storedName(n));
      for (const item of shareNotificationToasts(fresh, (n) => names.get(n.id))) {
        if (item.type === "summary") {
          const name = item.changedBy?.name || item.changedBy?.email || t("someone");
          const message = t("summary", { name, count: item.count });
          if (item.revoked) toast.warning(message);
          else toast.info(message);
          continue;
        }
        const n = item.notification;
        const kind = shareNotificationKind(n);
        const objectKey = OBJECT_KEYS[n.objectType];
        const message = t(kind, {
          name: n.changedBy?.name || n.changedBy?.email || t("someone"),
          object: item.object,
          kind: objectKey ? t(`object.${objectKey}`) : n.objectType,
        });
        if (kind === "revoked") toast.warning(message);
        else toast.info(message);
      }
      await acknowledge(client, fresh.map((n) => n.id));
    })();
  }, [client, pending, acknowledge, t]);

  return null;
}
