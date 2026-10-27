// Step 47: the platform makes the user's "KI-Aufgaben" calendar on the server.
// Bulwark remembers which calendars are ticked, so a calendar it did not make
// itself stays unticked; this ticks it once the user set up a scheduled task.
import { BIRTHDAY_CALENDAR_ID } from "@/lib/birthday-calendar";
import { useCalendarStore } from "@/stores/calendar-store";

/** The selection with the calendar added; unchanged when nothing is chosen yet (then all show). */
export function withCalendar(selected: string[], calendarId: string): string[] {
  if (selected.includes(calendarId)) return selected;
  if (!selected.some((id) => id !== BIRTHDAY_CALENDAR_ID)) return selected;
  return [...selected, calendarId];
}

export function showCalendar(calendarId: string): void {
  useCalendarStore.setState((s) => {
    const next = withCalendar(s.selectedCalendarIds, calendarId);
    return next === s.selectedCalendarIds ? {} : { selectedCalendarIds: next };
  });
}
