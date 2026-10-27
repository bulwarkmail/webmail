"use client";

import { useEffect, useRef, useCallback } from 'react';
import { useTranslations, useLocale } from 'next-intl';
import { parseISO } from 'date-fns';
import { useAuthStore } from '@/stores/auth-store';
import { useCalendarStore } from '@/stores/calendar-store';
import { useSettingsStore } from '@/stores/settings-store';
import { useTaskStore } from '@/stores/task-store';
import { useCalendarNotificationStore } from '@/stores/calendar-notification-store';
import { useToastStore } from '@/stores/toast-store';
import { getPendingAlerts, getPendingTaskAlerts, getNextAlertFireTime, buildAlertKey } from '@/lib/calendar-alerts';
import { playNotificationSound } from '@/lib/notification-sound';
import { getPathPrefix } from '@/lib/browser-navigation';
import type { CalendarEvent } from '@/lib/jmap/types';
import { calendarHooks } from '@/lib/plugin-hooks';
import { changesAnyType, subscribePushStateChanges } from '@/lib/push-events';

const CHECK_INTERVAL_MS = 60 * 1000;
const PROACTIVE_FETCH_HOURS = 24;
const PROACTIVE_THROTTLE_MS = CHECK_INTERVAL_MS * 5;
// Longest single wait for the next reminder; the periodic check covers the rest.
const MAX_WAKE_DELAY_MS = 6 * 60 * 60 * 1000;

export function useCalendarAlerts() {
  const { isAuthenticated, client } = useAuthStore();
  const { events, calendars, supportsCalendar } = useCalendarStore();
  const { calendarNotificationsEnabled, calendarNotificationSound, enableCalendarTasks, notificationSoundChoice } = useSettingsStore();
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

  const checkAlerts = useCallback(() => {
    if (wakeTimerRef.current) {
      clearTimeout(wakeTimerRef.current);
      wakeTimerRef.current = null;
    }
    if (!calendarNotificationsEnabled || !isAuthenticated) return;

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

        if (calendarNotificationSound) {
          playNotificationSound(notificationSoundChoice);
        }

        const diffMs = (alert.event.utcStart ? new Date(alert.event.utcStart).getTime() : parseISO(alert.event.start).getTime()) - now;
        const diffMin = Math.round(diffMs / 60000);

        void calendarHooks.onCalendarAlert.emit({
          id: alert.alertId,
          eventId: alert.eventId,
          eventTitle: alert.event.title || '',
          triggerTime: new Date(alert.fireTimeMs).toISOString(),
        });

        const timeLabel = diffMin <= 0
          ? t('alert_now')
          : t('alert_in_minutes', { count: diffMin });

        const message = alert.calendarName
          ? `${timeLabel} · ${alert.calendarName}`
          : timeLabel;

        addToast({
          type: 'info',
          title: alert.event.title || t('alert_title'),
          message,
          duration: 15000,
          onClick: () => {
            window.location.href = `${getPathPrefix(locale)}/${locale}/calendar`;
          },
          onDismiss: () => {
            void calendarHooks.onCalendarAlertAcknowledge.emit({ alertId: alert.alertId, eventId: alert.eventId });
          },
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

          if (calendarNotificationSound) {
            playNotificationSound(notificationSoundChoice);
          }

          const taskMsg = taskAlert.calendarName
            ? `${t('task_due')} · ${taskAlert.calendarName}`
            : t('task_due');

          addToast({
            type: 'info',
            title: taskAlert.task.title || t('alert_title'),
            message: taskMsg,
            duration: 15000,
            onClick: () => {
              window.location.href = `${getPathPrefix(locale)}/${locale}/calendar`;
            },
          });
        }
      }
    } catch {
      // Silently ignore alert evaluation errors
    }
  }, [
    calendarNotificationsEnabled, calendarNotificationSound, notificationSoundChoice,
    isAuthenticated, events, calendars, acknowledgedAlerts,
    acknowledgeAlert, addToast, t, locale, enableCalendarTasks, storeTasks,
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
      proactiveEventsRef.current = fetched;
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
