/** How calendar objects are stored and read back. */

import { parseISO } from 'date-fns';
import { isTaskLikeObject } from '@/lib/calendar-component-detection';
import { parseDurationSeconds } from '@/lib/calendar-event-normalization';
import { pointerTokenValue } from '@/lib/jmap/patch-pointer';
import { wallClockFieldsAsUtc, zonedWallTimeToUtc } from '@/lib/recurrence-expansion';
import type { StoreSession } from '../engine/transport';
import type { SqlValue, StorageAdapter } from '../storage';

export const CALENDARS_CAPABILITY = 'urn:ietf:params:jmap:calendars';
const PRINCIPALS_OWNER = 'urn:ietf:params:jmap:principals:owner';

export type CalendarObject = Record<string, unknown> & { id: string };

export function calendarUsing(session: StoreSession): string[] {
  const using = ['urn:ietf:params:jmap:core', CALENDARS_CAPABILITY];
  if (PRINCIPALS_OWNER in session.capabilities) using.push(PRINCIPALS_OWNER);
  return using;
}

/** Stalwart's default list for Calendar/get leaves out sharing and default alerts. */
export const CALENDAR_PROPERTIES = [
  'id', 'name', 'description', 'color', 'sortOrder', 'isSubscribed', 'isVisible', 'isDefault',
  'includeInAvailability', 'defaultAlertsWithTime', 'defaultAlertsWithoutTime', 'timeZone', 'shareWith', 'myRights',
] as const;

/**
 * Everything the client's event and task property lists ask for, in one get.
 * No utcStart or utcEnd: Stalwart 1.0 refuses those next to recurrenceOverrides,
 * and they depend on the zone of the request, so answers work them out.
 */
export const EVENT_PROPERTIES = [
  'id', '@type', 'uid', 'calendarIds', 'title', 'description', 'descriptionContentType', 'created', 'updated',
  'sequence', 'start', 'due', 'duration', 'timeZone', 'showWithoutTime', 'status', 'freeBusyStatus', 'privacy',
  'color', 'keywords', 'categories', 'locale', 'replyTo', 'organizerCalendarAddress', 'participants',
  'mayInviteSelf', 'mayInviteOthers', 'hideAttendees', 'recurrenceId', 'recurrenceIdTimeZone', 'recurrenceRule',
  'excludedRecurrenceRule', 'recurrenceOverrides', 'useDefaultAlerts', 'alerts', 'locations', 'virtualLocations',
  'links', 'relatedTo', 'isDraft', 'isOrigin', 'baseEventId', 'progress', 'priority', 'percentComplete',
] as const;

export function isSeries(object: Record<string, unknown>): boolean {
  const rule = object.recurrenceRule ?? object.recurrenceRules;
  return Array.isArray(rule) ? rule.length > 0 : Boolean(rule);
}

/** The value a PatchObject key points at. */
export function valueAtPointer(object: unknown, pointer: string): unknown {
  let value = object;
  for (const token of pointer.split('/')) {
    if (value === null || typeof value !== 'object') return undefined;
    value = (value as Record<string, unknown>)[pointerTokenValue(token)];
  }
  return value;
}

/** A LocalDateTime without any `Z` or offset: Stalwart drops those instead of honouring them. */
export function wallClock(value: string): string {
  return value.replace(/(?:Z|[+-]\d{2}:?\d{2})$/, '');
}

/** The instant a wall clock names in `zone`. A zone the runtime doesn't know reads as UTC, as 0.16 does. */
export function instantOf(value: string, zone: string | null | undefined): number | null {
  const wall = parseISO(wallClock(value));
  if (Number.isNaN(wall.getTime())) return null;
  const zoned = zone ? zonedWallTimeToUtc(wall, zone) : null;
  return zoned ? zoned.getTime() : wallClockFieldsAsUtc(wall);
}

/** An object's start and end as instants. A floating one is read in `zone`. A task without a start goes by its due. */
export function instantsOf(object: Record<string, unknown>, zone: string | null | undefined): { start: number | null; end: number | null } {
  const at = typeof object.start === 'string' ? object.start : typeof object.due === 'string' ? object.due : null;
  if (!at) return { start: null, end: null };
  const start = instantOf(at, typeof object.timeZone === 'string' ? object.timeZone : zone);
  if (start === null) return { start: null, end: null };
  const seconds = typeof object.duration === 'string' ? parseDurationSeconds(object.duration) : null;
  return { start, end: start + (seconds ?? 0) * 1000 };
}

function utcString(ms: number): string {
  return new Date(ms).toISOString().replace('.000Z', 'Z');
}

/**
 * An object as a CalendarEvent/get asked for it. utcStart and utcEnd are worked
 * out here, so they hold for the request's zone and for events edited offline.
 * A series keeps its overrides even when not asked for: the client's
 * synthetic-id mode reads occurrences without them, and it gets series from the
 * store, which it can only expand correctly with them.
 */
export function projectEvent(object: CalendarObject, properties: readonly string[] | null, zone: string | null | undefined): Record<string, unknown> {
  if (!properties) return { ...object };
  const out: Record<string, unknown> = { id: object.id };
  for (const name of properties) {
    if (name === 'utcStart' || name === 'utcEnd') continue;
    if (name in object) out[name] = object[name];
  }
  if (properties.includes('utcStart') || properties.includes('utcEnd')) {
    const { start, end } = typeof object.start === 'string' ? instantsOf(object, zone) : { start: null, end: null };
    if (start !== null && properties.includes('utcStart')) out.utcStart = utcString(start);
    if (end !== null && properties.includes('utcEnd')) out.utcEnd = utcString(end);
  }
  if (properties.includes('recurrenceRule') && object.recurrenceOverrides && isSeries(object)) {
    out.recurrenceOverrides = object.recurrenceOverrides;
  }
  return out;
}

export interface EventRow {
  jmap: string;
  id: string;
  json: string;
  server_json: string | null;
  hidden: number;
  gen: number;
}

export function eventRow(db: StorageAdapter, jmap: string, id: string): EventRow | undefined {
  return db.get<EventRow>('SELECT jmap, id, json, server_json, hidden, gen FROM calendar_event WHERE jmap = ? AND id = ?', [jmap, id]);
}

export function currentGen(db: StorageAdapter, jmap: string): number {
  return Number(db.get<{ gen: number | null }>('SELECT MAX(gen) AS gen FROM calendar_event WHERE jmap = ?', [jmap])?.gen ?? 0);
}

export interface EventWrite {
  /** What answers show. */
  shown: CalendarObject;
  /** The server's copy while a write is pending, otherwise null. */
  server?: CalendarObject | null;
  hidden?: boolean;
  gen: number;
}

export function writeEvent(db: StorageAdapter, jmap: string, write: EventWrite): void {
  const { shown } = write;
  const { start, end } = instantsOf(shown, 'UTC');
  const params: SqlValue[] = [
    jmap,
    shown.id,
    typeof shown.uid === 'string' ? shown.uid : null,
    isTaskLikeObject(shown) ? 1 : 0,
    isSeries(shown) ? 1 : 0,
    start,
    end,
    JSON.stringify(shown),
    write.server ? JSON.stringify(write.server) : null,
    write.hidden ? 1 : 0,
    write.gen,
  ];
  db.run(
    `INSERT INTO calendar_event (jmap, id, uid, is_task, is_series, start_ms, end_ms, json, server_json, hidden, gen)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (jmap, id) DO UPDATE SET uid = excluded.uid, is_task = excluded.is_task, is_series = excluded.is_series, start_ms = excluded.start_ms,
       end_ms = excluded.end_ms, json = excluded.json, server_json = excluded.server_json, hidden = excluded.hidden, gen = excluded.gen`,
    params,
  );
}

export function deleteEventRow(db: StorageAdapter, jmap: string, id: string): void {
  db.run('DELETE FROM calendar_event WHERE jmap = ? AND id = ?', [jmap, id]);
}
