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
import { isQuietFreeBusyNotice } from "@/lib/xenaxio/free-busy";

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

/**
 * Shows pending ShareNotifications as toasts, refreshes the collection list
 * the change belongs to (so a newly shared folder / calendar / address book
 * appears without a reload) and acknowledges them on the server.
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
    const touched = new Set<string>();
    for (const n of fresh) {
      handled.current.add(n.id);
      // xenaxio: colleagues' free/busy grants are acknowledged without a toast.
      if (isQuietFreeBusyNotice(n)) continue;
      touched.add(n.objectType);
      const kind = shareNotificationKind(n);
      const objectKey = OBJECT_KEYS[n.objectType];
      const message = t(kind, {
        name: n.changedBy?.name || n.changedBy?.email || t("someone"),
        object: n.name || n.objectId,
        kind: objectKey ? t(`object.${objectKey}`) : n.objectType,
      });
      if (kind === "revoked") toast.warning(message);
      else toast.info(message);
    }
    if (touched.has("Mailbox")) void useEmailStore.getState().fetchMailboxes(client);
    if (touched.has("Calendar") && useCalendarStore.getState().supportsCalendar) {
      void useCalendarStore.getState().fetchCalendars(client);
    }
    if (touched.has("AddressBook")) void useContactStore.getState().fetchAddressBooks(client);
    if (touched.has("FileNode")) void useFileStore.getState().refresh();
    void acknowledge(client, fresh.map((n) => n.id));
  }, [client, pending, acknowledge, t]);

  return null;
}
