"use client";

import { useLocale, useTranslations } from "next-intl";
import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import { getPathPrefix } from "@/lib/browser-navigation";
import { reminderTimeZone, useMissedReminders } from "@/lib/calendar-reminders/state";
import { dismissReminders, joinLabel, joinMeeting } from "@/lib/desktop/reminder-notifications";
import { useSettingsStore } from "@/stores/settings-store";
import { collectionDisplayName } from "@/lib/default-collection-name";

/** What came due while the app was closed, the machine slept or notifications were paused. */
export function MissedRemindersDialog() {
  const t = useTranslations("desktopReminders");
  const tAlert = useTranslations("calendar.notifications");
  const tWording = useTranslations("uxs_wording");
  const locale = useLocale();
  const timeZone = useSettingsStore((s) => s.timeZone);
  const timeFormat = useSettingsStore((s) => s.timeFormat);
  const account = useMissedReminders((s) => s.account);
  const alerts = useMissedReminders((s) => s.alerts);
  const close = useMissedReminders((s) => s.close);
  const joinLabels = { join: t("join"), joinHost: (host: string) => t("join_host", { host }) };

  if (!account || alerts.length === 0) return null;

  const format = new Intl.DateTimeFormat(locale, { dateStyle: "medium", timeStyle: "short", hour12: timeFormat === "12h", timeZone: reminderTimeZone(timeZone) });
  const finish = () => {
    dismissReminders(account, alerts.map((alert) => alert.key));
    close();
  };

  return (
    <Dialog
      isOpen
      onClose={finish}
      title={t("missed_dialog_title")}
      description={t("missed_dialog_description")}
      footer={(
        <>
          <Button
            variant="outline"
            onClick={() => {
              finish();
              window.location.href = `${getPathPrefix(locale)}/${locale}/calendar`;
            }}
          >
            {t("open_calendar")}
          </Button>
          <Button onClick={finish}>{t("done")}</Button>
        </>
      )}
    >
      <ul className="max-h-80 overflow-y-auto divide-y divide-border" data-testid="missed-reminders">
        {alerts.map((alert) => (
          <li key={alert.key} className="flex items-center gap-3 py-2">
            <div className="min-w-0 flex-1">
              <p className="truncate text-sm font-medium text-foreground">{alert.title || tAlert("alert_title")}</p>
              <p className="truncate text-xs text-muted-foreground">
                {format.format(new Date(alert.startMs ?? alert.fireTimeMs))}
                {alert.calendarName ? ` · ${collectionDisplayName(alert.calendarName, "calendar", tWording("default_calendar"))}` : ""}
              </p>
            </div>
            {alert.joinUrl && (
              <Button
                variant="outline"
                size="sm"
                aria-label={t("join_named", { title: alert.title || tAlert("alert_title") })}
                onClick={() => void joinMeeting(alert.joinUrl!)}
              >
                {joinLabel(alert, joinLabels)}
              </Button>
            )}
          </li>
        ))}
      </ul>
    </Dialog>
  );
}
