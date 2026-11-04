/**
 * Where an event was grabbed when its drag started (pim-p3-2). A drag over the time grid
 * moves the event by how far the pointer went from here, as Google Calendar and Outlook do,
 * not to the pointer's slot. `dragover` can't read the drag's data, so the card leaves this
 * here at dragstart and takes it away at dragend. One drag at a time, in this page only.
 */

export interface EventDragGrab {
  eventId: string;
  /** The day column it was grabbed in (`yyyy-MM-dd`), and the pointer's offset from that column's top. */
  dayKey: string;
  columnY: number;
}

let current: EventDragGrab | null = null;

/** The column the time grid marks with `data-time-column`, or nothing outside the time grid. */
export function startEventDragGrab(eventId: string, target: Element, clientY: number): void {
  const column = target.closest<HTMLElement>('[data-time-column]');
  const dayKey = column?.dataset.timeColumn;
  current = column && dayKey ? { eventId, dayKey, columnY: clientY - column.getBoundingClientRect().top } : null;
}

export function eventDragGrab(eventId?: string): EventDragGrab | null {
  if (!current || (eventId !== undefined && current.eventId !== eventId)) return null;
  return current;
}

export function endEventDragGrab(): void {
  current = null;
}
