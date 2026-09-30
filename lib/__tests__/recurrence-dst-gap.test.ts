import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { expandRecurringEvents } from '../recurrence-expansion';
import type { CalendarEvent } from '@/lib/jmap/types';

// Daily expansion advanced a Date across the browser's DST gap and kept the
// shifted time (02:30 became 03:30, midnight became 01:00); the implicit
// byHour then rejected every later day, so the series ended at the gap.

function daily(start: string, allDay: boolean, timeZone?: string): CalendarEvent {
  return {
    id: 'E1', uid: 'u1', title: 'Daily', calendarIds: { c: true },
    start, duration: allDay ? 'P1D' : 'PT30M', showWithoutTime: allDay,
    ...(timeZone ? { timeZone } : {}),
    recurrenceRules: [{ '@type': 'RecurrenceRule', frequency: 'daily' }],
  } as unknown as CalendarEvent;
}

let originalTZ: string | undefined;
beforeEach(() => {
  originalTZ = process.env.TZ;
});
afterEach(() => {
  process.env.TZ = originalTZ;
});

describe('daily recurrence across a DST gap', () => {
  it('keeps a 02:30 series going past the spring-forward night (Berlin)', () => {
    process.env.TZ = 'Europe/Berlin';
    const out = expandRecurringEvents([daily('2026-03-01T02:30:00', false, 'Europe/Berlin')], '2026-03-01T00:00:00', '2026-04-01T00:00:00');
    expect(out).toHaveLength(31);
    expect(out.at(-1)!.start.slice(0, 16)).toBe('2026-03-31T02:30');
  });

  it('keeps an all-day series going after a midnight gap (Santiago)', () => {
    process.env.TZ = 'America/Santiago';
    const out = expandRecurringEvents([daily('2026-08-20T00:00:00', true)], '2026-09-07T00:00:00', '2026-09-14T00:00:00');
    expect(out).toHaveLength(7);
    expect(out.map((o) => o.start.slice(11, 16))).toEqual(Array(7).fill('00:00'));
  });
});
