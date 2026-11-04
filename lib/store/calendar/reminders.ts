/**
 * Which alerts fire in a time window, from what's stored. No DOM, no stores, no
 * React: desktop reminders call this while the window is hidden.
 *
 * Keys use the series' uid and the fire time, never an id. Synthetic ids can
 * change, browser occurrences don't exist on the server, and a stand-in id becomes
 * a real one. A moved occurrence gets a new key, as it should: it's a new time to
 * remind.
 */

import { format, parseISO } from 'date-fns';
import { buildAlertKey, computeFireTime, computeTaskFireTime, getEffectiveAlerts, parseAlertOffset } from '@/lib/calendar-alerts';
import { isTaskLikeObject } from '@/lib/calendar-component-detection';
import { normalizeCalendarEventLike, parseDurationSeconds } from '@/lib/calendar-event-normalization';
import { findJoinLink, type EventPlaces } from '@/lib/event-links';
import type { Calendar, CalendarEvent, CalendarEventAlert, CalendarTask } from '@/lib/jmap/types';
import { expandRecurringEvents } from '@/lib/recurrence-expansion';
import { listObjects } from '../engine/core-schema';
import type { StorageAdapter } from '../storage';
import { instantOf, instantsOf, isSeries, type CalendarObject } from './records';

export interface UpcomingAlert {
  /** Stable for this alert at this time. Use it to remember what was shown. */
  key: string;
  jmap: string;
  /** The series' uid, or the id where there's none: the same one whichever path shows the reminder. */
  uid: string;
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
  /** The start as an instant, to say how long until it. Null when it can't be told. */
  startMs: number | null;
  /** Joins the meeting, when the event has a video link. Web links only. */
  joinUrl: string | null;
  /** Where that goes, when it's no service this app knows. */
  joinHost: string | null;
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
  /** Which account's copy to use for a meeting that's in several. */
  prefer?: string;
}

type AlertMap = Record<string, CalendarEventAlert> | null | undefined;

/** Anyone asking to be reminded further off than this has made a typing error, and expanding that far has no end. */
const LONGEST_OFFSET_MS = 366 * 24 * 3_600_000;

// An alert fires up to its offset away from its occurrence, and the occurrence's
// wall clock is up to 26 hours from the instant. Expand wide, filter by instant.
function offsetReachMs(alerts: AlertMap): number {
  let reach = 0;
  for (const alert of Object.values(alerts ?? {})) {
    if (!alert?.trigger || alert.trigger['@type'] === 'AbsoluteTrigger') continue;
    const offset = Math.abs(parseAlertOffset(alert.trigger.offset ?? '') ?? 0);
    if (offset <= LONGEST_OFFSET_MS) reach = Math.max(reach, offset);
  }
  return reach;
}

/** What can fire at all. The server keeps whatever a client wrote, so none of this is a given. */
function usableAlerts(alerts: AlertMap): Array<[string, CalendarEventAlert]> {
  return Object.entries(alerts ?? {}).filter(([, alert]) => {
    if (!alert?.trigger || alert.action !== 'display') return false;
    if (alert.trigger['@type'] === 'AbsoluteTrigger') return true;
    return Math.abs(parseAlertOffset(alert.trigger.offset ?? '') ?? Infinity) <= LONGEST_OFFSET_MS;
  });
}

/** Keeps keys, and the toast that hands one back, a sensible size. Not for secrecy. */
function bounded(value: string, limit: number): string {
  if (value.length <= limit) return value;
  let h1 = 0xdeadbeef;
  let h2 = 0x41c6ce57;
  for (let i = 0; i < value.length; i += 1) {
    const code = value.charCodeAt(i);
    h1 = Math.imul(h1 ^ code, 2654435761);
    h2 = Math.imul(h2 ^ code, 1597334677);
  }
  return `#${(h1 >>> 0).toString(36)}${(h2 >>> 0).toString(36)}:${value.length}`;
}

/**
 * A fixed time on a series is for the occurrence that follows it. When that one was
 * excluded there's nothing to remind of, and no later occurrence takes it over.
 */
function fixedAlertForExcluded(master: CalendarEvent, fireTimeMs: number, occurrences: CalendarEvent[], zone: string): boolean {
  const excluded = Object.entries(master.recurrenceOverrides ?? {})
    .filter(([, override]) => (override as { excluded?: boolean }).excluded)
    .map(([at]) => instantOf(at, master.timeZone ?? zone))
    .filter((at): at is number => at !== null && at >= fireTimeMs);
  if (excluded.length === 0) return false;
  const nextExcluded = Math.min(...excluded);
  return !occurrences.some((occurrence) => {
    const at = instantOf(occurrence.start, occurrence.timeZone ?? zone);
    return at !== null && at >= fireTimeMs && at < nextExcluded;
  });
}

function alertsInOverrides(event: CalendarEvent): AlertMap[] {
  return Object.values(event.recurrenceOverrides ?? {}).map((override) => (override as { alerts?: AlertMap } | null)?.alerts);
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

/**
 * RFC 8984 4.5.2: on a series `acknowledged` sits on the master and covers what fired
 * up to then. Read as "never again", one dismissal in another app would silence every
 * later occurrence. An event once is done with it either way.
 */
function acknowledgedAlready(alert: CalendarEventAlert, fireTimeMs: number, series: boolean): boolean {
  if (!alert.acknowledged) return false;
  if (!series) return true;
  const at = new Date(alert.acknowledged).getTime();
  return Number.isNaN(at) || fireTimeMs <= at;
}

function instant(value: string | null | undefined): number | null {
  if (!value) return null;
  const ms = new Date(value).getTime();
  return Number.isNaN(ms) ? null : ms;
}

function firstCalendar(calendarIds: unknown, calendars: Calendar[]): { id: string | null; name: string | null } {
  const id = Object.keys((calendarIds ?? {}) as Record<string, boolean>)[0] ?? null;
  return { id, name: calendars.find((calendar) => calendar.id === id)?.name ?? null };
}

/**
 * Someone else's calendar on 1.0 is unsubscribed until the user adds it, and an account
 * can be shared without anyone asking for its reminders. Says nothing: it counts.
 */
function inSubscribedCalendar(calendarIds: unknown, calendars: Calendar[]): boolean {
  const ids = Object.keys((calendarIds ?? {}) as Record<string, boolean>);
  return ids.length === 0 || ids.some((id) => calendars.find((calendar) => calendar.id === id)?.isSubscribed !== false);
}

function matchOf(alert: Pick<UpcomingAlert, 'uid' | 'fireTimeMs'>): string {
  return `${alert.uid}:${alert.fireTimeMs}`;
}

/** Every `display` alert of the stored events and tasks that fires in the window, soonest first. One event that can't be read is left out, not the rest. */
export function listUpcomingAlerts(db: StorageAdapter, options: UpcomingAlertsOptions): UpcomingAlert[] {
  // By uid and time, not by account: one meeting in the own and a shared calendar rings once.
  const found = new Map<string, UpcomingAlert>();
  const add = (alert: UpcomingAlert) => {
    if (alert.fireTimeMs < options.from || alert.fireTimeMs >= options.to) return;
    const match = matchOf(alert);
    const held = found.get(match);
    if (!held || (alert.jmap === options.prefer && held.jmap !== options.prefer)) found.set(match, alert);
  };
  const rows = db.all<{ jmap: string; json: string }>('SELECT jmap, json FROM calendar_event WHERE hidden = 0');
  const calendarsOf = new Map<string, Calendar[]>();
  for (const row of rows) {
    if (!calendarsOf.has(row.jmap)) calendarsOf.set(row.jmap, listObjects<Calendar>(db, row.jmap, 'Calendar'));
    try {
      addAlertsOf(row, calendarsOf.get(row.jmap)!, options, add);
    } catch {
      // Whatever is wrong with this one, the others still have to ring.
    }
  }
  return [...found.values()].sort((a, b) => a.fireTimeMs - b.fireTimeMs || a.key.localeCompare(b.key));
}

function addAlertsOf(row: { jmap: string; json: string }, calendars: Calendar[], options: UpcomingAlertsOptions, add: (alert: UpcomingAlert) => void): void {
  const object = JSON.parse(row.json) as CalendarObject;
  if (!inSubscribedCalendar(object.calendarIds, calendars)) return;
  const calendar = firstCalendar(object.calendarIds, calendars);
  const uid = typeof object.uid === 'string' && object.uid ? object.uid : object.id;
  // With the account: Stalwart's ids repeat across accounts.
  const stableId = `${row.jmap}:${bounded(uid, 200)}`;

  if (isTaskLikeObject(object)) {
    const task = object as unknown as CalendarTask;
    if (task.progress === 'completed' || task.progress === 'cancelled') return;
    for (const [alertId, alert] of usableAlerts(task.alerts)) {
      if (alert.acknowledged) continue;
      const fireTimeMs = computeTaskFireTime(task, alert.trigger);
      if (fireTimeMs === null) continue;
      const join = findJoinLink(task as unknown as EventPlaces);
      add({
        key: buildAlertKey(stableId, bounded(alertId, 64), fireTimeMs),
        jmap: row.jmap,
        uid,
        kind: 'task',
        baseEventId: object.id,
        recurrenceId: null,
        alertId,
        fireTimeMs,
        title: task.title ?? '',
        start: task.start ?? task.due ?? null,
        startMs: instant(task.start ?? task.due),
        joinUrl: join?.url ?? null,
        joinHost: join?.host ?? null,
        timeZone: task.timeZone ?? null,
        calendarId: calendar.id,
        calendarName: calendar.name,
      });
    }
    return;
  }

  const master = normalizeCalendarEventLike(withInstants(object, options.timeZone) as unknown as CalendarEvent);
  if (typeof master.start !== 'string' || Number.isNaN(parseISO(master.start).getTime())) return;
  const series = isSeries(object);
  // Expansion reads an all-day or floating occurrence in this machine's zone. The setting decides.
  const occurrences = series
    ? occurrencesNear(master, calendars, options).map((occurrence) => withInstants(occurrence as unknown as CalendarObject, options.timeZone) as unknown as CalendarEvent)
    : [master];
  // A fixed time doesn't need an occurrence nearby.
  const candidates = series ? [master, ...occurrences] : occurrences;
  for (const occurrence of candidates) {
    if (occurrence.status === 'cancelled') continue;
    const isMasterOfSeries = series && occurrence === master;
    for (const [alertId, alert] of usableAlerts(getEffectiveAlerts(occurrence, calendars))) {
      if (isMasterOfSeries && alert.trigger['@type'] !== 'AbsoluteTrigger') continue;
      const fireTimeMs = computeFireTime(occurrence, alert.trigger);
      if (fireTimeMs === null || acknowledgedAlready(alert, fireTimeMs, series)) continue;
      if (series && alert.trigger['@type'] === 'AbsoluteTrigger' && fixedAlertForExcluded(master, fireTimeMs, occurrences, options.timeZone)) continue;
      const join = findJoinLink(occurrence as unknown as EventPlaces);
      add({
        key: buildAlertKey(stableId, bounded(alertId, 64), fireTimeMs),
        jmap: row.jmap,
        uid,
        kind: 'event',
        baseEventId: object.id,
        recurrenceId: occurrence.recurrenceId ?? null,
        alertId,
        fireTimeMs,
        title: occurrence.title ?? '',
        start: occurrence.start,
        startMs: instant(occurrence.utcStart) ?? instant(occurrence.start),
        joinUrl: join?.url ?? null,
        joinHost: join?.host ?? null,
        timeZone: occurrence.timeZone ?? null,
        calendarId: calendar.id,
        calendarName: calendar.name,
      });
    }
  }
}
