import type { Calendar, CalendarEvent } from '@/lib/jmap/types';

export function hasCalendarRecurrence(event: Partial<CalendarEvent>): boolean {
  return Boolean(event.recurrenceId || event.recurrenceRules?.length
    || event.excludedRecurrenceRules?.length || Object.keys(event.recurrenceOverrides ?? {}).length);
}

export function isCrossAccountCalendarMove(event: CalendarEvent, calendar: Calendar): boolean {
  return event.localAccountId !== calendar.localAccountId || event.accountId !== calendar.accountId;
}

export function isUnsupportedCalendarMove(event: CalendarEvent, calendar: Calendar): boolean {
  return event.localAccountId !== calendar.localAccountId
    || (isCrossAccountCalendarMove(event, calendar) && hasCalendarRecurrence(event));
}

export class CalendarMoveError extends Error {
  constructor(readonly reason: 'unsupported' | 'incomplete', options?: ErrorOptions) {
    super(`Calendar move ${reason}`, options);
    this.name = 'CalendarMoveError';
  }
}
