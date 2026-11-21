import { describe, expect, it } from 'vitest';
import {
  addDays,
  busySpans,
  combineSpans,
  dayOf,
  freeSpans,
  minuteOfDay,
  moveSlotTo,
  outsideWorkingSpans,
  resizeSlotTo,
  spanOnDay,
  workingSpan,
} from '../scheduling-assistant';
import type { BusyPeriod } from '../jmap/types';

const BERLIN = 'Europe/Berlin';
// Monday 2 November 2026 in Berlin (UTC+1).
const MONDAY = { year: 2026, month: 11, day: 2 };
const busy = (utcStart: string, utcEnd: string, busyStatus: BusyPeriod['busyStatus'] = 'confirmed'): BusyPeriod => ({ utcStart, utcEnd, busyStatus });

describe('the scheduling grid', () => {
  it('reads days and minutes on the clock of the time zone', () => {
    expect(dayOf(new Date('2026-11-01T23:30:00Z'), BERLIN)).toEqual(MONDAY);
    expect(minuteOfDay(new Date('2026-11-02T08:15:00Z'), MONDAY, BERLIN)).toBe(9 * 60 + 15);
    expect(minuteOfDay(new Date('2026-11-01T10:00:00Z'), MONDAY, BERLIN)).toBe(0);
    expect(minuteOfDay(new Date('2026-11-03T10:00:00Z'), MONDAY, BERLIN)).toBe(1440);
    expect(addDays({ year: 2026, month: 12, day: 31 }, 1)).toEqual({ year: 2027, month: 1, day: 1 });
  });

  it('keeps the hours under their labels on the day the clocks go back', () => {
    // 25 October 2026: 03:00 summer time becomes 02:00 winter time in Berlin.
    const day = { year: 2026, month: 10, day: 25 };
    expect(minuteOfDay(new Date('2026-10-25T11:00:00Z'), day, BERLIN)).toBe(12 * 60);
  });

  it('cuts busy time to the day and leaves out the edited event itself', () => {
    const periods = [
      busy('2026-11-01T22:00:00Z', '2026-11-02T07:00:00Z'), // Sunday 23:00 to Monday 8:00
      busy('2026-11-02T09:00:00Z', '2026-11-02T10:00:00Z', 'tentative'), // 10-11
      busy('2026-11-02T12:00:00Z', '2026-11-02T13:00:00Z'), // 13-14, the event as saved
      busy('2026-11-03T09:00:00Z', '2026-11-03T10:00:00Z'), // Tuesday
    ];
    const own = { start: new Date('2026-11-02T12:00:00Z'), end: new Date('2026-11-02T13:00:00Z') };
    expect(busySpans(periods, MONDAY, BERLIN, own)).toEqual([
      { from: 0, to: 8 * 60, kind: 'busy' },
      { from: 10 * 60, to: 11 * 60, kind: 'tentative' },
    ]);
  });

  it('merges everyone into one row, busy over tentative', () => {
    const combined = combineSpans([
      [{ from: 600, to: 660, kind: 'tentative' }],
      [{ from: 630, to: 720, kind: 'busy' }],
      [{ from: 720, to: 750, kind: 'busy' }],
    ]);
    expect(combined).toEqual([
      { from: 600, to: 630, kind: 'tentative' },
      { from: 630, to: 750, kind: 'busy' },
    ]);
    expect(freeSpans(combined, { from: 540, to: 1020 })).toEqual([
      { from: 540, to: 600 },
      { from: 750, to: 1020 },
    ]);
  });

  it('shades the hours outside the working day, and all of a day off', () => {
    const hours = { startMinutes: 9 * 60, endMinutes: 17 * 60 };
    const working = workingSpan(MONDAY, new Set([1, 2, 3, 4, 5]), hours);
    expect(outsideWorkingSpans(working)).toEqual([{ from: 0, to: 540 }, { from: 1020, to: 1440 }]);
    expect(outsideWorkingSpans(workingSpan(addDays(MONDAY, -1), new Set([1, 2, 3, 4, 5]), hours))).toEqual([{ from: 0, to: 1440 }]);
  });

  it('moves the event in 15-minute steps, keeping its length, and resizes its end', () => {
    const slot = { start: new Date('2026-11-05T09:00:00Z'), end: new Date('2026-11-05T09:45:00Z') };
    const moved = moveSlotTo(slot, MONDAY, 14 * 60 + 8, BERLIN); // 14:08 snaps to 14:15
    expect(moved).toEqual({ start: new Date('2026-11-02T13:15:00Z'), end: new Date('2026-11-02T14:00:00Z') });
    expect(spanOnDay(moved.start, moved.end, MONDAY, BERLIN)).toEqual({ from: 855, to: 900 });
    expect(resizeSlotTo(moved, MONDAY, 16 * 60, BERLIN).end).toEqual(new Date('2026-11-02T15:00:00Z'));
    // Never shorter than one step.
    expect(resizeSlotTo(moved, MONDAY, 10 * 60, BERLIN).end).toEqual(new Date('2026-11-02T13:30:00Z'));
  });
});
