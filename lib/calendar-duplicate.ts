import { addDays, format, parseISO } from "date-fns";
import type { CalendarEvent } from "@/lib/jmap/types";
import { sanitizeOutgoingCalendarEventData } from "@/lib/calendar-event-normalization";
import { generateUUID } from "@/lib/utils";

/**
 * Create payload for a copy of `event` one day later. Shared by the editor,
 * the detail popover and the context menu - each used to build its own copy
 * and two of them dropped the meeting link (`virtualLocations`, #1170).
 * The start stays in the event's own wall clock and time zone.
 */
export function buildDuplicateEventData(event: CalendarEvent): Partial<CalendarEvent> {
  const newStart = addDays(parseISO(event.start), 1);
  const data: Partial<CalendarEvent> = {
    uid: generateUUID(),
    title: event.title,
    description: event.description,
    start: format(newStart, "yyyy-MM-dd'T'HH:mm:ss"),
    duration: event.duration,
    timeZone: event.timeZone,
    showWithoutTime: event.showWithoutTime,
    calendarIds: { ...event.calendarIds },
    status: "confirmed",
    freeBusyStatus: event.freeBusyStatus,
    privacy: event.privacy,
  };
  if (event.locations) data.locations = structuredClone(event.locations);
  if (event.virtualLocations) data.virtualLocations = structuredClone(event.virtualLocations);
  if (event.recurrenceRules) data.recurrenceRules = structuredClone(event.recurrenceRules);
  if (event.alerts) data.alerts = structuredClone(event.alerts);
  if (event.participants) data.participants = structuredClone(event.participants);
  return sanitizeOutgoingCalendarEventData(data);
}
