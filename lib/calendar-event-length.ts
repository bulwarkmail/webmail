/**
 * How long a new event lasts when nothing says otherwise: a click on a slot,
 * the quick editor, a new event in the full editor (#1318). The user picks it
 * in Settings > Calendar, in minutes.
 */
export const EVENT_LENGTHS = [15, 30, 45, 60, 90, 120] as const;
export type EventLength = typeof EVENT_LENGTHS[number];
export const DEFAULT_EVENT_LENGTH: EventLength = 60;

export function isEventLength(value: unknown): value is EventLength {
  return typeof value === 'number' && (EVENT_LENGTHS as readonly number[]).includes(value);
}

/** The length in milliseconds; the default length when `minutes` is no length the setting offers. */
export function eventLengthMs(minutes: unknown): number {
  return (isEventLength(minutes) ? minutes : DEFAULT_EVENT_LENGTH) * 60_000;
}

/** `start` (a display date) that much later on the clock. */
export function endAfterEventLength(start: Date, minutes: unknown): Date {
  const end = new Date(start);
  end.setMinutes(end.getMinutes() + eventLengthMs(minutes) / 60_000);
  return end;
}

/** The length as a JSCalendar duration ("PT30M", "PT1H30M"). */
export function eventLengthDuration(minutes: unknown): string {
  const length = isEventLength(minutes) ? minutes : DEFAULT_EVENT_LENGTH;
  const hours = Math.floor(length / 60);
  const rest = length % 60;
  return `PT${hours > 0 ? `${hours}H` : ''}${rest > 0 ? `${rest}M` : ''}`;
}
