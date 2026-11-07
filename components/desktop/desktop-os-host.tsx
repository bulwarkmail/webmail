"use client";

import { useEffect, useRef } from "react";
import { useLocale, useTranslations } from "next-intl";
import { useArchiveActionEnabled } from "@/lib/archive-gate";
import { getDesktopBridge } from "@/lib/desktop/bridge";
import { isAppLocked } from "@/lib/desktop/app-lock-state";
import { contentHiddenFor, startMailNotifications, type MailNotificationLabels, type MailNotifications } from "@/lib/desktop/mail-notifications";
import { startOsSummary, type OsSummaryHandle } from "@/lib/desktop/os-summary";
import { startPowerWatch } from "@/lib/desktop/power";
import type { IJMAPClient } from "@/lib/jmap/client-interface";
import { useAccountStore } from "@/stores/account-store";
import { useAuthStore } from "@/stores/auth-store";
import { useSettingsStore } from "@/stores/settings-store";

/**
 * The main window's end of the desktop app's OS integration: new mail as native
 * notifications, what the tray and jump list show, and waking up after sleep. Files
 * dropped or pasted on the window are the file drop overlay's (components/file-drop).
 * Renders nothing, and does nothing in a browser.
 * Lives inside MainWindowOnly, so pop-outs don't do any of it a second time.
 */
export function DesktopOsHost() {
  const t = useTranslations("desktopOs");
  const tNotify = useTranslations("notifications");
  const tPush = useTranslations("pwaNotify");
  const tCode = useTranslations("email_viewer.verification_code");
  const locale = useLocale();
  const archiveEnabled = useArchiveActionEnabled();
  const clientKey = useAccountStore((s) => s.accounts.map((a) => a.id).join("\n"));
  const isAuthenticated = useAuthStore((s) => s.isAuthenticated);
  // Logins restored after a restart connect after the window is up, and each needs a baseline.
  const connectedRevision = useAuthStore((s) => s.connectedAccountsRevision);
  const timeFormat = useSettingsStore((s) => s.timeFormat);
  const mailRef = useRef<MailNotifications | null>(null);
  const summaryRef = useRef<OsSummaryHandle | null>(null);
  const localeRef = useRef(locale);
  localeRef.current = locale;

  const labels: MailNotificationLabels = {
    newMail: t("new_mail"),
    newMailCount: (count) => tNotify("new_mail_count", { count }),
    noSubject: t("no_subject"),
    archive: archiveEnabled ? tPush("action_archive") : null,
    markRead: tPush("action_mark_read"),
    delete: t("action_delete"),
    reply: tPush("action_reply"),
    replyPlaceholder: tPush("reply_placeholder"),
    copyCode: (code) => tCode("copy", { code }),
  };
  const labelsRef = useRef(labels);
  labelsRef.current = labels;

  useEffect(() => {
    const os = getDesktopBridge()?.os;
    if (!os) return;
    // Main shows no content anywhere until this page has said it may.
    os.setLocked(isAppLocked());
    const mail = startMailNotifications(labelsRef.current);
    mailRef.current = mail;
    const summary = startOsSummary(() => localeRef.current);
    summaryRef.current = summary;
    const stopPower = startPowerWatch();
    return () => {
      mail.stop();
      summary.stop();
      stopPower();
      mailRef.current = null;
      summaryRef.current = null;
    };
  }, []);

  useEffect(() => {
    mailRef.current?.setLabels(labels);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [locale, archiveEnabled]);

  // Every login needs a state to work from before its first push.
  useEffect(() => {
    const mail = mailRef.current;
    if (!mail || !isAuthenticated) return;
    const auth = useAuthStore.getState();
    const clients = new Set<IJMAPClient>(useAccountStore.getState().accounts.flatMap((account) => auth.getClientForAccount(account.id) ?? []));
    if (auth.client) clients.add(auth.client);
    for (const client of clients) mail.seed(client);
    summaryRef.current?.refresh();
  }, [isAuthenticated, clientKey, connectedRevision]);

  // The next event's day and time are written in the page's language and time format:
  // say them again at once, as the tray's own words change with the language now.
  const summaryWords = useRef({ locale, timeFormat });
  useEffect(() => {
    const before = summaryWords.current;
    summaryWords.current = { locale, timeFormat };
    if (before.locale === locale && before.timeFormat === timeFormat) return;
    summaryRef.current?.refresh(true);
  }, [locale, timeFormat]);

  return null;
}
