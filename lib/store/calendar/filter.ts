/**
 * CalendarEvent/query filters, read the way Stalwart reads them: after and
 * before are LocalDateTimes in the request's time zone, and a series matches
 * when any occurrence is in the range. Text matches parts of words, where the
 * server only matches whole ones: offline search finds more, not less.
 */

import { addDays, format, parseISO } from 'date-fns';
import { isTaskLikeObject } from '@/lib/calendar-component-detection';
import { normalizeCalendarEventLike, parseDurationSeconds } from '@/lib/calendar-event-normalization';
import type { CalendarEvent, CalendarEventFilter } from '@/lib/jmap/types';
import { expandRecurringEvents } from '@/lib/recurrence-expansion';
import { MethodError } from '../area';
import { instantOf, instantsOf, isSeries, wallClock, type CalendarObject } from './records';

export interface RangeBounds {
  after?: string;
  before?: string;
}

/** The range of a filter, in the two shapes the client sends it: plain keys, or an AND of one-key conditions. */
export function boundsOf(filter: CalendarEventFilter): RangeBounds {
  if (filter.operator === 'AND') {
    const bounds: RangeBounds = {};
    for (const condition of filter.conditions ?? []) {
      if (condition.operator || Object.keys(condition).length !== 1) continue;
      if (condition.after) bounds.after = condition.after;
      if (condition.before) bounds.before = condition.before;
    }
    return bounds;
  }
  if (filter.operator) return {};
  return { after: filter.after, before: filter.before };
}

function fold(text: string): string {
  return text.normalize('NFKD').replace(/\p{M}/gu, '').toLowerCase();
}

function containsWords(haystack: Array<unknown>, needle: string): boolean {
  const text = fold(haystack.filter((part): part is string => typeof part === 'string').join('\n'));
  return fold(needle).split(/\s+/).filter(Boolean).every((word) => text.includes(word));
}

type Participant = {
  name?: string;
  email?: string;
  calendarAddress?: string;
  participationStatus?: string;
  roles?: Record<string, boolean>;
};

function participantsOf(object: CalendarObject): Participant[] {
  return Object.values((object.participants ?? {}) as Record<string, Participant>);
}

function placeTexts(object: CalendarObject): unknown[] {
  const places = Object.values((object.locations ?? {}) as Record<string, { name?: unknown; description?: unknown }>);
  const virtual = Object.values((object.virtualLocations ?? {}) as Record<string, { name?: unknown; description?: unknown }>);
  return [...places, ...virtual].flatMap((place) => [place.name, place.description]);
}

function personTexts(participant: Participant): unknown[] {
  return [participant.name, participant.email, participant.calendarAddress];
}

function isOwner(participant: Participant): boolean {
  return participant.roles?.owner === true;
}

function isAttendee(participant: Participant): boolean {
  return !participant.roles || participant.roles.attendee === true;
}

function ownerTexts(object: CalendarObject): unknown[] {
  return [object.organizerCalendarAddress, ...participantsOf(object).filter(isOwner).flatMap(personTexts)];
}

// An occurrence's wall clock is in the series' zone and the bounds in the
// request's: up to 26 hours apart. The client narrows the rest when it expands.
const SERIES_SLACK_DAYS = 2;
const OPEN_RANGE_DAYS = 5 * 366;

function seriesOccursIn(object: CalendarObject, after: string | undefined, before: string | undefined): boolean {
  const seriesStart = typeof object.start === 'string' ? parseISO(object.start) : null;
  if (!seriesStart || Number.isNaN(seriesStart.getTime())) return false;
  const lengthMs = (parseDurationSeconds(typeof object.duration === 'string' ? object.duration : undefined) ?? 0) * 1000;
  const from = after
    ? new Date(addDays(parseISO(wallClock(after)), -SERIES_SLACK_DAYS).getTime() - lengthMs)
    : seriesStart;
  const to = before ? addDays(parseISO(wallClock(before)), SERIES_SLACK_DAYS) : addDays(from, OPEN_RANGE_DAYS);
  if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime()) || from >= to) return false;
  const stamp = (date: Date) => format(date, "yyyy-MM-dd'T'HH:mm:ss");
  const event = normalizeCalendarEventLike(object as unknown as CalendarEvent);
  return expandRecurringEvents([event], stamp(from), stamp(to)).length > 0;
}

function inRange(object: CalendarObject, bounds: RangeBounds, zone: string): boolean {
  if (isSeries(object)) return seriesOccursIn(object, bounds.after, bounds.before);
  const { start, end } = instantsOf(object, zone);
  if (start === null || end === null) return false;
  const after = bounds.after ? instantOf(bounds.after, zone) : null;
  const before = bounds.before ? instantOf(bounds.before, zone) : null;
  if (before !== null && start >= before) return false;
  if (after === null) return true;
  return end > after || (end === start && start >= after);
}

function matchesCondition(object: CalendarObject, condition: CalendarEventFilter, zone: string): boolean {
  const bounds: RangeBounds = {};
  for (const [key, value] of Object.entries(condition)) {
    if (value === undefined) continue;
    switch (key) {
      case 'after':
      case 'before':
        bounds[key as 'after' | 'before'] = value as string;
        break;
      case 'inCalendar':
        if (!(object.calendarIds as Record<string, boolean> | undefined)?.[value as string]) return false;
        break;
      case 'inCalendars':
        if (!(value as string[]).some((id) => (object.calendarIds as Record<string, boolean> | undefined)?.[id])) return false;
        break;
      case 'uid':
        if (object.uid !== value) return false;
        break;
      case 'title':
        if (!containsWords([object.title], value as string)) return false;
        break;
      case 'description':
        if (!containsWords([object.description], value as string)) return false;
        break;
      case 'location':
        if (!containsWords(placeTexts(object), value as string)) return false;
        break;
      case 'owner':
        if (!containsWords(ownerTexts(object), value as string)) return false;
        break;
      case 'attendee': {
        // With participationStatus in the same condition: the same person.
        const status = condition.participationStatus;
        const found = participantsOf(object).some((person) => isAttendee(person)
          && containsWords(personTexts(person), value as string)
          && (!status || person.participationStatus === status));
        if (!found) return false;
        break;
      }
      case 'participationStatus':
        if (!participantsOf(object).some((person) => person.participationStatus === value)) return false;
        break;
      case 'text':
        if (!containsWords([
          object.title,
          object.description,
          ...placeTexts(object),
          ...ownerTexts(object),
          ...participantsOf(object).flatMap(personTexts),
        ], value as string)) return false;
        break;
      case 'types': {
        const type = isTaskLikeObject(object) ? 'task' : 'event';
        if (!(value as string[]).some((name) => name.toLowerCase() === type)) return false;
        break;
      }
      default:
        throw new MethodError('unsupportedFilter', `${key} isn't available offline`);
    }
  }
  return bounds.after || bounds.before ? inRange(object, bounds, zone) : true;
}

export function matchesFilter(object: CalendarObject, filter: CalendarEventFilter, zone: string): boolean {
  const conditions = filter.conditions ?? [];
  switch (filter.operator) {
    case 'AND': {
      // A range split over two conditions is one range: a series must have one
      // occurrence inside it, not one after the start and another before the end.
      const bounds = boundsOf(filter);
      const isBound = (c: CalendarEventFilter) => !c.operator && Object.keys(c).length === 1 && Boolean(c.after || c.before);
      if ((bounds.after || bounds.before) && !inRange(object, bounds, zone)) return false;
      return conditions.every((c) => isBound(c) || matchesFilter(object, c, zone));
    }
    case 'OR':
      return conditions.some((c) => matchesFilter(object, c, zone));
    case 'NOT':
      return !conditions.some((c) => matchesFilter(object, c, zone));
    case undefined:
      return matchesCondition(object, filter, zone);
    default:
      throw new MethodError('unsupportedFilter', `Unknown operator ${String(filter.operator)}`);
  }
}

export interface EventComparator {
  property?: string;
  isAscending?: boolean;
}

function sortValue(object: CalendarObject, property: string | undefined, zone: string): number | string {
  if (property === 'start') return instantsOf(object, zone).start ?? 0;
  const value = property ? object[property] : undefined;
  return typeof value === 'number' || typeof value === 'string' ? value : '';
}

/** By start when the request names no order. Ties go by id, so paging is stable. */
export function sortEvents(objects: CalendarObject[], sort: readonly EventComparator[], zone: string): CalendarObject[] {
  const levels = sort.length > 0 ? sort : [{ property: 'start', isAscending: true }];
  const keyed = objects.map((object) => ({ object, keys: levels.map((level) => sortValue(object, level.property, zone)) }));
  keyed.sort((a, b) => {
    for (let i = 0; i < levels.length; i += 1) {
      const x = a.keys[i];
      const y = b.keys[i];
      if (x === y) continue;
      const order = x < y ? -1 : 1;
      return levels[i].isAscending === false ? -order : order;
    }
    return a.object.id < b.object.id ? -1 : a.object.id > b.object.id ? 1 : 0;
  });
  return keyed.map((entry) => entry.object);
}
