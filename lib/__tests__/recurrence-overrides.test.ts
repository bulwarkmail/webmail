import { describe, it, expect } from 'vitest';
import { buildRecurrenceOverridePatch } from '@/lib/recurrence-overrides';
import type { CalendarEvent } from '@/lib/jmap/types';

const RID = '2026-08-15T10:00:00';

describe('buildRecurrenceOverridePatch (#774 "This event only")', () => {
  it('sets the whole override at a single pointer, not nested per-field pointers', () => {
    const patch = buildRecurrenceOverridePatch(
      { title: 'Moved standup', start: '2026-08-15T11:00:00' } as Partial<CalendarEvent>,
      RID,
    );
    // Exactly one top-level pointer, at the override object itself.
    expect(Object.keys(patch)).toEqual([`recurrenceOverrides/${RID}`]);
    // No nested `recurrenceOverrides/<id>/<field>` pointers (the shape Stalwart
    // rejected because it can't create the missing override object).
    expect(Object.keys(patch).some((k) => k.startsWith(`recurrenceOverrides/${RID}/`))).toBe(false);
  });

  it('carries the per-occurrence fields into the override object', () => {
    const patch = buildRecurrenceOverridePatch(
      {
        title: 'Moved standup',
        start: '2026-08-15T11:00:00',
        duration: 'PT30M',
        description: 'one-off',
      } as Partial<CalendarEvent>,
      RID,
    );
    expect(patch[`recurrenceOverrides/${RID}` as keyof typeof patch]).toEqual({
      title: 'Moved standup',
      start: '2026-08-15T11:00:00',
      duration: 'PT30M',
      description: 'one-off',
    });
  });

  it('drops identity and series-level keys that must not vary per occurrence', () => {
    const patch = buildRecurrenceOverridePatch(
      {
        id: 'evt1',
        uid: 'uid-1',
        '@type': 'Event',
        calendarIds: { cal1: true },
        recurrenceRules: [{ '@type': 'RecurrenceRule', frequency: 'daily' }],
        recurrenceOverrides: {},
        excludedRecurrenceRules: [],
        title: 'Only this',
      } as unknown as Partial<CalendarEvent>,
      RID,
    );
    expect(patch[`recurrenceOverrides/${RID}` as keyof typeof patch]).toEqual({ title: 'Only this' });
  });

  it('produces an empty override object when nothing overridable is supplied', () => {
    const patch = buildRecurrenceOverridePatch({ id: 'evt1', uid: 'uid-1' } as unknown as Partial<CalendarEvent>, RID);
    expect(patch[`recurrenceOverrides/${RID}` as keyof typeof patch]).toEqual({});
  });
});
