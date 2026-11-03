"use client";

import { useEffect, useRef } from 'react';
import { useLocale, useTranslations } from 'next-intl';
import { remind, reminderSoundOn, reminderTitleAlert, reminderToastDuration } from '@/hooks/use-calendar-alerts';
import { getPathPrefix } from '@/lib/browser-navigation';
import { onAcknowledged } from '@/lib/calendar-reminders/channel';
import { claimKey, claimNow } from '@/lib/calendar-reminders/claims';
import { createReminderRunner } from '@/lib/calendar-reminders/runner';
import { reminderTimeZone, setReminderPoke, useMissedReminders, useReminderSource } from '@/lib/calendar-reminders/state';
import { closeSystemReminders, showSystemReminder } from '@/lib/calendar-reminders/system-notification';
import { isAppLocked } from '@/lib/desktop/app-lock-state';
import { getDesktopBridge } from '@/lib/desktop/bridge';
import {
  buildMissedNotification,
  buildReminderNotification,
  dismissReminders,
  joinMeeting,
  missedBody,
  SNOOZE_MINUTES,
  snoozeReminder,
  type ReminderLabels,
} from '@/lib/desktop/reminder-notifications';
import { addWakeHandler } from '@/lib/desktop/system-events';
import { playNotificationSound } from '@/lib/notification-sound';
import { offlineActive } from '@/lib/offline/offline-mode';
import { visibleAccounts, useOfflineStore } from '@/lib/offline/state';
import { addStoreEventListener } from '@/lib/offline/store-events';
import { calendarHooks } from '@/lib/plugin-hooks';
import type { CalendarAlertView } from '@/lib/plugin-types';
import { isPopoutWindow } from '@/lib/popout/window-role';
import { getStore } from '@/lib/store/client/api';
import type { MissedBatch, ReminderAlert } from '@/lib/store/reminders/ledger';
import { useAuthStore } from '@/stores/auth-store';
import { useSettingsStore } from '@/stores/settings-store';
import { useToastStore } from '@/stores/toast-store';

function viewOf(alert: ReminderAlert): CalendarAlertView {
  const triggerTime = new Date(alert.fireTimeMs).toISOString();
  return alert.kind === 'task'
    ? { id: alert.alertId, taskId: alert.baseEventId, taskTitle: alert.title, triggerTime }
    : { id: alert.alertId, eventId: alert.baseEventId, eventTitle: alert.title, triggerTime };
}

function acknowledgeView(alert: ReminderAlert) {
  return alert.kind === 'task'
    ? { alertId: alert.alertId, taskId: alert.baseEventId }
    : { alertId: alert.alertId, eventId: alert.baseEventId };
}

/**
 * Reminders from the local store: on time with no network, and in the desktop app with
 * the window hidden. For accounts without a store useCalendarAlerts carries on as before.
 */
export function useStoreReminders(): void {
  const signedIn = useAuthStore((s) => s.isAuthenticated);
  const t = useTranslations('desktopReminders');
  const tAlert = useTranslations('calendar.notifications');
  const locale = useLocale();
  const addToast = useToastStore((s) => s.addToast);
  const removeToast = useToastStore((s) => s.removeToast);
  const enabledKey = useOfflineStore((s) => s.enabled.join('\n'));

  const labels: ReminderLabels = {
    generic: t('generic_title'),
    untitled: tAlert('alert_title'),
    when: (alert) => {
      const minutes = alert.startMs === null ? 0 : Math.round((alert.startMs - Date.now()) / 60_000);
      const time = alert.kind === 'task'
        ? tAlert('task_due')
        : minutes <= 0 ? tAlert('alert_now') : tAlert('alert_in_minutes', { count: minutes });
      return alert.calendarName ? `${time} · ${alert.calendarName}` : time;
    },
    snooze: (minutes) => t('snooze', { count: minutes }),
    snoozeShort: (minutes) => t('snooze_short', { count: minutes }),
    open: t('open'),
    join: t('join'),
    missedTitle: (count) => t('missed_title', { count }),
    missedMore: (count) => t('missed_more', { count }),
  };
  const labelsRef = useRef(labels);
  labelsRef.current = labels;
  const calendarUrl = `${getPathPrefix(locale)}/${locale}/calendar`;
  const calendarUrlRef = useRef(calendarUrl);
  calendarUrlRef.current = calendarUrl;
  const runnerRef = useRef<ReturnType<typeof createReminderRunner> | null>(null);

  useEffect(() => {
    if (!signedIn || isPopoutWindow()) return;
    const toastsByKey = new Map<string, string>();

    const inAppReminder = (account: string, alert: ReminderAlert) => {
      const current = labelsRef.current;
      const desktop = !!getDesktopBridge()?.os;
      // Set when a button says what happens next, so closing the toast doesn't undo it.
      let handled = false;
      const snoozeAction = (minutes: number) => ({
        label: current.snooze(minutes),
        onClick: () => {
          handled = true;
          void snoozeReminder(account, alert.key, minutes).catch(() => {});
        },
      });
      const [five, ten, fifteen] = SNOOZE_MINUTES.map(snoozeAction);
      const id = addToast({
        type: 'info',
        title: alert.title || current.untitled,
        message: current.when(alert),
        duration: reminderToastDuration(),
        onClick: () => {
          window.location.href = calendarUrlRef.current;
        },
        onDismiss: () => {
          toastsByKey.delete(alert.key);
          void calendarHooks.onCalendarAlertAcknowledge.emit(acknowledgeView(alert));
          if (!handled) dismissReminders(account, [alert.key]);
        },
        ...(desktop ? {
          tertiaryAction: five,
          secondaryAction: ten,
          action: fifteen,
          extraActions: [
            ...(alert.joinUrl ? [{ label: current.join, onClick: () => joinMeeting(alert.joinUrl!) }] : []),
            { label: current.open, onClick: () => { window.location.href = calendarUrlRef.current; } },
          ],
        } : {}),
      });
      toastsByKey.set(alert.key, id);
    };

    const showReminder = async (account: string, alert: ReminderAlert) => {
      const settings = useSettingsStore.getState();
      const sound = reminderSoundOn(settings.calendarNotificationSound);
      const os = getDesktopBridge()?.os;
      const hold = () => getStore().area(account, 'reminders.hold', { keys: [alert.key] }).catch(() => {});
      if (os) {
        const locked = isAppLocked();
        const result = await os.notify(await buildReminderNotification(account, alert, labelsRef.current, sound));
        // Paused, quiet hours, or nothing may be said now: the summary says it later.
        if (locked || result.reason === 'paused' || result.reason === 'quiet-hours') {
          await hold();
          return;
        }
        if (result.reason === 'duplicate') return;
        if (result.playSound) playNotificationSound(settings.notificationSoundChoice);
        if (result.shown) return;
        inAppReminder(account, alert);
        return;
      }
      if (sound) playNotificationSound(settings.notificationSoundChoice);
      reminderTitleAlert(tAlert('title_alert', { title: alert.title || labelsRef.current.untitled }));
      inAppReminder(account, alert);
      void showSystemReminder({
        key: alert.key,
        title: alert.title || labelsRef.current.untitled,
        body: labelsRef.current.when(alert),
        silent: !sound,
      }, calendarUrlRef.current);
    };

    const showMissed = async (account: string) => {
      if (isAppLocked()) return;
      const timeZone = reminderTimeZone(useSettingsStore.getState().timeZone);
      const batch = await getStore().area<MissedBatch | null>(account, 'reminders.takeMissed', { timeZone });
      if (!batch) return;
      const current = labelsRef.current;
      const os = getDesktopBridge()?.os;
      if (os) {
        const result = await os.notify(await buildMissedNotification(account, batch, current));
        if (result.shown) return;
        // Told nobody, so it has to wait for a time when it can.
        if (result.reason === 'paused' || result.reason === 'quiet-hours' || result.reason === 'duplicate') {
          await getStore().area(account, 'reminders.releaseMissed', { batch: batch.batch });
          return;
        }
      }
      const keys = batch.alerts.map((alert) => alert.key);
      let opened = false;
      const body = missedBody(batch.alerts, current);
      const id = addToast({
        type: 'info',
        title: current.missedTitle(batch.alerts.length),
        message: body,
        duration: 0,
        action: {
          label: t('missed_show'),
          onClick: () => {
            opened = true;
            useMissedReminders.getState().show(account, batch.alerts);
          },
        },
        onDismiss: () => {
          for (const key of keys) toastsByKey.delete(key);
          if (!opened) dismissReminders(account, keys);
        },
      });
      for (const key of keys) toastsByKey.set(key, id);
      if (!os) {
        void showSystemReminder({
          key: `missed:${batch.batch}`,
          title: current.missedTitle(batch.alerts.length),
          body,
          silent: true,
        }, calendarUrlRef.current);
      }
    };

    const runner = createReminderRunner({
      accounts: () => visibleAccounts().filter((account) => offlineActive(account)),
      store: () => getStore(),
      params: () => {
        const settings = useSettingsStore.getState();
        return {
          timeZone: reminderTimeZone(settings.timeZone),
          tasks: settings.enableCalendarTasks,
          muted: !settings.calendarNotificationsEnabled,
        };
      },
      hidden: () => document.visibilityState === 'hidden',
      offline: () => navigator.onLine === false,
      onDue: (account, alerts) => {
        for (const alert of alerts) {
          // Whichever of the two paths got there first: one comes back from a snooze.
          const key = claimKey(account, alert.uid, alert.alertId, alert.fireTimeMs);
          if (!claimNow(key, alert.fireTimeMs) && !alert.snoozedUntil) continue;
          remind(viewOf(alert), () => {
            void showReminder(account, alert).catch((error) => {
              console.error('Failed to show a reminder:', error);
            });
          });
        }
      },
      onMissed: showMissed,
      onSource: (account, driven) => useReminderSource.getState().setDriven(account, driven),
    });
    runnerRef.current = runner;
    setReminderPoke(() => runner.poke());
    runner.start();

    const stopEvents = addStoreEventListener((event) => {
      if (event.type === 'synced') runner.synced(event.account);
      else if (event.type === 'changed' && event.collections.some((name) => name === 'CalendarEvent' || name === 'Calendar')) runner.poke();
    });
    const stopWake = addWakeHandler(() => runner.wake());
    const onOnline = () => runner.wake();
    const onVisible = () => {
      if (document.visibilityState === 'visible') runner.poke();
    };
    window.addEventListener('online', onOnline);
    document.addEventListener('visibilitychange', onVisible);
    const stopAcks = onAcknowledged((keys) => {
      for (const key of keys) {
        const id = toastsByKey.get(key);
        if (id) removeToast(id);
        toastsByKey.delete(key);
      }
      void closeSystemReminders(keys);
    });

    return () => {
      runner.stop();
      runnerRef.current = null;
      setReminderPoke(null);
      stopEvents();
      stopWake();
      stopAcks();
      window.removeEventListener('online', onOnline);
      document.removeEventListener('visibilitychange', onVisible);
    };
    // Labels go through a ref: a language change mustn't restart the check.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [signedIn]);

  // An account just turned on or off.
  useEffect(() => {
    runnerRef.current?.poke();
  }, [enabledKey]);
}
