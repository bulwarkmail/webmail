import { describe, it, expect } from 'vitest';
import { expandRecurringEvents } from '../recurrence-expansion';
import type { CalendarEvent, CalendarRecurrenceRule } from '@/lib/jmap/types';

/**
 * Helper: builds a recurrence-rule fixture from only the fields a test cares
 * about. Cast-only (no defaults injected) so the expansion logic sees exactly
 * the same partial rule the tests previously passed via `as any`.
 */
function rule(partial: Partial<CalendarRecurrenceRule>): CalendarRecurrenceRule {
  return partial as CalendarRecurrenceRule;
}

/** Helper: create a minimal CalendarEvent for testing recurrence */
function makeEvent(overrides: Partial<CalendarEvent> = {}): CalendarEvent {
  return {
    id: 'evt1',
    uid: 'uid1',
    calendarIds: { cal1: true },
    start: '2025-01-06T09:00:00', // Monday
    duration: 'PT1H',
    title: 'Test Event',
    showWithoutTime: false,
    recurrenceRules: null,
    recurrenceOverrides: null,
    excludedRecurrenceRules: null,
    ...overrides,
  } as CalendarEvent;
}

function expand(event: CalendarEvent, rangeStart: string, rangeEnd: string) {
  return expandRecurringEvents([event], rangeStart, rangeEnd);
}

function starts(events: CalendarEvent[]) {
  return events.map(e => e.start);
}

describe('expandRecurringEvents', () => {
  it('passes through non-recurring events unchanged', () => {
    const event = makeEvent();
    const result = expand(event, '2025-01-01T00:00:00', '2025-02-01T00:00:00');
    expect(result).toHaveLength(1);
    expect(result[0].id).toBe('evt1');
  });

  // -----------------------------------------------------------------------
  // Daily
  // -----------------------------------------------------------------------
  describe('daily frequency', () => {
    it('expands daily events within range', () => {
      const event = makeEvent({
        recurrenceRules: [rule({ '@type': 'RecurrenceRule', frequency: 'daily' })],
      });
      const result = expand(event, '2025-01-06T00:00:00', '2025-01-09T00:00:00');
      expect(starts(result)).toEqual([
        '2025-01-06T09:00:00',
        '2025-01-07T09:00:00',
        '2025-01-08T09:00:00',
      ]);
    });

    it('respects interval', () => {
      const event = makeEvent({
        recurrenceRules: [rule({ '@type': 'RecurrenceRule', frequency: 'daily', interval: 2 })],
      });
      const result = expand(event, '2025-01-06T00:00:00', '2025-01-12T00:00:00');
      expect(starts(result)).toEqual([
        '2025-01-06T09:00:00',
        '2025-01-08T09:00:00',
        '2025-01-10T09:00:00',
      ]);
    });

    it('respects count', () => {
      const event = makeEvent({
        recurrenceRules: [rule({ '@type': 'RecurrenceRule', frequency: 'daily', count: 3 })],
      });
      const result = expand(event, '2025-01-06T00:00:00', '2025-12-31T00:00:00');
      expect(result).toHaveLength(3);
    });

    it('respects until', () => {
      const event = makeEvent({
        recurrenceRules: [rule({ '@type': 'RecurrenceRule', frequency: 'daily', until: '2025-01-08T09:00:00' })],
      });
      const result = expand(event, '2025-01-06T00:00:00', '2025-12-31T00:00:00');
      expect(result).toHaveLength(3);
    });
  });

  // -----------------------------------------------------------------------
  // Weekly
  // -----------------------------------------------------------------------
  describe('weekly frequency', () => {
    it('expands weekly with implicit byDay (same weekday as start)', () => {
      const event = makeEvent({
        recurrenceRules: [rule({ '@type': 'RecurrenceRule', frequency: 'weekly' })],
      });
      // Jan 6 is Monday, so every Monday
      const result = expand(event, '2025-01-06T00:00:00', '2025-01-28T00:00:00');
      expect(starts(result)).toEqual([
        '2025-01-06T09:00:00',
        '2025-01-13T09:00:00',
        '2025-01-20T09:00:00',
        '2025-01-27T09:00:00',
      ]);
    });

    it('expands weekly with explicit byDay (MWF)', () => {
      const event = makeEvent({
        recurrenceRules: [rule({
          '@type': 'RecurrenceRule',
          frequency: 'weekly',
          byDay: [{ day: 'mo' }, { day: 'we' }, { day: 'fr' }],
        })],
      });
      const result = expand(event, '2025-01-06T00:00:00', '2025-01-13T00:00:00');
      expect(starts(result)).toEqual([
        '2025-01-06T09:00:00',
        '2025-01-08T09:00:00',
        '2025-01-10T09:00:00',
      ]);
    });

    it('expands weekly with interval=2', () => {
      const event = makeEvent({
        recurrenceRules: [rule({
          '@type': 'RecurrenceRule',
          frequency: 'weekly',
          interval: 2,
          byDay: [{ day: 'mo' }],
        })],
      });
      const result = expand(event, '2025-01-06T00:00:00', '2025-02-03T00:00:00');
      expect(starts(result)).toEqual([
        '2025-01-06T09:00:00',
        '2025-01-20T09:00:00',
      ]);
    });
  });

  // -----------------------------------------------------------------------
  // Monthly
  // -----------------------------------------------------------------------
  describe('monthly frequency', () => {
    it('expands monthly with implicit byMonthDay', () => {
      const event = makeEvent({
        start: '2025-01-15T10:00:00',
        recurrenceRules: [rule({ '@type': 'RecurrenceRule', frequency: 'monthly' })],
      });
      const result = expand(event, '2025-01-01T00:00:00', '2025-04-01T00:00:00');
      expect(starts(result)).toEqual([
        '2025-01-15T10:00:00',
        '2025-02-15T10:00:00',
        '2025-03-15T10:00:00',
      ]);
    });

    it('expands monthly with byMonthDay', () => {
      const event = makeEvent({
        start: '2025-01-01T08:00:00',
        recurrenceRules: [rule({
          '@type': 'RecurrenceRule',
          frequency: 'monthly',
          byMonthDay: [1, 15],
        })],
      });
      const result = expand(event, '2025-01-01T00:00:00', '2025-02-28T00:00:00');
      expect(starts(result)).toEqual([
        '2025-01-01T08:00:00',
        '2025-01-15T08:00:00',
        '2025-02-01T08:00:00',
        '2025-02-15T08:00:00',
      ]);
    });

    it('expands monthly with negative byMonthDay (-1 = last day)', () => {
      const event = makeEvent({
        start: '2025-01-31T08:00:00',
        recurrenceRules: [rule({
          '@type': 'RecurrenceRule',
          frequency: 'monthly',
          byMonthDay: [-1],
        })],
      });
      const result = expand(event, '2025-01-01T00:00:00', '2025-04-01T00:00:00');
      const days = result.map(e => e.start.substring(0, 10));
      expect(days).toEqual(['2025-01-31', '2025-02-28', '2025-03-31']);
    });

    it('expands monthly with byDay + nthOfPeriod (2nd Tuesday)', () => {
      const event = makeEvent({
        start: '2025-01-14T09:00:00', // 2nd Tuesday
        recurrenceRules: [rule({
          '@type': 'RecurrenceRule',
          frequency: 'monthly',
          byDay: [{ day: 'tu', nthOfPeriod: 2 }],
        })],
      });
      const result = expand(event, '2025-01-01T00:00:00', '2025-04-01T00:00:00');
      const days = result.map(e => e.start.substring(0, 10));
      expect(days).toEqual(['2025-01-14', '2025-02-11', '2025-03-11']);
    });

    it('expands monthly with byDay nthOfPeriod=-1 (last Friday)', () => {
      const event = makeEvent({
        start: '2025-01-31T09:00:00', // last Friday of Jan
        recurrenceRules: [rule({
          '@type': 'RecurrenceRule',
          frequency: 'monthly',
          byDay: [{ day: 'fr', nthOfPeriod: -1 }],
        })],
      });
      const result = expand(event, '2025-01-01T00:00:00', '2025-04-01T00:00:00');
      const days = result.map(e => e.start.substring(0, 10));
      expect(days).toEqual(['2025-01-31', '2025-02-28', '2025-03-28']);
    });
  });

  // -----------------------------------------------------------------------
  // Yearly
  // -----------------------------------------------------------------------
  describe('yearly frequency', () => {
    it('expands yearly on the same date', () => {
      const event = makeEvent({
        start: '2023-03-15T12:00:00',
        recurrenceRules: [rule({ '@type': 'RecurrenceRule', frequency: 'yearly' })],
      });
      const result = expand(event, '2023-01-01T00:00:00', '2026-01-01T00:00:00');
      expect(starts(result)).toEqual([
        '2023-03-15T12:00:00',
        '2024-03-15T12:00:00',
        '2025-03-15T12:00:00',
      ]);
    });

    it('expands yearly with byMonth and byDay (last Friday of November = Thanksgiving-ish)', () => {
      const event = makeEvent({
        start: '2025-11-28T09:00:00', // last Friday of Nov 2025
        recurrenceRules: [rule({
          '@type': 'RecurrenceRule',
          frequency: 'yearly',
          byMonth: ['11'],
          byDay: [{ day: 'fr', nthOfPeriod: -1 }],
        })],
      });
      const result = expand(event, '2025-01-01T00:00:00', '2028-01-01T00:00:00');
      const days = result.map(e => e.start.substring(0, 10));
      // Last Friday of November: 2025-11-28, 2026-11-27, 2027-11-26
      expect(days).toEqual(['2025-11-28', '2026-11-27', '2027-11-26']);
    });

    it('expands yearly with byMonth + byMonthDay', () => {
      const event = makeEvent({
        start: '2025-07-04T00:00:00',
        showWithoutTime: true,
        recurrenceRules: [rule({
          '@type': 'RecurrenceRule',
          frequency: 'yearly',
          byMonth: ['7'],
          byMonthDay: [4],
        })],
      });
      const result = expand(event, '2025-01-01T00:00:00', '2028-01-01T00:00:00');
      expect(result).toHaveLength(3);
    });
  });

  // -----------------------------------------------------------------------
  // bySetPosition
  // -----------------------------------------------------------------------
  describe('bySetPosition', () => {
    it('selects first and last from monthly byDay expansion', () => {
      const event = makeEvent({
        start: '2025-01-06T10:00:00',
        recurrenceRules: [rule({
          '@type': 'RecurrenceRule',
          frequency: 'monthly',
          byDay: [{ day: 'mo' }, { day: 'tu' }, { day: 'we' }, { day: 'th' }, { day: 'fr' }],
          bySetPosition: [1, -1], // first and last weekday of month
        })],
      });
      const result = expand(event, '2025-01-01T00:00:00', '2025-03-01T00:00:00');
      const days = result.map(e => e.start.substring(0, 10));
      // Jan: first weekday = Jan 1 (Wed), last weekday = Jan 31 (Fri)
      // Feb: first weekday = Feb 3 (Mon), last weekday = Feb 28 (Fri)
      // But event starts Jan 6, so Jan 1 is before start → filtered out
      expect(days).toContain('2025-01-31');
      expect(days).toContain('2025-02-03');
      expect(days).toContain('2025-02-28');
    });
  });

  // -----------------------------------------------------------------------
  // Recurrence overrides
  // -----------------------------------------------------------------------
  describe('recurrenceOverrides', () => {
    it('applies overrides to matching occurrences', () => {
      const event = makeEvent({
        recurrenceRules: [rule({ '@type': 'RecurrenceRule', frequency: 'daily' })],
        recurrenceOverrides: {
          '2025-01-07T09:00:00': { title: 'Modified' },
        },
      });
      const result = expand(event, '2025-01-06T00:00:00', '2025-01-09T00:00:00');
      const modified = result.find(e => e.recurrenceId === '2025-01-07T09:00:00');
      expect(modified?.title).toBe('Modified');
    });

    it('excludes occurrences marked as excluded', () => {
      const event = makeEvent({
        recurrenceRules: [rule({ '@type': 'RecurrenceRule', frequency: 'daily' })],
        recurrenceOverrides: {
          '2025-01-07T09:00:00': { excluded: true } as Partial<CalendarEvent> & { excluded?: boolean },
        },
      });
      const result = expand(event, '2025-01-06T00:00:00', '2025-01-09T00:00:00');
      expect(result).toHaveLength(2);
      expect(starts(result)).toEqual(['2025-01-06T09:00:00', '2025-01-08T09:00:00']);
    });

    it('adds RDATE-style overrides not generated by rules', () => {
      const event = makeEvent({
        recurrenceRules: [rule({ '@type': 'RecurrenceRule', frequency: 'weekly' })],
        recurrenceOverrides: {
          '2025-01-08T09:00:00': { title: 'Extra Wednesday' }, // Not a Monday
        },
      });
      const result = expand(event, '2025-01-06T00:00:00', '2025-01-14T00:00:00');
      expect(result.some(e => e.recurrenceId === '2025-01-08T09:00:00')).toBe(true);
    });
  });

  // -----------------------------------------------------------------------
  // excludedRecurrenceRules (EXRULE)
  // -----------------------------------------------------------------------
  describe('excludedRecurrenceRules', () => {
    it('removes occurrences generated by excluded rules', () => {
      const event = makeEvent({
        recurrenceRules: [rule({ '@type': 'RecurrenceRule', frequency: 'daily' })],
        excludedRecurrenceRules: [rule({
          '@type': 'RecurrenceRule',
          frequency: 'weekly',
          byDay: [{ day: 'tu' }],
        })],
      });
      // Jan 6-12 2025: Mon-Sun, Tuesday Jan 7 excluded
      const result = expand(event, '2025-01-06T00:00:00', '2025-01-13T00:00:00');
      const days = result.map(e => e.start.substring(0, 10));
      expect(days).not.toContain('2025-01-07');
      expect(days).toContain('2025-01-06');
      expect(days).toContain('2025-01-08');
      expect(result).toHaveLength(6);
    });
  });

  // -----------------------------------------------------------------------
  // Long-running series
  // -----------------------------------------------------------------------
  describe('long-running series', () => {
    it('expands a daily series started years before the visible range', () => {
      const event = makeEvent({
        start: '2022-01-03T09:00:00',
        recurrenceRules: [rule({ '@type': 'RecurrenceRule', frequency: 'daily' })],
      });
      const result = expand(event, '2025-06-02T00:00:00', '2025-06-05T00:00:00');
      expect(starts(result)).toEqual([
        '2025-06-02T09:00:00',
        '2025-06-03T09:00:00',
        '2025-06-04T09:00:00',
      ]);
    });

    it('expands a weekly series started years before the visible range', () => {
      const event = makeEvent({
        start: '2020-01-06T09:00:00', // Monday
        recurrenceRules: [rule({ '@type': 'RecurrenceRule', frequency: 'weekly' })],
      });
      const result = expand(event, '2025-06-01T00:00:00', '2025-06-30T00:00:00');
      const days = result.map(e => e.start.substring(0, 10));
      expect(days).toEqual(['2025-06-02', '2025-06-09', '2025-06-16', '2025-06-23']);
    });

    it('still respects count for old series (no fast-forward shortcut)', () => {
      const event = makeEvent({
        start: '2025-01-06T09:00:00',
        recurrenceRules: [rule({ '@type': 'RecurrenceRule', frequency: 'daily', count: 5 })],
      });
      // Range far after the 5 occurrences ran out
      const result = expand(event, '2025-06-01T00:00:00', '2025-06-30T00:00:00');
      expect(result).toHaveLength(0);
    });
  });

  // -----------------------------------------------------------------------
  // Event-timezone DST handling
  // -----------------------------------------------------------------------
  describe('event timezone DST handling', () => {
    it('keeps wall time across a DST transition in the event timezone', () => {
      // America/New_York: EST (UTC-5) until 2025-03-09, EDT (UTC-4) after
      const event = makeEvent({
        start: '2025-03-03T10:00:00',
        timeZone: 'America/New_York',
        utcStart: '2025-03-03T15:00:00Z',
        utcEnd: '2025-03-03T16:00:00Z',
        recurrenceRules: [rule({ '@type': 'RecurrenceRule', frequency: 'weekly' })],
      } as Partial<CalendarEvent>);
      const result = expand(event, '2025-03-03T00:00:00', '2025-03-17T00:00:00');
      const utcStarts = result.map(e => e.utcStart);
      expect(utcStarts[0]).toBe('2025-03-03T15:00:00.000Z'); // EST: 10:00 -5
      expect(utcStarts[1]).toBe('2025-03-10T14:00:00.000Z'); // EDT: 10:00 -4
      const utcEnds = result.map(e => e.utcEnd);
      expect(utcEnds[1]).toBe('2025-03-10T15:00:00.000Z');
    });
  });

  // -----------------------------------------------------------------------
  // All-day events
  // -----------------------------------------------------------------------
  describe('all-day events', () => {
    it('expands all-day weekly events', () => {
      const event = makeEvent({
        start: '2025-01-06T00:00:00',
        showWithoutTime: true,
        recurrenceRules: [rule({ '@type': 'RecurrenceRule', frequency: 'weekly' })],
      });
      const result = expand(event, '2025-01-06T00:00:00', '2025-01-28T00:00:00');
      expect(result).toHaveLength(4); // 4 Mondays: 6, 13, 20, 27
    });
  });

  // -----------------------------------------------------------------------
  // Edge cases
  // -----------------------------------------------------------------------
  describe('edge cases', () => {
    it('does not exceed 500 occurrences', () => {
      const event = makeEvent({
        recurrenceRules: [rule({ '@type': 'RecurrenceRule', frequency: 'daily' })],
      });
      const result = expand(event, '2025-01-01T00:00:00', '2030-01-01T00:00:00');
      expect(result.length).toBeLessThanOrEqual(500);
    });

    it('handles invalid start date gracefully', () => {
      const event = makeEvent({
        start: 'invalid',
        recurrenceRules: [rule({ '@type': 'RecurrenceRule', frequency: 'daily' })],
      });
      const result = expand(event, '2025-01-01T00:00:00', '2025-02-01T00:00:00');
      expect(result).toHaveLength(0);
    });

    it('generates synthetic IDs for occurrences', () => {
      const event = makeEvent({
        recurrenceRules: [rule({ '@type': 'RecurrenceRule', frequency: 'daily' })],
      });
      const result = expand(event, '2025-01-06T00:00:00', '2025-01-08T00:00:00');
      expect(result[0].id).toBe('evt1:2025-01-06T09:00:00');
      expect(result[1].id).toBe('evt1:2025-01-07T09:00:00');
    });

    it('preserves originalId pointing to master', () => {
      const event = makeEvent({
        recurrenceRules: [rule({ '@type': 'RecurrenceRule', frequency: 'daily' })],
      });
      const result = expand(event, '2025-01-06T00:00:00', '2025-01-08T00:00:00');
      expect(result[0].originalId).toBe('evt1');
    });

    it('skips server-returned override events that belong to a recurring master', () => {
      // Server returns the master event plus override instances with recurrenceId set
      const master = makeEvent({
        id: 'master1',
        uid: 'shared-uid',
        start: '2025-01-06T09:00:00',
        recurrenceRules: [rule({ '@type': 'RecurrenceRule', frequency: 'weekly' })],
      });
      const override1 = makeEvent({
        id: 'override1',
        uid: 'shared-uid',
        start: '2025-01-13T09:00:00',
        recurrenceId: '2025-01-13T09:00:00',
        recurrenceRules: null,
      });
      const override2 = makeEvent({
        id: 'override2',
        uid: 'shared-uid',
        start: '2025-01-20T09:00:00',
        recurrenceId: '2025-01-20T09:00:00',
        recurrenceRules: null,
      });

      const result = expandRecurringEvents(
        [master, override1, override2],
        '2025-01-06T00:00:00',
        '2025-01-27T00:00:00',
      );

      // Should have 3 weekly occurrences from master expansion only (Jan 6, 13, 20)
      // Override events should be skipped since they share the master's UID
      expect(result).toHaveLength(3);
      expect(starts(result)).toEqual([
        '2025-01-06T09:00:00',
        '2025-01-13T09:00:00',
        '2025-01-20T09:00:00',
      ]);
    });

    it('keeps override events whose UID has no matching master', () => {
      // Standalone override event with no master in the batch
      const orphanOverride = makeEvent({
        id: 'orphan1',
        uid: 'orphan-uid',
        start: '2025-01-13T09:00:00',
        recurrenceId: '2025-01-13T09:00:00',
        recurrenceRules: null,
      });

      const result = expandRecurringEvents(
        [orphanOverride],
        '2025-01-06T00:00:00',
        '2025-01-27T00:00:00',
      );

      expect(result).toHaveLength(1);
      expect(result[0].id).toBe('orphan1');
    });
  });

  // -----------------------------------------------------------------------
  // utcStart computation for occurrences
  // -----------------------------------------------------------------------
  describe('utcStart per occurrence', () => {
    it('computes distinct utcStart for each weekly occurrence', () => {
      const event = makeEvent({
        start: '2026-09-01T12:00:00',
        utcStart: '2026-09-01T10:00:00Z',
        recurrenceRules: [rule({ '@type': 'RecurrenceRule', frequency: 'weekly' })],
      });
      const result = expand(event, '2026-09-01T00:00:00', '2026-10-01T00:00:00');
      const utcStarts = result.map(e => e.utcStart);
      // Each occurrence should have a unique utcStart
      expect(new Set(utcStarts).size).toBe(result.length);
      // First occurrence keeps master's UTC offset relationship
      expect(utcStarts[0]).toContain('2026-09-01');
      expect(utcStarts[1]).toContain('2026-09-08');
      expect(utcStarts[2]).toContain('2026-09-15');
    });

    it('computes distinct utcEnd for each weekly occurrence', () => {
      const event = makeEvent({
        start: '2026-09-01T12:00:00',
        duration: 'PT1H',
        utcStart: '2026-09-01T10:00:00Z',
        utcEnd: '2026-09-01T11:00:00Z',
        recurrenceRules: [rule({ '@type': 'RecurrenceRule', frequency: 'weekly' })],
      });
      const result = expand(event, '2026-09-01T00:00:00', '2026-10-01T00:00:00');
      const utcEnds = result.map(e => e.utcEnd);
      // Each occurrence should have a unique utcEnd
      expect(new Set(utcEnds).size).toBe(result.length);
      expect(utcEnds[0]).toContain('2026-09-01');
      expect(utcEnds[1]).toContain('2026-09-08');
      expect(utcEnds[2]).toContain('2026-09-15');
    });

    it('does not set utcStart when master has none', () => {
      const event = makeEvent({
        start: '2025-01-06T09:00:00',
        recurrenceRules: [rule({ '@type': 'RecurrenceRule', frequency: 'daily' })],
      });
      const result = expand(event, '2025-01-06T00:00:00', '2025-01-08T00:00:00');
      expect(result[0].utcStart).toBeUndefined();
    });
  });
});
