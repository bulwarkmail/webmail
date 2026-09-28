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
