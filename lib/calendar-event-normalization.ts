import { parseISO } from 'date-fns';
import type { CalendarEvent } from '@/lib/jmap/types';

const DURATION_RE = /^P(?:(\d+)W)?(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?$/;

function isDateOnlyValue(value: string): boolean {
  return /^\d{4}-\d{2}-\d{2}$/.test(value);
}

function isMidnightValue(value: string): boolean {
  if (isDateOnlyValue(value)) {
    return true;
  }

  const match = value.match(/T(\d{2}):(\d{2})(?::(\d{2})(?:\.\d+)?)?(?:Z|[+-]\d{2}:\d{2})?$/);
  if (!match) {
    return false;
  }

  return match[1] === '00' && match[2] === '00' && (match[3] ?? '00') === '00';
}

export function parseDurationSeconds(duration: string | undefined): number | null {
  if (!duration) {
    return null;
  }

  const match = DURATION_RE.exec(duration);
  if (!match) {
    return null;
  }

  const weeks = parseInt(match[1] || '0', 10);
  const days = parseInt(match[2] || '0', 10);
  const hours = parseInt(match[3] || '0', 10);
  const minutes = parseInt(match[4] || '0', 10);
  const seconds = parseInt(match[5] || '0', 10);

  return (((weeks * 7 + days) * 24 + hours) * 60 + minutes) * 60 + seconds;
}

/** A duration in whole minutes, 0 when there is none. */
export function parseDuration(duration: string | undefined): number {
  if (!duration) return 0;
  let totalMinutes = 0;
  const weekMatch = duration.match(/(\d+)W/);
  const hourMatch = duration.match(/(\d+)H/);
  const minMatch = duration.match(/(\d+)M/);
  const dayMatch = duration.match(/(\d+)D/);
  if (weekMatch) totalMinutes += parseInt(weekMatch[1]) * 7 * 24 * 60;
  if (dayMatch) totalMinutes += parseInt(dayMatch[1]) * 24 * 60;
  if (hourMatch) totalMinutes += parseInt(hourMatch[1]) * 60;
  if (minMatch) totalMinutes += parseInt(minMatch[1]);
  return totalMinutes;
}

export function normalizeAllDayDurationValue(duration: string | undefined): string | undefined {
  const totalSeconds = parseDurationSeconds(duration);
  if (totalSeconds === null || totalSeconds < 86400 || totalSeconds % 86400 !== 0) {
    return duration;
  }

  return `P${totalSeconds / 86400}D`;
}

export function isAllDayEventLike(event: Pick<Partial<CalendarEvent>, 'start' | 'duration' | 'showWithoutTime'>): boolean {
  if (event.showWithoutTime) {
    return true;
  }

  if (!event.start || !event.duration || !isMidnightValue(event.start)) {
    return false;
  }

  const totalSeconds = parseDurationSeconds(event.duration);
  if (totalSeconds === null || totalSeconds < 86400 || totalSeconds % 86400 !== 0) {
    return false;
  }

  const start = parseISO(event.start);
  if (Number.isNaN(start.getTime())) {
    return false;
  }

  const end = new Date(start.getTime() + totalSeconds * 1000);
  return end.getHours() === 0
    && end.getMinutes() === 0
    && end.getSeconds() === 0
    && end.getMilliseconds() === 0;
}

/**
 * Stalwart returns "recurrenceRule" (singular) instead of RFC 8984 "recurrenceRules" (plural).
 * Normalize server responses to match the client's internal type.
 */
function normalizeStalwartPropertyNames<T extends Partial<CalendarEvent>>(event: T): T {
  const raw = event as Record<string, unknown>;
  let patched = false;
  const updates: Partial<CalendarEvent> = {};

  if ('recurrenceRule' in raw && !('recurrenceRules' in raw)) {
    // JSCalendar 2.0 (jscalendarbis-15) defines recurrenceRule as a single object,
    // but Stalwart may also return it as an array (for JMAP-created events).
    // Normalize both forms to our internal array type.
    const val = raw.recurrenceRule;
    if (val != null && !Array.isArray(val) && typeof val === 'object') {
      updates.recurrenceRules = [val] as CalendarEvent['recurrenceRules'];
    } else {
      updates.recurrenceRules = val as CalendarEvent['recurrenceRules'];
    }
    patched = true;
  }
  if ('excludedRecurrenceRule' in raw && !('excludedRecurrenceRules' in raw)) {
    const val = raw.excludedRecurrenceRule;
    if (val != null && !Array.isArray(val) && typeof val === 'object') {
      updates.excludedRecurrenceRules = [val] as CalendarEvent['excludedRecurrenceRules'];
    } else {
      updates.excludedRecurrenceRules = val as CalendarEvent['excludedRecurrenceRules'];
    }
    patched = true;
  }

  if (!patched) return event;

  const result = { ...event, ...updates } as T;
  delete (result as Record<string, unknown>).recurrenceRule;
  delete (result as Record<string, unknown>).excludedRecurrenceRule;
  return result;
}

/**
 * A timed event without a duration lasts zero seconds (RFC 8984 default
 * PT0S). Stalwart drops a DTEND equal to DTSTART and then ends such an
 * event at 23:59:59 of its start day, so its utcEnd is wrong. Only server
 * objects carry utcStart, which keeps partial update patches untouched. (#837)
 */
function withZeroDurationEnd<T extends Partial<CalendarEvent>>(event: T): T {
  if (event.showWithoutTime || event.duration || !event.start || !event.utcStart) {
    return event;
  }
  return { ...event, duration: 'PT0S', utcEnd: event.utcStart } as T;
}

export function normalizeCalendarEventLike<T extends Partial<CalendarEvent>>(event: T): T {
  // First normalize Stalwart's singular property names to RFC 8984 plural forms
  const normalized = normalizeStalwartPropertyNames(event);

  if (!isAllDayEventLike(normalized)) {
    return withZeroDurationEnd(normalized);
  }

  return {
    ...normalized,
    showWithoutTime: true,
    duration: normalizeAllDayDurationValue(normalized.duration),
  } as T;
}

export function sanitizeOutgoingCalendarEventData<T extends Partial<CalendarEvent>>(event: T): T {
  const normalized = normalizeCalendarEventLike(event);
  if (!normalized.showWithoutTime) {
    return normalized;
  }

  const normalizedStart = normalized.start
    ? `${normalized.start.slice(0, 10)}T00:00:00`
    : normalized.start;

  return {
    ...normalized,
    start: normalizedStart,
    duration: normalizeAllDayDurationValue(normalized.duration),
    timeZone: null,
  } as T;
}