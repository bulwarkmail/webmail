// Host side of api.calendar and api.tasks. Plugins read through the JMAP
// client (a read must not move the calendar the user is looking at) and
// write through the calendar and task stores, so the plugin hooks wired into
// those actions run and the open calendar shows the change.
//
// Plugins describe events in a small shape of their own (CalendarEventInput
// in plugin-types.ts); arbitrary JSCalendar objects are not accepted.

import { createRecurrenceRule } from '@/lib/recurrence-rule';
import type {
  CalendarEventInput, CalendarEventView, CalendarView, TaskInput, TaskView,
} from '../plugin-types';
import type {
  Calendar, CalendarEvent, CalendarEventAlert, CalendarLink, CalendarParticipant, CalendarRecurrenceRule,
  CalendarRelation, CalendarTask,
} from '../jmap/types';
import type { IJMAPClient } from '../jmap/client-interface';
import { useCalendarStore } from '@/stores/calendar-store';
import { useTaskStore } from '@/stores/task-store';
import { useIdentityStore } from '@/stores/identity-store';
import { eventToView, taskToView } from '../plugin-projection';
import { expandRecurringEvents } from '../recurrence-expansion';
import { buildParticipantMap } from '../calendar-participants';
import { parseDurationSeconds } from '../calendar-event-normalization';
import { parseAlertOffset, withOwnAlertIds } from '../calendar-alerts';
import { patchPath } from '../jmap/patch-object';
import { isValidEmail } from '../validation';
import { getEffectiveTimeZone } from '../timezone';
import { generateUUID } from '../utils';
import {
  isPlainRecord, readBoolean, readId, readInteger, readObject, readString, sessionClient,
} from './host-api-input';

/** Longest range calendar.getEvents covers in one call. */
export const MAX_PLUGIN_EVENT_RANGE_DAYS = 366;
/** Most events calendar.getEvents returns; the earliest ones win. */
export const MAX_PLUGIN_EVENTS = 1000;
/** Most tasks tasks.list returns. */
export const MAX_PLUGIN_TASKS = 1000;
const MAX_TITLE = 500;
const MAX_DESCRIPTION = 10_000;
const MAX_LOCATION = 500;
const MAX_PARTICIPANTS = 50;
const DAY_MS = 86_400_000;

// ─── Dates and times ──────────────────────────────────────────

interface WhenParts {
  /** YYYY-MM-DD */
  date: string;
  /** HH:MM:SS, or null for a date without a time. */
  time: string | null;
  /** True when the value ended in Z. */
  utc: boolean;
}

const WHEN_RE = /^(\d{4})-(\d{2})-(\d{2})(?:T(\d{2}):(\d{2})(?::(\d{2}))?(Z)?)?$/;

/**
 * `YYYY-MM-DD`, `YYYY-MM-DDTHH:MM[:SS]` (a wall-clock time) or the same
 * followed by `Z` (UTC). Offsets like `+02:00` are refused: pass a timeZone.
 */
function readWhen(value: unknown, method: string, field: string): WhenParts {
  if (typeof value !== 'string') throw new Error(`${method}: ${field} must be a date string`);
  const m = WHEN_RE.exec(value);
  if (!m) {
    throw new Error(`${method}: ${field} must look like 2026-05-01, 2026-05-01T09:30 or 2026-05-01T07:30:00Z`);
  }
  const [, y, mo, d, h, mi, s, z] = m;
  const check = new Date(Date.UTC(+y, +mo - 1, +d, h ? +h : 0, mi ? +mi : 0, s ? +s : 0));
  if (
    check.getUTCFullYear() !== +y || check.getUTCMonth() !== +mo - 1 || check.getUTCDate() !== +d ||
    (h !== undefined && (check.getUTCHours() !== +h || check.getUTCMinutes() !== +mi || check.getUTCSeconds() !== +(s ?? 0)))
  ) {
    throw new Error(`${method}: ${field} is not a real date or time`);
  }
  return {
    date: `${y}-${mo}-${d}`,
    time: h === undefined ? null : `${h}:${mi}:${s ?? '00'}`,
    utc: z === 'Z',
  };
}

/** Wall-clock milliseconds, for differences only (time zones don't matter). */
function wallMs(when: WhenParts): number {
  return Date.parse(`${when.date}T${when.time ?? '00:00:00'}Z`);
}

function readTimeZone(value: unknown, method: string): string {
  const zone = readString(value, method, 'timeZone', 64, { min: 1 });
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: zone });
  } catch {
    throw new Error(`${method}: timeZone "${zone}" is not a known time zone`);
  }
  return zone;
}

function readDurationSeconds(value: unknown, method: string): number {
  if (typeof value !== 'string') throw new Error(`${method}: duration must be an ISO 8601 duration such as PT1H`);
  const seconds = parseDurationSeconds(value);
  if (seconds === null || seconds <= 0) {
    throw new Error(`${method}: duration must be an ISO 8601 duration such as PT1H or P1D`);
  }
  return seconds;
}

function formatDuration(seconds: number): string {
  const days = Math.floor(seconds / 86_400);
  let rest = seconds % 86_400;
  const hours = Math.floor(rest / 3600);
  rest %= 3600;
  const minutes = Math.floor(rest / 60);
  const secs = rest % 60;
  const time = `${hours ? `${hours}H` : ''}${minutes ? `${minutes}M` : ''}${secs ? `${secs}S` : ''}`;
  return `P${days ? `${days}D` : ''}${time ? `T${time}` : ''}`;
}

interface Timing {
  start: string;
  duration: string;
  timeZone: string | null;
  showWithoutTime: boolean;
}

/** Turn the plugin's start/end/duration/timeZone/isAllDay into JSCalendar fields. */
function buildTiming(
  method: string,
  input: { start: unknown; end?: unknown; duration?: unknown; timeZone?: unknown; isAllDay?: unknown },
): Timing {
  const start = readWhen(input.start, method, 'start');
  const isAllDay = input.isAllDay === undefined ? start.time === null : readBoolean(input.isAllDay, method, 'isAllDay');
  if (input.end !== undefined && input.duration !== undefined) {
    throw new Error(`${method}: pass end or duration, not both`);
  }
  const maxSeconds = MAX_PLUGIN_EVENT_RANGE_DAYS * 86_400;

  if (isAllDay) {
    if (input.timeZone !== undefined && input.timeZone !== null) {
      throw new Error(`${method}: an all-day event has no timeZone`);
    }
    let days = 1;
    if (input.end !== undefined) {
      const end = readWhen(input.end, method, 'end');
      days = Math.round((Date.parse(`${end.date}T00:00:00Z`) - Date.parse(`${start.date}T00:00:00Z`)) / DAY_MS);
      if (days < 1) throw new Error(`${method}: end must be at least one day after start (end is exclusive)`);
    } else if (input.duration !== undefined) {
      const seconds = readDurationSeconds(input.duration, method);
      if (seconds % 86_400 !== 0) throw new Error(`${method}: an all-day event lasts whole days (P1D, P2D, ...)`);
      days = seconds / 86_400;
    }
    if (days * 86_400 > maxSeconds) throw new Error(`${method}: an event may last at most ${MAX_PLUGIN_EVENT_RANGE_DAYS} days`);
    return { start: `${start.date}T00:00:00`, duration: `P${days}D`, timeZone: null, showWithoutTime: true };
  }

  if (start.time === null) throw new Error(`${method}: start needs a time unless isAllDay is true`);
  let timeZone: string;
  if (start.utc) {
    if (input.timeZone !== undefined && input.timeZone !== null && input.timeZone !== 'Etc/UTC' && input.timeZone !== 'UTC') {
      throw new Error(`${method}: start is in UTC (ends in Z), so timeZone must be left out`);
    }
    timeZone = 'Etc/UTC';
  } else {
    timeZone = input.timeZone === undefined || input.timeZone === null
      ? getEffectiveTimeZone()
      : readTimeZone(input.timeZone, method);
  }

  let seconds = 3600;
  if (input.end !== undefined) {
    const end = readWhen(input.end, method, 'end');
    if (end.time === null || end.utc !== start.utc) {
      throw new Error(`${method}: end must be written like start (with a time${start.utc ? ', in UTC' : ''})`);
    }
    seconds = (wallMs(end) - wallMs(start)) / 1000;
    if (seconds <= 0) throw new Error(`${method}: end must be after start`);
  } else if (input.duration !== undefined) {
    seconds = readDurationSeconds(input.duration, method);
  }
  if (seconds > maxSeconds) throw new Error(`${method}: an event may last at most ${MAX_PLUGIN_EVENT_RANGE_DAYS} days`);
  return { start: `${start.date}T${start.time}`, duration: formatDuration(seconds), timeZone, showWithoutTime: false };
}

// ─── Calendars ────────────────────────────────────────────────

/** The store's calendars, loaded first when the calendar was never opened. */
async function ensureCalendars(client: IJMAPClient): Promise<Calendar[]> {
  if (useCalendarStore.getState().calendars.length === 0) {
    await useCalendarStore.getState().fetchCalendars(client);
  }
  return useCalendarStore.getState().calendars;
}

function calendarToView(calendar: Calendar): CalendarView {
  return {
    id: calendar.id,
    name: calendar.name,
    color: calendar.color || '',
    isVisible: calendar.isVisible !== false,
    isDefault: !!calendar.isDefault,
    isTasksOnly: !!calendar.isTasksOnly,
  };
}

async function pickCalendar(
  client: IJMAPClient,
  method: string,
  requested: unknown,
  forTasks: boolean,
): Promise<string> {
  const calendars = await ensureCalendars(client);
  if (requested !== undefined) {
    const id = readId(requested, method, 'calendarId');
    if (!calendars.some((c) => c.id === id)) throw new Error(`${method}: no calendar with id "${id}"`);
    return id;
  }
  const choice = forTasks
    ? calendars.find((c) => c.isTasksOnly) ?? calendars.find((c) => c.isDefault) ?? calendars[0]
    : calendars.find((c) => c.isDefault && !c.isTasksOnly) ?? calendars.find((c) => !c.isTasksOnly);
  if (!choice) throw new Error(`${method}: there is no calendar to put it in`);
  return choice.id;
}

export async function doCalendarListCalendars(): Promise<CalendarView[]> {
  const client = sessionClient('calendar.listCalendars');
  return (await ensureCalendars(client)).map(calendarToView);
}

// ─── Reading events ───────────────────────────────────────────

/** Bounds of an event query: wall clock without a zone, or UTC with Z. */
function rangeBound(when: WhenParts): string {
  return `${when.date}T${when.time ?? '00:00:00'}${when.utc ? 'Z' : ''}`;
}

export async function doCalendarGetEvents(options: unknown): Promise<CalendarEventView[]> {
  const method = 'calendar.getEvents';
  const opts = readObject(options, method, 'options', ['from', 'to', 'calendarIds']);
  const from = readWhen(opts.from, method, 'from');
  const to = readWhen(opts.to, method, 'to');
  if (from.utc !== to.utc) throw new Error(`${method}: from and to must both be in UTC or both without a zone`);
  const span = wallMs(to) - wallMs(from);
  if (span <= 0) throw new Error(`${method}: to must be after from`);
  if (span > MAX_PLUGIN_EVENT_RANGE_DAYS * DAY_MS) {
    throw new Error(`${method}: the range may cover at most ${MAX_PLUGIN_EVENT_RANGE_DAYS} days`);
  }
  let calendarIds: Set<string> | null = null;
  if (opts.calendarIds !== undefined) {
    if (!Array.isArray(opts.calendarIds) || opts.calendarIds.length > 100) {
      throw new Error(`${method}: calendarIds must be an array of at most 100 ids`);
    }
    calendarIds = new Set(opts.calendarIds.map((id, i) => readId(id, method, `calendarIds[${i}]`)));
  }

  const client = sessionClient(method);
  const start = rangeBound(from);
  const end = rangeBound(to);
  const raw = await client.queryAllCalendarEvents({ after: start, before: end });
  // Same clean-up as the calendar's own range fetch (calendar-store.ts).
  const valid = raw.filter((e) => typeof e.start === 'string' && e.start && !Number.isNaN(Date.parse(e.start)));
  const events = expandRecurringEvents(valid, start, end)
    .filter((e) => !calendarIds || Object.keys(e.calendarIds || {}).some((id) => e.calendarIds[id] && calendarIds.has(id)));
  const sortKey = (e: CalendarEvent) => e.utcStart ?? e.start;
  events.sort((a, b) => (sortKey(a) < sortKey(b) ? -1 : sortKey(a) > sortKey(b) ? 1 : 0));
  return events.slice(0, MAX_PLUGIN_EVENTS).map(eventToView);
}

/**
 * The event as the store addresses it. Events of shared calendars carry
 * `<accountId>:<id>` ids (see queryAllCalendarEvents), which is resolved
 * here the same way.
 */
async function loadEvent(client: IJMAPClient, id: string): Promise<CalendarEvent | null> {
  const inStore = useCalendarStore.getState().events.find((e) => e.id === id);
  if (inStore) return inStore;
  const own = await client.getCalendarEvent(id);
  if (own) return own;
  const colon = id.indexOf(':');
  if (colon <= 0) return null;
  const accountId = id.slice(0, colon);
  const rawId = id.slice(colon + 1);
  const shared = await client.getCalendarEvent(rawId, accountId);
  if (!shared) return null;
  return {
    ...shared,
    id,
    originalId: rawId,
    originalCalendarIds: shared.calendarIds,
    calendarIds: Object.fromEntries(
      Object.entries(shared.calendarIds || {}).map(([calId, v]) => [`${accountId}:${calId}`, v]),
    ),
    accountId,
    isShared: true,
  };
}

export async function doCalendarGetEvent(id: unknown): Promise<CalendarEventView | null> {
  const method = 'calendar.getEvent';
  const eventId = readId(id, method);
  const event = await loadEvent(sessionClient(method), eventId);
  return event ? eventToView(event) : null;
}

/**
 * Store mutations look the event up in the store's list to route it (shared
 * calendars, occurrences) and to tell hooks its title. An event outside the
 * range the calendar has loaded is added to that list first.
 */
async function eventForMutation(client: IJMAPClient, method: string, id: string): Promise<CalendarEvent> {
  const event = await loadEvent(client, id);
  if (!event) throw new Error(`${method}: no event with id "${id}"`);
  if (!useCalendarStore.getState().events.some((e) => e.id === id)) {
    useCalendarStore.setState((state) => ({ events: [...state.events, event] }));
  }
  return event;
}

// ─── Writing events ───────────────────────────────────────────

const EVENT_FIELDS = [
  'title', 'description', 'start', 'end', 'duration', 'timeZone', 'isAllDay', 'location', 'calendarId', 'participants', 'repeat',
] as const;
const CREATE_FIELDS = [...EVENT_FIELDS, 'uid'] as const;

const UID_RE = /^[A-Za-z0-9._:-]{1,128}$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const FREQUENCIES = ['daily', 'weekly', 'monthly', 'yearly'] as const;

/**
 * The uid an event a plugin created is stored under: the plugin's own uid in
 * its own namespace, so it can't collide with events from other apps and the
 * plugin finds its events again by uid (CalendarEventView.uid).
 */
export function pluginEventUid(pluginId: string, uid: string): string {
  return `${uid}@${pluginId}.plugin.bulwark`;
}

/** `repeat: { frequency, interval?, count?, until? }` → JSCalendar rules; null removes them. */
function recurrenceOf(value: unknown, method: string): CalendarEvent['recurrenceRules'] {
  if (value === null) return null;
  const r = readObject(value, method, 'repeat', ['frequency', 'interval', 'count', 'until']);
  if (!FREQUENCIES.includes(r.frequency as never)) throw new Error(`${method}: repeat.frequency must be one of ${FREQUENCIES.join(', ')}`);
  const overrides: Partial<CalendarRecurrenceRule> = {};
  if (r.interval !== undefined) {
    if (!Number.isInteger(r.interval) || (r.interval as number) < 1 || (r.interval as number) > 99) throw new Error(`${method}: repeat.interval must be 1-99`);
    overrides.interval = r.interval as number;
  }
  if (r.count !== undefined && r.until !== undefined) throw new Error(`${method}: give repeat.count or repeat.until, not both`);
  if (r.count !== undefined) {
    if (!Number.isInteger(r.count) || (r.count as number) < 1 || (r.count as number) > 1000) throw new Error(`${method}: repeat.count must be 1-1000`);
    overrides.count = r.count as number;
  }
  if (r.until !== undefined) {
    if (typeof r.until !== 'string' || !DATE_RE.test(r.until)) throw new Error(`${method}: repeat.until must be YYYY-MM-DD`);
    overrides.until = `${r.until}T23:59:59`;
  }
  return [createRecurrenceRule(r.frequency as CalendarRecurrenceRule['frequency'], overrides)];
}

function locationsOf(location: string): CalendarEvent['locations'] {
  if (!location) return null;
  return {
    loc1: {
      '@type': 'Location', name: location, description: null, locationTypes: null,
      coordinates: null, timeZone: null, links: null, relativeTo: null,
    },
  } as CalendarEvent['locations'];
}

/** Attendees as stored on the event, with the user as organizer. No invitations are sent. */
function participantsOf(value: unknown, method: string): Pick<CalendarEvent, 'participants' | 'organizerCalendarAddress'> {
  if (!Array.isArray(value)) throw new Error(`${method}: participants must be an array`);
  if (value.length > MAX_PARTICIPANTS) throw new Error(`${method}: at most ${MAX_PARTICIPANTS} participants are allowed`);
  const attendees = value.map((entry, i) => {
    const p = readObject(entry, method, `participants[${i}]`, ['email', 'name']);
    const email = readString(p.email, method, `participants[${i}].email`, 254, { min: 3, trim: true });
    if (!/^[^\s@<>]+@[^\s@<>]+$/.test(email)) throw new Error(`${method}: participants[${i}].email is not an address`);
    const name = p.name === undefined ? '' : readString(p.name, method, `participants[${i}].name`, 200, { trim: true });
    return { email, name };
  });
  if (attendees.length === 0) return { participants: null, organizerCalendarAddress: null };
  const { identities, preferredPrimaryId } = useIdentityStore.getState();
  const organizer = identities.find((i) => i.id === preferredPrimaryId) ?? identities[0];
  if (!organizer) throw new Error(`${method}: the account has no sender address to organise the event from`);
  return {
    participants: buildParticipantMap(
      { name: organizer.name || '', email: organizer.email },
      attendees,
    ) as Record<string, CalendarParticipant>,
    organizerCalendarAddress: `mailto:${organizer.email}`,
  };
}

/**
 * Create an event. Resolves to the new event, or null when it was not
 * created (another plugin's onBeforeEventCreate stopped it, or the server
 * refused it). Never sends invitations.
 */
export async function doCalendarCreateEvent(input: unknown, pluginId = 'unknown'): Promise<CalendarEventView | null> {
  const method = 'calendar.createEvent';
  const data = readObject(input, method, 'event', CREATE_FIELDS) as CalendarEventInput & Record<string, unknown>;
  const title = readString(data.title, method, 'title', MAX_TITLE, { min: 1, trim: true });
  const timing = buildTiming(method, data);
  const client = sessionClient(method);
  const calendarId = await pickCalendar(client, method, data.calendarId, false);

  let uid = generateUUID();
  if (data.uid !== undefined) {
    if (typeof data.uid !== 'string' || !UID_RE.test(data.uid)) throw new Error(`${method}: uid must be 1-128 letters, digits or . _ : -`);
    uid = pluginEventUid(pluginId, data.uid);
  }
  const event: Partial<CalendarEvent> = {
    uid,
    title,
    ...timing,
    calendarIds: { [calendarId]: true },
    status: 'confirmed',
    freeBusyStatus: 'busy',
    privacy: 'public',
  };
  if (data.description !== undefined) {
    const description = readString(data.description, method, 'description', MAX_DESCRIPTION, { trim: true });
    if (description) event.description = description;
  }
  if (data.location !== undefined) {
    const location = readString(data.location, method, 'location', MAX_LOCATION, { trim: true });
    if (location) event.locations = locationsOf(location);
  }
  if (data.participants !== undefined) {
    const p = participantsOf(data.participants, method);
    if (p.participants) Object.assign(event, p);
  }
  if (data.repeat !== undefined) event.recurrenceRules = recurrenceOf(data.repeat, method);

  const created = await useCalendarStore.getState().createEvent(client, event, false);
  return created ? eventToView(created) : null;
}

/**
 * Change an event. Only the fields in `patch` change; `start`, `end`,
 * `duration`, `timeZone` and `isAllDay` are worked out together against the
 * event's current times. Never sends updates to participants.
 */
export async function doCalendarUpdateEvent(id: unknown, patch: unknown): Promise<void> {
  const method = 'calendar.updateEvent';
  const eventId = readId(id, method);
  const data = readObject(patch, method, 'patch', EVENT_FIELDS);
  if (Object.keys(data).length === 0) throw new Error(`${method}: patch is empty`);
  const updates: Partial<CalendarEvent> = {};

  if (data.title !== undefined) updates.title = readString(data.title, method, 'title', MAX_TITLE, { min: 1, trim: true });
  if (data.description !== undefined) {
    updates.description = readString(data.description, method, 'description', MAX_DESCRIPTION, { trim: true });
  }
  if (data.location !== undefined) {
    updates.locations = locationsOf(readString(data.location, method, 'location', MAX_LOCATION, { trim: true }));
  }
  if (data.participants !== undefined) Object.assign(updates, participantsOf(data.participants, method));
  if (data.repeat !== undefined) updates.recurrenceRules = recurrenceOf(data.repeat, method);

  const client = sessionClient(method);
  if (data.calendarId !== undefined) {
    updates.calendarIds = { [await pickCalendar(client, method, data.calendarId, false)]: true };
  }
  const existing = await eventForMutation(client, method, eventId);

  const timeKeys = ['start', 'end', 'duration', 'timeZone', 'isAllDay'] as const;
  if (timeKeys.some((k) => data[k] !== undefined)) {
    const wasAllDay = !!existing.showWithoutTime;
    const isAllDay = data.isAllDay === undefined ? wasAllDay : data.isAllDay;
    const keepLength = data.end === undefined && data.duration === undefined && isAllDay === wasAllDay;
    Object.assign(updates, buildTiming(method, {
      start: data.start ?? (wasAllDay ? existing.start.slice(0, 10) : existing.start.slice(0, 19)),
      end: data.end,
      duration: keepLength ? existing.duration : data.duration,
      timeZone: data.timeZone !== undefined ? data.timeZone : (isAllDay ? undefined : existing.timeZone ?? undefined),
      isAllDay,
    }));
  }

  await useCalendarStore.getState().updateEvent(client, eventId, updates, false);
}

/** Delete an event (one occurrence when the id is an occurrence's). Never sends cancellations. */
export async function doCalendarDeleteEvent(id: unknown): Promise<void> {
  const method = 'calendar.deleteEvent';
  const eventId = readId(id, method);
  const client = sessionClient(method);
  await eventForMutation(client, method, eventId);
  await useCalendarStore.getState().deleteEvent(client, eventId, false);
}

// ─── Tasks ────────────────────────────────────────────────────

const TASK_FIELDS = [
  'title', 'description', 'due', 'priority', 'calendarId', 'alerts', 'links', 'relatedTo',
] as const;
/** Most alerts a plugin may give a task. */
export const MAX_PLUGIN_TASK_ALERTS = 5;
/** Most links a plugin may give a task. */
export const MAX_PLUGIN_TASK_LINKS = 10;
/** Most relations a plugin may give a task. */
export const MAX_PLUGIN_TASK_RELATIONS = 10;
const MAX_HREF = 2048;
const MAX_LINK_TITLE = 500;
const MAX_RELATED_UID = 998;
const MAX_RELATIONS_PER_UID = 4;
const MAX_ALERT_OFFSET_MS = MAX_PLUGIN_EVENT_RANGE_DAYS * DAY_MS;
/** Longest key a plugin may name to remove an entry it did not write. */
const MAX_REMOVED_KEY = 1024;

const MEMBER_ID_RE = /^[A-Za-z0-9._-]{1,64}$/;
const OFFSET_RE = /^-?P(?:\d+W|(?:\d+D)?(?:T(?:\d+H)?(?:\d+M)?(?:\d+S)?)?)$/;
const REL_RE = /^[a-z][a-z0-9.-]{0,63}$/;
const RELATION_RE = /^[a-z][a-z0-9-]{0,31}$/;
// Printable ASCII without spaces; a Message-ID keeps its angle brackets.
const RELATED_UID_RE = /^(?:<[!-;=?-~]+>|[!-;=?-~]+)$/;
const CONTROL_RE = /\p{Cc}/u;

/** The maps a plugin edits on a task, each keyed as JSCalendar keys it. */
const TASK_MAPS = ['alerts', 'links', 'relatedTo'] as const;
type TaskMap = typeof TASK_MAPS[number];

/**
 * A map change: `null` for the whole map (removes every entry), else the
 * entries named, each a value to set or null to remove. Entries not named
 * are left as they are.
 */
type MapChange<T> = null | [key: string, value: T | null][];

/** An instant in UTC, as JSCalendar's UTCDateTime (`2026-05-01T07:30:00Z`). */
function readInstant(value: unknown, method: string, field: string): string {
  const when = readWhen(value, method, field);
  if (!when.utc || when.time === null) throw new Error(`${method}: ${field} must be a time in UTC, like 2026-05-01T07:30:00Z`);
  return `${when.date}T${when.time}Z`;
}

function utcNow(): string {
  return new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');
}

/**
 * `{ key: value | null }` → its entries, each value read by `read`. A key
 * set must pass `keyOk`; a key removed (null) may be any key the task could
 * hold, so a plugin can remove entries another app wrote.
 */
function readMapChange<T>(
  value: unknown,
  method: string,
  field: string,
  max: number,
  keyOk: (key: string) => boolean,
  keyRule: string,
  read: (value: unknown, field: string) => T,
): MapChange<T> {
  if (value === null) return null;
  if (!isPlainRecord(value)) throw new Error(`${method}: ${field} must be an object keyed by id, or null`);
  const entries = Object.entries(value);
  if (entries.length > max) throw new Error(`${method}: ${field} may name at most ${max} entries`);
  return entries.map(([key, entry]) => {
    const where = `${field}["${key.slice(0, 64)}"]`;
    if (entry === null) {
      if (!key || key.length > MAX_REMOVED_KEY || CONTROL_RE.test(key)) throw new Error(`${method}: ${where} is not a key a task holds`);
      return [key, null];
    }
    if (!keyOk(key)) throw new Error(`${method}: ${field} key "${key.slice(0, 64)}" must be ${keyRule}`);
    return [key, read(entry, where)];
  });
}

function readTrigger(value: unknown, method: string, field: string): CalendarEventAlert['trigger'] {
  if (isPlainRecord(value) && Object.hasOwn(value, 'at')) {
    const t = readObject(value, method, field, ['at']);
    return { '@type': 'AbsoluteTrigger', when: readInstant(t.at, method, `${field}.at`) };
  }
  const t = readObject(value, method, field, ['offset', 'relativeTo']);
  if (typeof t.offset !== 'string' || !OFFSET_RE.test(t.offset) || !/\d/.test(t.offset) || t.offset.endsWith('T')) {
    throw new Error(`${method}: ${field}.offset must be an ISO 8601 duration such as -PT15M, or give ${field}.at`);
  }
  const ms = parseAlertOffset(t.offset);
  if (ms === null || Math.abs(ms) > MAX_ALERT_OFFSET_MS) {
    throw new Error(`${method}: ${field}.offset may be at most ${MAX_PLUGIN_EVENT_RANGE_DAYS} days`);
  }
  if (t.relativeTo !== undefined && t.relativeTo !== 'due' && t.relativeTo !== 'start') {
    throw new Error(`${method}: ${field}.relativeTo must be due or start`);
  }
  // JSCalendar names a task's due its "end".
  return { '@type': 'OffsetTrigger', offset: t.offset, relativeTo: t.relativeTo === 'start' ? 'start' : 'end' };
}

function alertsOf(value: unknown, method: string): MapChange<CalendarEventAlert> {
  return readMapChange(value, method, 'alerts', MAX_PLUGIN_TASK_ALERTS, (k) => MEMBER_ID_RE.test(k),
    '1-64 letters, digits or . _ -', (entry, field) => {
      const a = readObject(entry, method, field, ['trigger', 'action']);
      if (a.action !== undefined && a.action !== 'display' && a.action !== 'email') {
        throw new Error(`${method}: ${field}.action must be display or email`);
      }
      return {
        '@type': 'Alert',
        trigger: readTrigger(a.trigger, method, `${field}.trigger`),
        action: a.action === 'email' ? 'email' : 'display',
        acknowledged: null,
        relatedTo: null,
      };
    });
}

/** A link's target: http(s), a `mailto:` address, or a path of this Bulwark made a full URL. */
function readHref(value: unknown, method: string, field: string): string {
  const href = readString(value, method, field, MAX_HREF, { min: 1 });
  if (/[\s\p{Cc}\\]/u.test(href)) throw new Error(`${method}: ${field} must not contain spaces, control characters or backslashes`);
  if (href.startsWith('/') && !href.startsWith('//')) return new URL(href, window.location.origin).href;
  let url: URL;
  try {
    url = new URL(href);
  } catch {
    throw new Error(`${method}: ${field} must be an http(s) URL, a mailto: address or a path starting with /`);
  }
  if (url.protocol === 'mailto:') {
    let address: string;
    try {
      address = decodeURIComponent(url.pathname);
    } catch {
      address = '';
    }
    if (url.search || url.hash || !isValidEmail(address)) throw new Error(`${method}: ${field} must be mailto: and one address`);
    return href;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error(`${method}: ${field} must be an http(s) URL, a mailto: address or a path starting with /`);
  }
  if (url.username || url.password) throw new Error(`${method}: ${field} must not carry a user name or password`);
  return href;
}

function linksOf(value: unknown, method: string): MapChange<CalendarLink> {
  return readMapChange(value, method, 'links', MAX_PLUGIN_TASK_LINKS, (k) => MEMBER_ID_RE.test(k),
    '1-64 letters, digits or . _ -', (entry, field) => {
      const l = readObject(entry, method, field, ['href', 'rel', 'title']);
      if (l.rel !== undefined && (typeof l.rel !== 'string' || !REL_RE.test(l.rel))) {
        throw new Error(`${method}: ${field}.rel must be a lower-case link relation such as describedby`);
      }
      const title = l.title === undefined ? '' : readString(l.title, method, `${field}.title`, MAX_LINK_TITLE, { trim: true });
      return {
        '@type': 'Link',
        href: readHref(l.href, method, `${field}.href`),
        cid: null,
        contentType: null,
        size: null,
        rel: (l.rel as string | undefined) ?? null,
        display: null,
        title: title || null,
      };
    });
}

function relatedToOf(value: unknown, method: string): MapChange<CalendarRelation> {
  return readMapChange(value, method, 'relatedTo', MAX_PLUGIN_TASK_RELATIONS,
    (k) => k.length <= MAX_RELATED_UID && RELATED_UID_RE.test(k),
    `a Message-ID like <id@example.com> or a UID, at most ${MAX_RELATED_UID} printable characters without spaces`,
    (entry, field) => {
      const r = readObject(entry, method, field, ['relation']);
      let relation: Record<string, boolean> | null = null;
      if (r.relation !== undefined) {
        if (!Array.isArray(r.relation) || r.relation.length > MAX_RELATIONS_PER_UID) {
          throw new Error(`${method}: ${field}.relation must be an array of at most ${MAX_RELATIONS_PER_UID} relation types`);
        }
        r.relation.forEach((type, j) => {
          if (typeof type !== 'string' || !RELATION_RE.test(type)) {
            throw new Error(`${method}: ${field}.relation[${j}] must be a lower-case relation type such as parent`);
          }
        });
        if (r.relation.length) relation = Object.fromEntries((r.relation as string[]).map((type) => [type, true]));
      }
      return { '@type': 'Relation', relation };
    });
}

interface TaskMapChanges {
  alerts?: MapChange<CalendarEventAlert>;
  links?: MapChange<CalendarLink>;
  relatedTo?: MapChange<CalendarRelation>;
}

/** The plugin's map changes, read and checked before anything is asked of the server. */
function mapChangesOf(data: Record<string, unknown>, method: string): TaskMapChanges {
  const changes: TaskMapChanges = {};
  if (data.alerts !== undefined) changes.alerts = alertsOf(data.alerts, method);
  if (data.links !== undefined) changes.links = linksOf(data.links, method);
  if (data.relatedTo !== undefined) changes.relatedTo = relatedToOf(data.relatedTo, method);
  return changes;
}

/** The entries set, as a map (null when none), for a task that has none yet. */
function wholeMap<T>(change: MapChange<T>): Record<string, T> | null {
  const set = (change ?? []).filter((entry): entry is [string, T] => entry[1] !== null);
  return set.length ? Object.fromEntries(set) : null;
}

/** Map changes on a new task: the entries set. Alerts turn the calendar's defaults off. */
function createMaps(changes: TaskMapChanges): Partial<CalendarTask> {
  const task: Partial<CalendarTask> = {};
  for (const name of TASK_MAPS) {
    const change = changes[name];
    if (change !== undefined) Object.assign(task, { [name]: wholeMap(change as MapChange<unknown>) });
  }
  if (task.alerts) task.useDefaultAlerts = false;
  return task;
}

function sameAlert(a: CalendarEventAlert, b: CalendarEventAlert): boolean {
  const key = (t: CalendarEventAlert['trigger']) => t['@type'] === 'AbsoluteTrigger'
    ? `at ${Date.parse(t.when)}`
    : `offset ${parseAlertOffset(t.offset)} ${t.relativeTo === 'end' ? 'end' : 'start'}`;
  return a.action === b.action && key(a.trigger) === key(b.trigger);
}

function countAfter(held: object | null | undefined, change: [string, unknown][]): number {
  const keys = new Set(Object.keys(held ?? {}));
  for (const [key, value] of change) {
    if (value === null) keys.delete(key);
    else keys.add(key);
  }
  return keys.size;
}

/**
 * The patch for a task's maps: each entry named by its JMAP path, so entries
 * the plugin did not name, and members changed meanwhile elsewhere, stay as
 * the server holds them. A map the task does not have yet is written whole.
 * An alert set with the trigger and action it has keeps its `acknowledged`;
 * a new trigger (a snooze) makes it fire again.
 */
function updateMaps(method: string, task: CalendarTask, changes: TaskMapChanges): Record<string, unknown> {
  const patch: Record<string, unknown> = {};
  const limits: Record<TaskMap, number> = {
    alerts: MAX_PLUGIN_TASK_ALERTS,
    links: MAX_PLUGIN_TASK_LINKS,
    relatedTo: MAX_PLUGIN_TASK_RELATIONS,
  };
  for (const name of TASK_MAPS) {
    const change = changes[name] as MapChange<unknown> | undefined;
    if (change === undefined) continue;
    if (change === null) {
      patch[name] = null;
      // Else the calendar's defaults would still show and fire.
      if (name === 'alerts' && task.useDefaultAlerts) patch.useDefaultAlerts = false;
      continue;
    }
    const held = task[name] as Record<string, unknown> | null | undefined;
    const adds = change.some(([key, value]) => value !== null && !(held && Object.hasOwn(held, key)));
    if (adds && countAfter(held, change) > limits[name]) {
      throw new Error(`${method}: the task would hold more than ${limits[name]} ${name}`);
    }
    if (name === 'alerts' && task.useDefaultAlerts) {
      Object.assign(patch, ownAlerts(method, task, change as [string, CalendarEventAlert | null][]));
      continue;
    }
    if (!held || Object.keys(held).length === 0) {
      patch[name] = wholeMap(change);
      continue;
    }
    for (const [key, value] of change) {
      if (name === 'alerts' && value !== null && Object.hasOwn(held, key) && sameAlert(held[key] as CalendarEventAlert, value as CalendarEventAlert)) {
        continue;
      }
      patch[patchPath(name, key)] = value;
    }
  }
  return patch;
}

/**
 * Alerts of a task that uses its calendar's default alerts. Stalwart shows
 * the defaults in `alerts` under the defaults' ids and drops on save every
 * alert under one of those ids, so the defaults the plugin keeps become the
 * task's own under new ids (as the task form does), and an alert of the
 * plugin's under a default's id is refused rather than lost.
 */
function ownAlerts(
  method: string,
  task: CalendarTask,
  change: [string, CalendarEventAlert | null][],
): Partial<CalendarTask> {
  const defaults = task.alerts ?? {};
  const removed = new Set<string>();
  const set: [string, CalendarEventAlert][] = [];
  for (const [key, value] of change) {
    if (value === null) removed.add(key);
    else if (Object.hasOwn(defaults, key)) {
      throw new Error(`${method}: alert "${key}" is one of the calendar's default alerts the task uses (useDefaultAlerts); give yours another id`);
    } else set.push([key, value]);
  }
  const kept = Object.entries(defaults).filter(([key]) => !removed.has(key)).map(([, alert]) => alert);
  const alerts = { ...withOwnAlertIds(kept, [...Object.keys(defaults), ...set.map(([key]) => key)]), ...Object.fromEntries(set) };
  return { useDefaultAlerts: false, alerts: Object.keys(alerts).length ? alerts : null };
}

function isDone(task: CalendarTask): boolean {
  return task.progress === 'completed' || task.progress === 'cancelled';
}

export async function doTasksList(options: unknown): Promise<TaskView[]> {
  const method = 'tasks.list';
  const opts = readObject(options, method, 'options', ['includeCompleted'], true);
  const includeCompleted = opts.includeCompleted === undefined
    ? false
    : readBoolean(opts.includeCompleted, method, 'includeCompleted');
  const tasks = await sessionClient(method).getCalendarTasks();
  return tasks
    .filter((t) => includeCompleted || !isDone(t))
    .slice(0, MAX_PLUGIN_TASKS)
    .map(taskToView);
}

// A plugin's writes to one task, one after another: Stalwart refuses a
// CalendarEvent/set while another is under way on the same object, and each
// write is worked out against the task as the one before left it.
const taskWrites = new Map<string, Promise<unknown>>();

function oneAtATime<T>(taskId: string, write: () => Promise<T>): Promise<T> {
  const before = taskWrites.get(taskId) ?? Promise.resolve();
  const next = before.catch(() => undefined).then(write);
  const settled = next.catch(() => undefined);
  taskWrites.set(taskId, settled);
  void settled.then(() => {
    if (taskWrites.get(taskId) === settled) taskWrites.delete(taskId);
  });
  return next;
}

async function loadTask(client: IJMAPClient, id: string): Promise<CalendarTask | null> {
  const inStore = useTaskStore.getState().tasks.find((t) => t.id === id);
  if (inStore) return inStore;
  return (await client.getCalendarTasks()).find((t) => t.id === id) ?? null;
}

async function requireTask(client: IJMAPClient, method: string, id: string): Promise<CalendarTask> {
  const task = await loadTask(client, id);
  if (!task) throw new Error(`${method}: no task with id "${id}"`);
  return task;
}

/**
 * The task with its alerts, links and relations as the server
 * holds them now: the store's copy may be older, and a map the task seems
 * not to have is written whole, which would drop what the server gained.
 */
async function withServerMaps(client: IJMAPClient, task: CalendarTask): Promise<CalendarTask> {
  const server = await client.getCalendarEvent(task.originalId ?? task.id, task.accountId);
  if (!server) return task;
  return {
    ...task,
    alerts: server.alerts ?? null,
    links: server.links ?? null,
    relatedTo: server.relatedTo ?? null,
    useDefaultAlerts: server.useDefaultAlerts,
  };
}

export async function doTasksGet(id: unknown): Promise<TaskView | null> {
  const method = 'tasks.get';
  const task = await loadTask(sessionClient(method), readId(id, method));
  return task ? taskToView(task) : null;
}

/** `due` as a task stores it: a date (no time) or a wall-clock time. */
function dueOf(value: unknown, method: string): Pick<CalendarTask, 'due' | 'showWithoutTime'> {
  if (value === null) return { due: null, showWithoutTime: true };
  const when = readWhen(value, method, 'due');
  if (when.utc) throw new Error(`${method}: due is a local date or time, without Z`);
  return when.time === null
    ? { due: when.date, showWithoutTime: true }
    : { due: `${when.date}T${when.time}`, showWithoutTime: false };
}

/** Resolves to the new task, or null when another plugin's onBeforeTaskCreate stopped it. */
export async function doTasksCreate(input: unknown): Promise<TaskView | null> {
  const method = 'tasks.create';
  const data = readObject(input, method, 'task', TASK_FIELDS) as TaskInput & Record<string, unknown>;
  const client = sessionClient(method);
  const task: Partial<CalendarTask> = {
    '@type': 'Task',
    title: readString(data.title, method, 'title', MAX_TITLE, { min: 1, trim: true }),
    description: data.description === undefined
      ? ''
      : readString(data.description, method, 'description', MAX_DESCRIPTION, { trim: true }),
    ...(data.due === undefined ? { due: null, showWithoutTime: true } : dueOf(data.due, method)),
    priority: data.priority === undefined ? 0 : readInteger(data.priority, method, 'priority', 0, 9),
    progress: 'needs-action',
    ...createMaps(mapChangesOf(data, method)),
    calendarIds: { [await pickCalendar(client, method, data.calendarId, true)]: true },
  };
  const created = await useTaskStore.getState().createTask(client, task);
  return created ? taskToView(created) : null;
}

export async function doTasksUpdate(id: unknown, patch: unknown): Promise<void> {
  const method = 'tasks.update';
  const taskId = readId(id, method);
  const data = readObject(patch, method, 'patch', TASK_FIELDS);
  if (Object.keys(data).length === 0) throw new Error(`${method}: patch is empty`);
  const updates: Partial<CalendarTask> = {};
  if (data.title !== undefined) updates.title = readString(data.title, method, 'title', MAX_TITLE, { min: 1, trim: true });
  if (data.description !== undefined) {
    updates.description = readString(data.description, method, 'description', MAX_DESCRIPTION, { trim: true });
  }
  if (data.due !== undefined) Object.assign(updates, dueOf(data.due, method));
  if (data.priority !== undefined) updates.priority = readInteger(data.priority, method, 'priority', 0, 9);
  const client = sessionClient(method);
  if (data.calendarId !== undefined) {
    updates.calendarIds = { [await pickCalendar(client, method, data.calendarId, true)]: true };
  }
  const maps = mapChangesOf(data, method);
  await oneAtATime(taskId, async () => {
    let task = await requireTask(client, method, taskId);
    if (Object.keys(maps).length) task = await withServerMaps(client, task);
    Object.assign(updates, updateMaps(method, task, maps));
    if (Object.keys(updates).length === 0) return;
    await useTaskStore.getState().updateTask(client, taskId, updates, task);
  });
}

/**
 * Mark one of a task's alerts dismissed at `when` (UTC; now when left out),
 * or not dismissed with null. Only that alert's `acknowledged` is written.
 */
export async function doTasksAcknowledgeAlert(id: unknown, alertId: unknown, when: unknown): Promise<void> {
  const method = 'tasks.acknowledgeAlert';
  const taskId = readId(id, method);
  const key = readId(alertId, method, 'alertId');
  const acknowledged = when === undefined ? utcNow() : when === null ? null : readInstant(when, method, 'when');
  const client = sessionClient(method);
  await oneAtATime(taskId, async () => {
    const task = await withServerMaps(client, await requireTask(client, method, taskId));
    const alert = task.alerts && Object.hasOwn(task.alerts, key) ? task.alerts[key] : null;
    if (!alert) throw new Error(`${method}: the task has no alert "${key}"`);
    if (task.useDefaultAlerts) {
      throw new Error(`${method}: the task uses its calendar's default alerts (useDefaultAlerts); make them its own with tasks.update(id, { alerts: {} }) first`);
    }
    if ((alert.acknowledged ?? null) === acknowledged) return;
    const patch = { [patchPath('alerts', key, 'acknowledged')]: acknowledged } as Partial<CalendarTask>;
    await useTaskStore.getState().updateTask(client, taskId, patch, task);
  });
}

export async function doTasksSetComplete(id: unknown, complete: unknown): Promise<void> {
  const method = 'tasks.setComplete';
  const taskId = readId(id, method);
  const done = readBoolean(complete, method, 'complete');
  const client = sessionClient(method);
  await oneAtATime(taskId, async () => {
    const task = await requireTask(client, method, taskId);
    if ((task.progress === 'completed') === done) return;
    await useTaskStore.getState().toggleTaskComplete(client, task);
  });
}

export async function doTasksDelete(id: unknown): Promise<void> {
  const method = 'tasks.delete';
  const taskId = readId(id, method);
  const client = sessionClient(method);
  await requireTask(client, method, taskId);
  await useTaskStore.getState().deleteTask(client, taskId);
}
