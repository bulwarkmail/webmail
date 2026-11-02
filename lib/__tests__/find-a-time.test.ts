import { describe, expect, it } from 'vitest';
import { findFreeSlots, searchHours, searchWindow } from '../find-a-time';
import type { BusyPeriod } from '@/lib/jmap/types';

const busy = (utcStart: string, utcEnd: string, busyStatus: BusyPeriod['busyStatus'] = 'confirmed'): BusyPeriod => ({ utcStart, utcEnd, busyStatus });
const HOUR = 3600_000;

// Monday 2 November 2026, 07:00 in Berlin (06:00 UTC, winter time).
const monday = new Date('2026-11-02T06:00:00Z');
const base = {
  now: monday,
  durationMs: HOUR,
  timeZone: 'Europe/Berlin',
  workingDays: [1, 2, 3, 4, 5],
  dayStartHour: 9,
  dayEndHour: 17,
  busy: [] as BusyPeriod[],
};
const starts = (slots: { start: Date }[]) => slots.map((s) => s.start.toISOString());

describe('findFreeSlots', () => {
  it('starts at the first working hour in the effective zone, on a 30-minute grid', () => {
    expect(starts(findFreeSlots(base))).toEqual([
      '2026-11-02T08:00:00.000Z', // 09:00 Berlin
      '2026-11-02T08:30:00.000Z',
      '2026-11-02T09:00:00.000Z',
      '2026-11-02T09:30:00.000Z',
      '2026-11-02T10:00:00.000Z',
    ]);
  });

  it('reads the hours in the given zone, not the browser zone', () => {
    const slots = findFreeSlots({ ...base, timeZone: 'America/New_York', now: new Date('2026-11-02T00:00:00Z'), maxSlots: 1 });
    // 09:00 in New York on Monday 2 November (EST, UTC-5).
    expect(starts(slots)).toEqual(['2026-11-02T14:00:00.000Z']);
  });

  it('skips busy and tentative time of everyone and keeps slots inside the day', () => {
    const slots = findFreeSlots({
      ...base,
      busy: [
        busy('2026-11-02T08:00:00Z', '2026-11-02T10:00:00Z'), // Bob 9-11 Berlin
        busy('2026-11-02T10:00:00Z', '2026-11-02T11:00:00Z', 'tentative'), // Carol 11-12
      ],
      maxSlots: 2,
    });
    expect(starts(slots)).toEqual(['2026-11-02T11:00:00.000Z', '2026-11-02T11:30:00.000Z']);
  });

  it('never ends a slot after the day ends and moves to the next working day', () => {
    const lateMonday = new Date('2026-11-02T15:10:00Z'); // 16:10 Berlin
    const slots = findFreeSlots({ ...base, now: lateMonday, maxSlots: 1 });
    // 16:30-17:30 would end after 17:00; Tuesday 09:00 is next.
    expect(starts(slots)).toEqual(['2026-11-03T08:00:00.000Z']);
  });

  it('only uses the working days', () => {
    const friday = new Date('2026-11-06T16:30:00Z'); // 17:30 Berlin, after hours
    const slots = findFreeSlots({ ...base, now: friday, maxSlots: 1 });
    expect(starts(slots)).toEqual(['2026-11-09T08:00:00.000Z']); // Monday
    const sundayOnly = findFreeSlots({ ...base, workingDays: [0], maxSlots: 1 });
    expect(starts(sundayOnly)).toEqual(['2026-11-08T08:00:00.000Z']);
  });

  it('falls back to Monday to Friday and 8 to 20 for unusable settings', () => {
    const slots = findFreeSlots({ ...base, workingDays: [], dayStartHour: 20, dayEndHour: 8, maxSlots: 1 });
    expect(starts(slots)).toEqual(['2026-11-02T07:00:00.000Z']); // 08:00 Berlin
  });

  it('finds nothing when a meeting is longer than the working day', () => {
    expect(findFreeSlots({ ...base, durationMs: 9 * HOUR })).toEqual([]);
  });

  it('finds nothing when everything in the next ten working days is busy', () => {
    const slots = findFreeSlots({ ...base, busy: [busy('2026-11-01T00:00:00Z', '2026-11-30T00:00:00Z')] });
    expect(slots).toEqual([]);
  });
});

describe('searchWindow', () => {
  it('runs from now to the end of the tenth working day', () => {
    const window = searchWindow(base);
    expect(window.start).toBe(monday);
    // Ten working days from Monday 2 November: the last is Friday 13 November, ending 17:00 Berlin.
    expect(window.end.toISOString()).toBe('2026-11-13T16:00:00.000Z');
  });
});

describe('searchHours', () => {
  it('keeps a whole day the user set on purpose', () => {
    expect(searchHours(0, 24)).toEqual({ startMinutes: 0, endMinutes: 1440 });
    expect(searchHours(7, 19)).toEqual({ startMinutes: 420, endMinutes: 1140 });
  });
});
