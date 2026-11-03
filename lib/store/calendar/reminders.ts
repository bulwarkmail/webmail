/**
 * Which alerts fire in a time window, from what's stored. No DOM, no stores, no
 * React: desktop reminders call this while the window is hidden.
 *
 * Keys use the master's id and the fire time, never an occurrence id. Synthetic
 * ids can change, and browser occurrences don't exist on the server. A moved
 * occurrence gets a new key, as it should: it's a new time to remind.
 */

import { format, parseISO } from 'date-fns';
import { buildAlertKey, computeFireTime, computeTaskFireTime, getEffectiveAlerts, parseAlertOffset } from '@/lib/calendar-alerts';
import { isTaskLikeObject } from '@/lib/calendar-component-detection';
import { normalizeCalendarEventLike, parseDurationSeconds } from '@/lib/calendar-event-normalization';
import type { Calendar, CalendarEvent, CalendarEventAlert, CalendarTask } from '@/lib/jmap/types';
import { expandRecurringEvents } from '@/lib/recurrence-expansion';
import { listObjects } from '../engine/core-schema';
import type { StorageAdapter } from '../storage';
import { instantsOf, isSeries, type CalendarObject } from './records';

export interface UpcomingAlert {
  /** Stable for this alert at this time. Use it to remember what was shown. */
  key: string;
  jmap: string;
  kind: 'event' | 'task';
  /** The stored event or task: the master of a series. */
  baseEventId: string;
  /** Which occurrence of the series, when it's one. */
  recurrenceId: string | null;
  alertId: string;
  fireTimeMs: number;
  title: string;
  /** The start as a wall clock, or a task's due when it has no start. */
  start: string | null;
  timeZone: string | null;
  calendarId: string | null;
  calendarName: string | null;
}

export interface UpcomingAlertsOptions {
  /** Alerts firing at or after this. */
  from: number;
  /** Alerts firing before this. */
  to: number;
  /** Reads floating events. The user's zone. */
  timeZone: string;
}

type AlertMap = Record<string, CalendarEventAlert> | null | undefined;

// An alert fires up to its offset away from its occurrence, and the occurrence's
// wall clock is up to 26 hours from the instant. Expand wide, filter by instant.
function offsetReachMs(alerts: AlertMap): number {
  let reach = 0;
  for (const alert of Object.values(alerts ?? {})) {
    if (alert.trigger?.['@type'] === 'AbsoluteTrigger') continue;
    reach = Math.max(reach, Math.abs(parseAlertOffset(alert.trigger?.offset ?? '') ?? 0));
  }
  return reach;
}

function alertsInOverrides(event: CalendarEvent): AlertMap[] {
  return Object.values(event.recurrenceOverrides ?? {}).map((override) => (override as { alerts?: AlertMap }).alerts);
}

const ZONE_REACH_MS = 27 * 3_600_000;

function occurrencesNear(event: CalendarEvent, calendars: Calendar[], options: UpcomingAlertsOptions): CalendarEvent[] {
  const reach = ZONE_REACH_MS
    + Math.max(offsetReachMs(getEffectiveAlerts(event, calendars)), ...alertsInOverrides(event).map(offsetReachMs), 0)
    + (parseDurationSeconds(event.duration) ?? 0) * 1000;
  const stamp = (ms: number) => format(new Date(ms), "yyyy-MM-dd'T'HH:mm:ss");
  return expandRecurringEvents([event], stamp(options.from - reach), stamp(options.to + reach));
}

function withInstants(object: CalendarObject, zone: string): CalendarObject {
  const { start, end } = instantsOf(object, zone);
  return {
    ...object,
    ...(start !== null ? { utcStart: new Date(start).toISOString() } : {}),
    ...(end !== null ? { utcEnd: new Date(end).toISOString() } : {}),
  };
}

function firstCalendar(calendarIds: unknown, calendars: Calendar[]): { id: string | null; name: string | null } {
  const id = Object.keys((calendarIds ?? {}) as Record<string, boolean>)[0] ?? null;
  return { id, name: calendars.find((calendar) => calendar.id === id)?.name ?? null };
}

/** Every `display` alert of the stored events and tasks that fires in the window, soonest first. */
export function listUpcomingAlerts(db: StorageAdapter, options: UpcomingAlertsOptions): UpcomingAlert[] {
  const found = new Map<string, UpcomingAlert>();
  const add = (alert: UpcomingAlert) => {
    if (alert.fireTimeMs >= options.from && alert.fireTimeMs < options.to) found.set(alert.key, alert);
  };
  const rows = db.all<{ jmap: string; json: string }>('SELECT jmap, json FROM calendar_event WHERE hidden = 0');
  const calendarsOf = new Map<string, Calendar[]>();
  for (const row of rows) {
    if (!calendarsOf.has(row.jmap)) calendarsOf.set(row.jmap, listObjects<Calendar>(db, row.jmap, 'Calendar'));
    const calendars = calendarsOf.get(row.jmap)!;
    const object = JSON.parse(row.json) as CalendarObject;
    const calendar = firstCalendar(object.calendarIds, calendars);

    if (isTaskLikeObject(object)) {
      const task = object as unknown as CalendarTask;
      if (task.progress === 'completed' || task.progress === 'cancelled') continue;
      for (const [alertId, alert] of Object.entries(task.alerts ?? {})) {
        if (alert.action !== 'display' || alert.acknowledged) continue;
        const fireTimeMs = computeTaskFireTime(task, alert.trigger);
        if (fireTimeMs === null) continue;
        add({
          key: buildAlertKey(object.id, alertId, fireTimeMs),
          jmap: row.jmap,
          kind: 'task',
          baseEventId: object.id,
          recurrenceId: null,
          alertId,
          fireTimeMs,
          title: task.title ?? '',
          start: task.start ?? task.due ?? null,
          timeZone: task.timeZone ?? null,
          calendarId: calendar.id,
          calendarName: calendar.name,
        });
      }
      continue;
    }

    const master = normalizeCalendarEventLike(withInstants(object, options.timeZone) as unknown as CalendarEvent);
    if (typeof master.start !== 'string' || Number.isNaN(parseISO(master.start).getTime())) continue;
    const series = isSeries(object);
    const occurrences = series ? occurrencesNear(master, calendars, options) : [master];
    // A fixed time doesn't need an occurrence nearby.
    const candidates = series ? [master, ...occurrences] : occurrences;
    for (const occurrence of candidates) {
      if (occurrence.status === 'cancelled') continue;
      const isMasterOfSeries = series && occurrence === master;
      for (const [alertId, alert] of Object.entries(getEffectiveAlerts(occurrence, calendars) ?? {})) {
        if (alert.action !== 'display' || alert.acknowledged) continue;
        if (isMasterOfSeries && alert.trigger['@type'] !== 'AbsoluteTrigger') continue;
        const fireTimeMs = computeFireTime(occurrence, alert.trigger);
        if (fireTimeMs === null) continue;
        add({
          key: buildAlertKey(object.id, alertId, fireTimeMs),
          jmap: row.jmap,
          kind: 'event',
          baseEventId: object.id,
          recurrenceId: occurrence.recurrenceId ?? null,
          alertId,
          fireTimeMs,
          title: occurrence.title ?? '',
          start: occurrence.start,
          timeZone: occurrence.timeZone ?? null,
          calendarId: calendar.id,
          calendarName: calendar.name,
        });
      }
    }
  }
  return [...found.values()].sort((a, b) => a.fireTimeMs - b.fireTimeMs || a.key.localeCompare(b.key));
}
