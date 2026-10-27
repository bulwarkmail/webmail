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

/**
 * The alerts an event fires: the calendar's default alerts while the event
 * uses them, its own otherwise - never both. Stalwart 1.0 also fills the
 * defaults into the `alerts` of such an event, under the default alerts'
 * ids; reading one or the other keeps each alert firing once.
 */
export function getEffectiveAlerts(
  event: CalendarEvent,
  calendars: Calendar[]
): Record<string, CalendarEventAlert> | null {
  if (!event.useDefaultAlerts) {
    return event.alerts;
  }
  // Stalwart copies the calendar's defaults into the event when it is
  // created and later default changes don't reach it. Its copy is what the
  // server (email alerts) and other clients fire, so follow it when present.
  if (event.alerts && Object.keys(event.alerts).length > 0) {
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

/** The calendar's default alerts for a timed or an all-day event. */
export function getCalendarDefaultAlerts(
  calendar: Calendar | null | undefined,
  allDay: boolean
): Record<string, CalendarEventAlert> | null {
  if (!calendar) return null;
  const alerts = allDay ? calendar.defaultAlertsWithoutTime : calendar.defaultAlertsWithTime;
  return alerts && Object.keys(alerts).length > 0 ? alerts : null;
}

export type AlertUnit = 'at_time' | 'minutes' | 'hours' | 'days' | 'weeks';
export type AlertAction = CalendarEventAlert['action'];

/** One editable reminder: an amount and unit before the start, and how it fires. */
export interface AlertRow {
  id: string;
  value: number;
  unit: AlertUnit;
  action: AlertAction;
}

let alertRowSeq = 0;
export function newAlertRow(value: number, unit: AlertUnit, action: AlertAction = 'display'): AlertRow {
  alertRowSeq += 1;
  return { id: `r${alertRowSeq}`, value, unit, action };
}

export function alertRowToOffset(row: Pick<AlertRow, 'value' | 'unit'>): string | null {
  if (row.unit === 'at_time') return 'PT0S';
  const v = Math.max(0, Math.floor(row.value));
  if (!Number.isFinite(v) || v <= 0) return null;
  switch (row.unit) {
    case 'minutes': return `-PT${v}M`;
    case 'hours': return `-PT${v}H`;
    case 'days': return `-P${v}D`;
    case 'weeks': return `-P${v}W`;
  }
}

/**
 * Reads an offset at or before the start as an amount and unit. Offsets after
 * the start and compound ones (-P1DT2H) return null: the rows can't show them.
 */
export function offsetToAlertUnit(offset: string): { value: number; unit: AlertUnit } | null {
  if (/^-?PT?0[SMHDW]$/.test(offset)) return { value: 0, unit: 'at_time' };
  if (!offset.startsWith('-')) return null;
  let m = offset.match(/^-P(\d+)W$/);
  if (m) return { value: parseInt(m[1], 10), unit: 'weeks' };
  m = offset.match(/^-P(\d+)D$/);
  if (m) return { value: parseInt(m[1], 10), unit: 'days' };
  m = offset.match(/^-PT(\d+)H$/);
  if (m) return { value: parseInt(m[1], 10), unit: 'hours' };
  m = offset.match(/^-PT(\d+)M$/);
  if (m) {
    const mins = parseInt(m[1], 10);
    if (mins > 0 && mins % 1440 === 0) return { value: mins / 1440, unit: 'days' };
    if (mins > 0 && mins % 60 === 0) return { value: mins / 60, unit: 'hours' };
    return { value: mins, unit: 'minutes' };
  }
  return null;
}

/**
 * Describes an alert as a row, or null when the row editor can't represent it
 * (absolute triggers, offsets relative to the end or after the start).
 */
export function describeAlert(alert: CalendarEventAlert): Omit<AlertRow, 'id'> | null {
  if (alert.trigger['@type'] !== 'OffsetTrigger') return null;
  // Stalwart leaves relativeTo out when it is the default, `start`.
  if (alert.trigger.relativeTo === 'end') return null;
  if (alert.action !== 'display' && alert.action !== 'email') return null;
  const unit = offsetToAlertUnit(alert.trigger.offset);
  if (!unit) return null;
  return { ...unit, action: alert.action };
}

/** Splits an alert map into editable rows and the alerts to keep as they are. */
export function alertsToRows(alerts: Record<string, CalendarEventAlert> | null | undefined): {
  rows: AlertRow[];
  preserved: Record<string, CalendarEventAlert>;
} {
  const rows: AlertRow[] = [];
  const preserved: Record<string, CalendarEventAlert> = {};
  for (const [id, alert] of Object.entries(alerts ?? {})) {
    const row = describeAlert(alert);
    if (row) rows.push(newAlertRow(row.value, row.unit, row.action));
    else preserved[id] = alert;
  }
  return { rows, preserved };
}

/** Builds the alert map to save from the rows plus the preserved alerts. */
export function rowsToAlerts(
  rows: AlertRow[],
  preserved: Record<string, CalendarEventAlert> = {}
): Record<string, CalendarEventAlert> {
  const built: Record<string, CalendarEventAlert> = { ...preserved };
  let idx = 0;
  for (const row of rows) {
    const offset = alertRowToOffset(row);
    if (offset === null) continue;
    let key = `alert${++idx}`;
    while (key in built) key = `alert${++idx}`;
    built[key] = {
      '@type': 'Alert',
      trigger: { '@type': 'OffsetTrigger', offset, relativeTo: 'start' },
      action: row.action,
      acknowledged: null,
      relatedTo: null,
    };
  }
  return built;
}

export function buildAlertKey(eventId: string, alertId: string, fireTimeMs: number): string {
  return `${eventId}:${alertId}:${fireTimeMs}`;
}

/**
 * `alerts` under new ids (alert1, alert2, ...), none of them in `taken`.
 *
 * For an event or task that turns its calendar's default alerts off: while
 * `useDefaultAlerts` is on, Stalwart 1.0 shows the defaults in `alerts`
 * under the default alerts' ids, and on save it drops every alert whose id
 * is one of those. Alerts the user keeps have to be saved under ids of their
 * own, or they vanish with the defaults.
 */
export function withOwnAlertIds(
  alerts: CalendarEventAlert[],
  taken: Iterable<string>,
): Record<string, CalendarEventAlert> {
  const used = new Set(taken);
  const result: Record<string, CalendarEventAlert> = {};
  let n = 0;
  for (const alert of alerts) {
    let id: string;
    do id = `alert${++n}`; while (used.has(id));
    result[id] = alert;
  }
  return result;
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

/**
 * When the next display alert of these events and tasks fires, after `now`;
 * null when none is still to come. Lets the reminder check wake up at that
 * moment instead of on its next periodic tick (#1349).
 */
export function getNextAlertFireTime(
  events: CalendarEvent[],
  tasks: CalendarTask[],
  calendars: Calendar[],
  now: number
): number | null {
  const fireTimes: number[] = [];
  for (const event of events) {
    if (event.status === 'cancelled') continue;
    const alerts = getEffectiveAlerts(event, calendars);
    if (!alerts) continue;
    for (const alert of Object.values(alerts)) {
      if (alert.action !== 'display' || alert.acknowledged) continue;
      const fireTimeMs = computeFireTime(event, alert.trigger);
      if (fireTimeMs !== null && fireTimeMs > now) fireTimes.push(fireTimeMs);
    }
  }
  for (const task of tasks) {
    if (!task.alerts || task.progress === 'completed' || task.progress === 'cancelled') continue;
    for (const alert of Object.values(task.alerts)) {
      if (alert.action !== 'display' || alert.acknowledged) continue;
      const fireTimeMs = computeTaskFireTime(task, alert.trigger);
      if (fireTimeMs !== null && fireTimeMs > now) fireTimes.push(fireTimeMs);
    }
  }
  return fireTimes.length > 0 ? fireTimes.reduce((a, b) => Math.min(a, b)) : null;
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

  // RFC 8984 §4.5.2: relativeTo defaults to "start", which for a Task is its
  // start; "end" is its due. A task without a start counts from its due (#1328).
  const base = trigger.relativeTo !== 'end' && task.start ? task.start : task.due;
  if (!base) return null;
  const baseTime = new Date(base).getTime();
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
