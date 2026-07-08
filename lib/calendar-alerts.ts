import { parseISO } from 'date-fns';
import type {
  CalendarEvent,
  CalendarEventAlert,
  CalendarOffsetTrigger,
  CalendarAbsoluteTrigger,
  Calendar,
  CalendarTask,
} from '@/lib/jmap/types';
import { parseDuration } from '@/components/calendar/event-card';

export interface PendingAlert {
  eventId: string;
  alertId: string;
  fireTimeMs: number;
  event: CalendarEvent;
  calendarName: string | null;
}

const STALE_THRESHOLD_MS = 10 * 60 * 1000; // 10 minutes

const DURATION_RE = /^(-?)P(?:(\d+)W)?(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?$/;

export function parseAlertOffset(offset: string): number | null {
  const match = DURATION_RE.exec(offset);
  if (!match) return null;

  const negative = match[1] === '-';
  const weeks = parseInt(match[2] || '0', 10);
  const days = parseInt(match[3] || '0', 10);
  const hours = parseInt(match[4] || '0', 10);
  const minutes = parseInt(match[5] || '0', 10);
  const seconds = parseInt(match[6] || '0', 10);

  const ms = ((weeks * 7 * 24 * 60 * 60) + (days * 24 * 60 * 60) + (hours * 60 * 60) + (minutes * 60) + seconds) * 1000;
  return negative ? -ms : ms;
}

export function computeFireTime(
  event: CalendarEvent,
  trigger: CalendarOffsetTrigger | CalendarAbsoluteTrigger
): number | null {
  if (trigger['@type'] === 'AbsoluteTrigger') {
    const t = new Date(trigger.when).getTime();
    return Number.isNaN(t) ? null : t;
  }

  const offsetMs = parseAlertOffset(trigger.offset);
  if (offsetMs === null) return null;

  let baseTime: number;
  if (trigger.relativeTo === 'end') {
    if (event.utcEnd) {
      baseTime = new Date(event.utcEnd).getTime();
    } else {
      // Compute end from start + duration
      const startMs = parseISO(event.start).getTime();
      if (Number.isNaN(startMs)) return null;
      const durationMin = parseDuration(event.duration);
      baseTime = startMs + durationMin * 60000;
    }
  } else {
    baseTime = event.utcStart
      ? new Date(event.utcStart).getTime()
      : parseISO(event.start).getTime();
  }

  if (Number.isNaN(baseTime)) return null;
  return baseTime + offsetMs;
}

export function getEffectiveAlerts(
  event: CalendarEvent,
  calendars: Calendar[]
): Record<string, CalendarEventAlert> | null {
  if (!event.useDefaultAlerts) {
    return event.alerts;
  }

  if (!event.calendarIds) return null;
  const calendarId = Object.keys(event.calendarIds)[0];
  if (!calendarId) return null;

  const calendar = calendars.find(c => c.id === calendarId);
  if (!calendar) return null;

  if (event.showWithoutTime) {
    return calendar.defaultAlertsWithoutTime;
  }
  return calendar.defaultAlertsWithTime;
}

export function buildAlertKey(eventId: string, alertId: string, fireTimeMs: number): string {
  return `${eventId}:${alertId}:${fireTimeMs}`;
}

export function getPendingAlerts(
  events: CalendarEvent[],
  calendars: Calendar[],
  acknowledgedKeys: Set<string>,
  now: number
): PendingAlert[] {
  const pending: PendingAlert[] = [];

  for (const event of events) {
    if (event.status === 'cancelled') continue;

    const alerts = getEffectiveAlerts(event, calendars);
    if (!alerts) continue;

    const calendar = calendars.find(c => c.id === Object.keys(event.calendarIds)[0]) ?? null;

    for (const [alertId, alert] of Object.entries(alerts)) {
      if (alert.action !== 'display') continue;
      if (alert.acknowledged) continue;

      const fireTimeMs = computeFireTime(event, alert.trigger);
      if (fireTimeMs === null) continue;
      if (fireTimeMs > now) continue;
      if (fireTimeMs <= now - STALE_THRESHOLD_MS) continue;

      const key = buildAlertKey(event.id, alertId, fireTimeMs);
      if (acknowledgedKeys.has(key)) continue;

      pending.push({
        eventId: event.id,
        alertId,
        fireTimeMs,
        event,
        calendarName: calendar?.name ?? null,
      });
    }
  }

  return pending;
}

export interface PendingTaskAlert {
  taskId: string;
  alertId: string;
  fireTimeMs: number;
  task: CalendarTask;
  calendarName: string | null;
}

export function computeTaskFireTime(
  task: CalendarTask,
  trigger: CalendarOffsetTrigger | CalendarAbsoluteTrigger
): number | null {
  if (trigger['@type'] === 'AbsoluteTrigger') {
    const t = new Date(trigger.when).getTime();
    return Number.isNaN(t) ? null : t;
  }

  const offsetMs = parseAlertOffset(trigger.offset);
  if (offsetMs === null) return null;

  if (!task.due) return null;
  const baseTime = new Date(task.due).getTime();
  if (Number.isNaN(baseTime)) return null;
  return baseTime + offsetMs;
}

export function getPendingTaskAlerts(
  tasks: CalendarTask[],
  calendars: Calendar[],
  acknowledgedKeys: Set<string>,
  now: number
): PendingTaskAlert[] {
  const pending: PendingTaskAlert[] = [];

  for (const task of tasks) {
    if (!task.alerts) continue;
    if (task.progress === 'completed' || task.progress === 'cancelled') continue;

    const calendar = calendars.find(c => c.id === Object.keys(task.calendarIds)[0]) ?? null;

    for (const [alertId, alert] of Object.entries(task.alerts)) {
      if (alert.action !== 'display') continue;
      if (alert.acknowledged) continue;

      const fireTimeMs = computeTaskFireTime(task, alert.trigger);
      if (fireTimeMs === null) continue;
      if (fireTimeMs > now) continue;
      if (fireTimeMs <= now - STALE_THRESHOLD_MS) continue;

      const key = buildAlertKey(task.id, alertId, fireTimeMs);
      if (acknowledgedKeys.has(key)) continue;

      pending.push({
        taskId: task.id,
        alertId,
        fireTimeMs,
        task,
        calendarName: calendar?.name ?? null,
      });
    }
  }

  return pending;
}
