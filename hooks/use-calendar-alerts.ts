"use client";

import { useEffect, useRef, useCallback } from 'react';
import { useTranslations, useLocale } from 'next-intl';
import { format, parseISO } from 'date-fns';
import { isPopoutWindow } from '@/lib/popout/window-role';
import { useAuthStore } from '@/stores/auth-store';
import { useCalendarStore } from '@/stores/calendar-store';
import { usePolicyStore } from '@/stores/policy-store';
import { useSettingsStore } from '@/stores/settings-store';
import { useTaskStore } from '@/stores/task-store';
import { useCalendarNotificationStore } from '@/stores/calendar-notification-store';
import { useToastStore } from '@/stores/toast-store';
import { getPendingAlerts, getPendingTaskAlerts, getNextAlertFireTime, buildAlertKey } from '@/lib/calendar-alerts';
import { claimAlert, claimKey } from '@/lib/calendar-reminders/claims';
import { useReminderSource } from '@/lib/calendar-reminders/state';
import { showSystemReminder } from '@/lib/calendar-reminders/system-notification';
import { notifyWithoutStore } from '@/lib/desktop/reminder-notifications';
import { expandRecurringEvents } from '@/lib/recurrence-expansion';
import { playNotificationSound } from '@/lib/notification-sound';
import { lastingToastDuration } from '@/lib/toast-duration';
import { startTitleAlert } from '@/lib/title-alert';
import { getPathPrefix } from '@/lib/browser-navigation';
import { isAppLocked } from '@/lib/desktop/app-lock-state';
import { getDesktopBridge } from '@/lib/desktop/bridge';
import { contentHiddenFor } from '@/lib/desktop/mail-notifications';
import type { CalendarEvent } from '@/lib/jmap/types';
import type { CalendarAlertView } from '@/lib/plugin-types';
import { calendarHooks } from '@/lib/plugin-hooks';
import { changesAnyType, subscribePushStateChanges } from '@/lib/push-events';

const CHECK_INTERVAL_MS = 60 * 1000;
const PROACTIVE_FETCH_HOURS = 24;
const PROACTIVE_THROTTLE_MS = CHECK_INTERVAL_MS * 5;
// Wall clocks: an occurrence's can be a day off the instant it's at.
const EXPAND_MARGIN_MS = 27 * 60 * 60 * 1000;
// Longest single wait for the next reminder; the periodic check covers the rest.
const MAX_WAKE_DELAY_MS = 6 * 60 * 60 * 1000;
/** How long a reminder stays at the shortest "Notification duration". */
export const REMINDER_TOAST_MS = 15000;

/**
 * How long a reminder toast stays: until it is closed with Visual alerts on
 * (someone who can't hear the sound must not miss it) or with "until
 * closed"; otherwise the "Notification duration", at least 15 seconds.
 */
export function reminderToastDuration(): number {
  if (useSettingsStore.getState().visualAlerts) return 0;
  return lastingToastDuration(REMINDER_TOAST_MS);
}

/**
 * Whether a reminder plays its sound. Do not disturb keeps reminders on
 * screen (they were asked for) but silent.
 */
export function reminderSoundOn(soundSetting: boolean): boolean {
  return soundSetting && !useSettingsStore.getState().doNotDisturb;
}

/**
 * Visual alerts: the tab title swaps slowly to the reminder while the tab
 * is in the background. Reminders were asked for, so Do not disturb keeps
 * this too.
 */
export function reminderTitleAlert(text: string): void {
  if (useSettingsStore.getState().visualAlerts) startTitleAlert(text);
}

/**
 * Tells plugins a reminder fired, then shows it unless a plugin takes it
 * over (onBeforeCalendarAlert returning false), as one that shows reminders
 * itself does. onCalendarAlert fires either way. With no plugin asked, the
 * reminder is shown at once.
 */
export function remind(view: CalendarAlertView, show: () => void): void {
  void calendarHooks.onCalendarAlert.emit(view);
  if (calendarHooks.onBeforeCalendarAlert.size === 0) {
    show();
    return;
  }
  void calendarHooks.onBeforeCalendarAlert.intercept(view).then((allowed) => {
    if (allowed) show();
  });
}

export function useCalendarAlerts() {
  const { isAuthenticated: signedIn, client, activeAccountId } = useAuthStore();
  // Reminders of an account with a local store come from there: useStoreReminders.
  const fromStore = useReminderSource((s) => !!activeAccountId && !!s.driven[activeAccountId]);
  const calendarAllowed = usePolicyStore((s) => s.isFeatureEnabled('calendarEnabled'));
  // The main window rings; a pop-out would ring the same alert again.
  const isAuthenticated = signedIn && !isPopoutWindow() && !fromStore && calendarAllowed;
  const { events, calendars, supportsCalendar } = useCalendarStore();
  const { calendarNotificationsEnabled, calendarNotificationSound, enableCalendarTasks } = useSettingsStore();
  const { tasks: storeTasks } = useTaskStore();
  const { acknowledgedAlerts, acknowledgeAlert, cleanupStaleAlerts } = useCalendarNotificationStore();
  const addToast = useToastStore((s) => s.addToast);
  const t = useTranslations('calendar.notifications');
  const locale = useLocale();

  const lastProactiveFetchRef = useRef<number>(0);
  const proactiveEventsRef = useRef<CalendarEvent[]>([]);
  const shownKeysRef = useRef<Set<string>>(new Set());
  // Wakes the check at the next reminder's fire time (#1349).
  const wakeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const checkAlertsRef = useRef<() => void>(() => {});

  // Beside the toast: the desktop app's native notification, a browser's system one.
  const tellOutsideTheWindow = useCallback((key: string, fireTimeMs: number, title: string, body: string, wantsSound: boolean) => {
    const sound = reminderSoundOn(wantsSound);
    const { notificationSoundChoice: choice } = useSettingsStore.getState();
    if (getDesktopBridge()?.os) {
      // Main knows about pauses and quiet hours, and says whether a sound is in order.
      void notifyWithoutStore({ key, fireTimeMs, title, body, sound }, { generic: t('alert_title') }, activeAccountId).then((result) => {
        if (result?.playSound) playNotificationSound(choice);
      });
      return;
    }
    if (sound) playNotificationSound(choice);
    void showSystemReminder({
      key,
      title,
      body,
      silent: !sound,
      hidden: contentHiddenFor(activeAccountId) ? { title: t('alert_title') } : undefined,
    }, `${getPathPrefix(locale)}/${locale}/calendar`);
  }, [t, locale, activeAccountId]);

  const checkAlerts = useCallback(() => {
    if (wakeTimerRef.current) {
      clearTimeout(wakeTimerRef.current);
      wakeTimerRef.current = null;
    }
    if (!calendarNotificationsEnabled || !isAuthenticated) return;
    // Nothing may show now, so nothing is used up: the periodic check comes back to it.
    if (isAppLocked()) return;

    try {
      const now = Date.now();
      const acknowledgedKeys = new Set(Object.keys(acknowledgedAlerts));
      const allEvents = [...events, ...proactiveEventsRef.current];
      // A minute-tick alone showed reminders up to a minute late.
      const nextFire = getNextAlertFireTime(allEvents, enableCalendarTasks ? storeTasks : [], calendars, now);
      if (nextFire !== null) {
        wakeTimerRef.current = setTimeout(() => checkAlertsRef.current(), Math.min(nextFire - now, MAX_WAKE_DELAY_MS));
      }
      const pending = getPendingAlerts(allEvents, calendars, acknowledgedKeys, now);

      for (const alert of pending) {
        const key = buildAlertKey(alert.eventId, alert.alertId, alert.fireTimeMs);
        if (shownKeysRef.current.has(key)) continue;

        shownKeysRef.current.add(key);
        acknowledgeAlert(key, alert.fireTimeMs);

        const diffMs = (alert.event.utcStart ? new Date(alert.event.utcStart).getTime() : parseISO(alert.event.start).getTime()) - now;
        const diffMin = Math.round(diffMs / 60000);

        const timeLabel = diffMin <= 0
          ? t('alert_now')
          : t('alert_in_minutes', { count: diffMin });

        const message = alert.calendarName
          ? `${timeLabel} · ${alert.calendarName}`
          : timeLabel;

        const uid = alert.event.uid || alert.event.originalId || alert.eventId;
        claimAlert(claimKey(activeAccountId, uid, alert.alertId, alert.fireTimeMs), alert.fireTimeMs, () => {
          remind({
            id: alert.alertId,
            eventId: alert.eventId,
            eventTitle: alert.event.title || '',
            triggerTime: new Date(alert.fireTimeMs).toISOString(),
          }, () => {
            const title = alert.event.title || t('alert_title');
            reminderTitleAlert(t('title_alert', { title }));
            addToast({
              type: 'info',
              title,
              message,
              duration: reminderToastDuration(),
              onClick: () => {
                window.location.href = `${getPathPrefix(locale)}/${locale}/calendar`;
              },
              onDismiss: () => {
                void calendarHooks.onCalendarAlertAcknowledge.emit({ alertId: alert.alertId, eventId: alert.eventId });
              },
            });
            tellOutsideTheWindow(key, alert.fireTimeMs, title, message, calendarNotificationSound);
          });
        });
      }

      // Task alerts
      if (enableCalendarTasks && storeTasks.length > 0) {
        const pendingTaskAlerts = getPendingTaskAlerts(storeTasks, calendars, acknowledgedKeys, now);
        for (const taskAlert of pendingTaskAlerts) {
          const key = buildAlertKey(taskAlert.taskId, taskAlert.alertId, taskAlert.fireTimeMs);
          if (shownKeysRef.current.has(key)) continue;

          shownKeysRef.current.add(key);
          acknowledgeAlert(key, taskAlert.fireTimeMs);

          const taskMsg = taskAlert.calendarName
            ? `${t('task_due')} · ${taskAlert.calendarName}`
            : t('task_due');

          const uid = taskAlert.task.uid || taskAlert.taskId;
          claimAlert(claimKey(activeAccountId, uid, taskAlert.alertId, taskAlert.fireTimeMs), taskAlert.fireTimeMs, () => {
            remind({
              id: taskAlert.alertId,
              taskId: taskAlert.taskId,
              taskTitle: taskAlert.task.title || '',
              triggerTime: new Date(taskAlert.fireTimeMs).toISOString(),
            }, () => {
              const title = taskAlert.task.title || t('alert_title');
              reminderTitleAlert(t('title_alert', { title }));
              addToast({
                type: 'info',
                title,
                message: taskMsg,
                duration: reminderToastDuration(),
                onClick: () => {
                  window.location.href = `${getPathPrefix(locale)}/${locale}/calendar`;
                },
                onDismiss: () => {
                  void calendarHooks.onCalendarAlertAcknowledge.emit({ alertId: taskAlert.alertId, taskId: taskAlert.taskId });
                },
              });
              tellOutsideTheWindow(key, taskAlert.fireTimeMs, title, taskMsg, calendarNotificationSound);
            });
          });
        }
      }
    } catch {
      // Silently ignore alert evaluation errors
    }
  }, [
    calendarNotificationsEnabled, calendarNotificationSound,
    isAuthenticated, activeAccountId, events, calendars, acknowledgedAlerts,
    acknowledgeAlert, addToast, t, locale, enableCalendarTasks, storeTasks, tellOutsideTheWindow,
  ]);
  checkAlertsRef.current = checkAlerts;

  const proactiveFetch = useCallback(async (force = false) => {
    if (!client || !supportsCalendar || !calendarNotificationsEnabled || !isAuthenticated) return;

    const now = Date.now();
    if (!force && now - lastProactiveFetchRef.current < PROACTIVE_THROTTLE_MS) return;

    try {
      const start = new Date(now - 10 * 60 * 1000).toISOString();
      const end = new Date(now + PROACTIVE_FETCH_HOURS * 60 * 60 * 1000).toISOString();
      const fetched = await client.queryCalendarEvents({ after: start, before: end });
      // Without synthetic ids the server answers with a series' master, whose start can
      // be years ago: only its occurrences have a fire time. Passes real occurrences through.
      const stamp = (ms: number) => format(new Date(ms), "yyyy-MM-dd'T'HH:mm:ss");
      proactiveEventsRef.current = expandRecurringEvents(fetched, stamp(now - EXPAND_MARGIN_MS), stamp(now + PROACTIVE_FETCH_HOURS * 60 * 60 * 1000 + EXPAND_MARGIN_MS));
      lastProactiveFetchRef.current = Date.now();
      checkAlertsRef.current();
    } catch {
      // Silently ignore proactive fetch errors
    }
  }, [client, supportsCalendar, calendarNotificationsEnabled, isAuthenticated]);

  useEffect(() => {
    if (!calendarNotificationsEnabled || !isAuthenticated) return;

    cleanupStaleAlerts();
    proactiveFetch();

    const timer = setTimeout(() => checkAlerts(), 500);
    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isAuthenticated, calendarNotificationsEnabled]);

  useEffect(() => {
    if (!calendarNotificationsEnabled || !isAuthenticated) return;

    const interval = setInterval(() => {
      proactiveFetch();
      checkAlerts();
    }, CHECK_INTERVAL_MS);

    return () => clearInterval(interval);
  }, [calendarNotificationsEnabled, isAuthenticated, checkAlerts, proactiveFetch]);

  useEffect(() => {
    if (!calendarNotificationsEnabled || !isAuthenticated) return;
    checkAlerts();
  }, [events, calendarNotificationsEnabled, isAuthenticated, checkAlerts]);

  // An event created or moved elsewhere can have a reminder due within the
  // throttle window: read the next hours again when push reports a change.
  const proactiveFetchRef = useRef(proactiveFetch);
  proactiveFetchRef.current = proactiveFetch;
  useEffect(() => {
    if (!calendarNotificationsEnabled || !isAuthenticated) return;
    return subscribePushStateChanges((change, _client, role) => {
      if (role === 'active' && changesAnyType(change, ['CalendarEvent'])) void proactiveFetchRef.current(true);
    });
  }, [calendarNotificationsEnabled, isAuthenticated]);

  useEffect(() => () => {
    if (wakeTimerRef.current) clearTimeout(wakeTimerRef.current);
  }, []);
}
