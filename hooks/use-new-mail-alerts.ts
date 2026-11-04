"use client";

import { useEffect } from "react";
import { useTranslations } from "next-intl";
import { useEmailStore } from "@/stores/email-store";
import { useSettingsStore } from "@/stores/settings-store";
import { playNotificationSound } from "@/lib/notification-sound";
import { announce } from "@/lib/announce";
import { startTitleAlert } from "@/lib/title-alert";
import { debug } from "@/lib/debug";
import { desktopPlaysMailSound } from "@/lib/desktop/mail-notifications";

/**
 * Mail that arrives within this time is told about once ("3 new messages"),
 * not message by message.
 */
export const NEW_MAIL_BATCH_MS = 3000;

/**
 * What the app does when new mail reaches the Inbox (the store sets
 * `newEmailNotification` for each message; muted folders never do):
 *
 * - plays the new-mail sound once per batch, when mail notifications and
 *   their sound are on;
 * - tells screen reader users how many messages came, never what they say,
 *   when "Announce new mail" is on;
 * - with Visual alerts on, swaps the tab title slowly while the tab is in
 *   the background (lib/title-alert).
 *
 * Do not disturb silences all of it until it is turned off.
 */
export function useNewMailAlerts(): void {
  const t = useTranslations("notifications");

  useEffect(() => {
    let batch = 0;
    let batchTimer: ReturnType<typeof setTimeout> | null = null;
    // Messages the title alert counts: since the tab was last in front.
    let unseen = 0;

    const flush = () => {
      batchTimer = null;
      const count = batch;
      batch = 0;
      const s = useSettingsStore.getState();
      if (count > 0 && s.announceNewMail && !s.doNotDisturb) {
        announce(t("new_mail_count", { count }), { key: "new-mail" });
      }
    };

    const onNewMail = () => {
      const s = useSettingsStore.getState();
      if (s.doNotDisturb) return;
      if (batchTimer === null) {
        // The desktop app sounds it with the notification, in Do Not Disturb not at all.
        if (s.emailNotificationsEnabled && s.emailNotificationSound && !desktopPlaysMailSound()) {
          playNotificationSound(s.notificationSoundChoice);
        }
        batchTimer = setTimeout(flush, NEW_MAIL_BATCH_MS);
      }
      batch += 1;
      if (s.visualAlerts) {
        unseen += 1;
        startTitleAlert(t("new_mail_count", { count: unseen }));
      }
    };

    const resetUnseen = () => { unseen = 0; };
    window.addEventListener("focus", resetUnseen);

    const unsubscribe = useEmailStore.subscribe((state, prev) => {
      const email = state.newEmailNotification;
      if (!email || email === prev.newEmailNotification) return;
      debug.log("email", "New email received:", email.subject);
      state.clearNewEmailNotification();
      onNewMail();
    });

    return () => {
      unsubscribe();
      window.removeEventListener("focus", resetUnseen);
      if (batchTimer) clearTimeout(batchTimer);
    };
  }, [t]);
}
