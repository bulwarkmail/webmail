import type { CalendarEvent } from '@/lib/jmap/types';

/** Identity / whole-series keys that must never go into a single-occurrence override. */
export const RECURRENCE_OVERRIDE_IMMUTABLE_KEYS = [
  'id',
  'uid',
  '@type',
  'calendarIds',
  'recurrenceRules',
  'recurrenceOverrides',
  'excludedRecurrenceRules',
] as const;

/**
 * Build the "This event only" override patch for a recurring master.
 *
 * Why one pointer: a JMAP nested pointer can't create a missing intermediate,
 * so the override object has to be set whole at `recurrenceOverrides/<id>`, not
 * field-by-field (#774).
 */
export function buildRecurrenceOverridePatch(
  updates: Partial<CalendarEvent>,
  recurrenceId: string,
): Partial<CalendarEvent> {
  const immutable = new Set<string>(RECURRENCE_OVERRIDE_IMMUTABLE_KEYS);
  const override: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(updates)) {
    if (immutable.has(key)) continue;
    override[key] = value;
  }
  return { [`recurrenceOverrides/${recurrenceId}`]: override } as Partial<CalendarEvent>;
}
