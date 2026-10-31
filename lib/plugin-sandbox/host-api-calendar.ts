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
import type { Calendar, CalendarEvent, CalendarParticipant, CalendarRecurrenceRule, CalendarTask, ContactCard } from '../jmap/types';
import type { IJMAPClient } from '../jmap/client-interface';
import { useCalendarStore } from '@/stores/calendar-store';
import { useTaskStore } from '@/stores/task-store';
import { useIdentityStore } from '@/stores/identity-store';
import { useSettingsStore } from '@/stores/settings-store';
import { useContactStore } from '@/stores/contact-store';
import {
  BIRTHDAY_CALENDAR_ID,
  createBirthdayCalendar,
  generateBirthdayEvents,
} from '@/lib/birthday-calendar';
import { getEffectiveLocale } from '@/i18n/detect-locale';
import { messagesFor } from './host-api-app';
import { eventToView, taskToView } from '../plugin-projection';
import { expandRecurringEvents } from '../recurrence-expansion';
import { buildParticipantMap } from '../calendar-participants';
import { parseDurationSeconds } from '../calendar-event-normalization';
import { getEffectiveTimeZone } from '../timezone';
import { generateUUID } from '../utils';
import {
  readBoolean, readId, readInteger, readObject, readString, sessionClient,
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

async function birthdayCalendarName(): Promise<string> {
  try {
    const locale = getEffectiveLocale();
    const msgs = await messagesFor(locale);
    if (typeof msgs?.birthday_calendar === 'string') return msgs.birthday_calendar;
  } catch {
    // fallback
  }
  return 'Birthdays';
}

async function ensureContacts(client: IJMAPClient): Promise<ContactCard[]> {
  const store = useContactStore.getState();
  if (!store.contactsLoaded && store.contacts.length === 0 && client?.supportsContacts?.()) {
    try {
      await store.fetchContacts(client);
    } catch {
      // Ignore network errors; proceed with current contacts
    }
  }
  return useContactStore.getState().contacts;
}

export async function doCalendarListCalendars(): Promise<CalendarView[]> {
  const client = sessionClient('calendar.listCalendars');
  const calendars = (await ensureCalendars(client)).map(calendarToView);
  const settings = useSettingsStore.getState();
  if (settings.showBirthdayCalendar) {
    const name = await birthdayCalendarName();
    calendars.push(calendarToView(createBirthdayCalendar(name, settings.birthdayCalendarColor)));
  }
  return calendars;
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

  const { showBirthdayCalendar } = useSettingsStore.getState();
  if (showBirthdayCalendar && (!calendarIds || calendarIds.has(BIRTHDAY_CALENDAR_ID))) {
    const contacts = await ensureContacts(client);
    const bStart = `${from.date}T00:00:00${from.utc ? 'Z' : ''}`;
    const bEnd = `${to.date}T23:59:59${to.utc ? 'Z' : ''}`;
    const birthdays = generateBirthdayEvents(contacts, bStart, bEnd);
    events.push(...birthdays);
  }

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
  if (eventId.startsWith('birthday-')) {
    const { showBirthdayCalendar } = useSettingsStore.getState();
    if (!showBirthdayCalendar) return null;
    const client = sessionClient(method);
    const contacts = await ensureContacts(client);
    const match = eventId.match(/^birthday-(.+)-(\d{4})$/);
    const year = match ? parseInt(match[2], 10) : new Date().getFullYear();
    const birthdays = generateBirthdayEvents(contacts, `${year}-01-01T00:00:00`, `${year}-12-31T23:59:59`);
    const found = birthdays.find((b) => b.id === eventId);
    return found ? eventToView(found) : null;
  }
  const event = await loadEvent(sessionClient(method), eventId);
  return event ? eventToView(event) : null;
}

/**
 * Store mutations look the event up in the store's list to route it (shared
 * calendars, occurrences) and to tell hooks its title. An event outside the
 * range the calendar has loaded is added to that list first.
 */
async function eventForMutation(client: IJMAPClient, method: string, id: string): Promise<CalendarEvent> {
  if (id.startsWith('birthday-')) {
    throw new Error(`${method}: birthday events cannot be modified`);
  }
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

const TASK_FIELDS = ['title', 'description', 'due', 'priority', 'calendarId'] as const;

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
  await requireTask(client, method, taskId);
  await useTaskStore.getState().updateTask(client, taskId, updates);
}

export async function doTasksSetComplete(id: unknown, complete: unknown): Promise<void> {
  const method = 'tasks.setComplete';
  const taskId = readId(id, method);
  const done = readBoolean(complete, method, 'complete');
  const client = sessionClient(method);
  const task = await requireTask(client, method, taskId);
  if ((task.progress === 'completed') === done) return;
  await useTaskStore.getState().toggleTaskComplete(client, task);
}

export async function doTasksDelete(id: unknown): Promise<void> {
  const method = 'tasks.delete';
  const taskId = readId(id, method);
  const client = sessionClient(method);
  await requireTask(client, method, taskId);
  await useTaskStore.getState().deleteTask(client, taskId);
}
