import { describe, expect, it } from "vitest";
import {
  FULL_DAY_HOURS,
  clipToDisplayHours,
  formatDisplayHour,
  indexOfDayOnOrAfter,
  partitionByDisplayHours,
  remapSegmentsToShownDays,
  resolveDisplayHours,
  resolveWorkingDays,
} from "@/lib/calendar-display-range";
import type { CalendarWeekSegment } from "@/lib/calendar-utils";
import type { CalendarEvent } from "@/lib/jmap/types";

function timed(id: string, start: string, duration: string): CalendarEvent {
  return {
    id, "@type": "Event", uid: id, title: id, start, duration,
    showWithoutTime: false, calendarIds: { cal: true },
  } as unknown as CalendarEvent;
}

const WORK_HOURS = resolveDisplayHours(true, 8, 20);

describe("resolveDisplayHours (#1164)", () => {
  it("restricts the grid to the configured hours", () => {
    expect(WORK_HOURS).toEqual({ startMinutes: 480, endMinutes: 1200, restricted: true });
  });

  it("shows the whole day when switched off or set to the whole day", () => {
    expect(resolveDisplayHours(false, 8, 20)).toBe(FULL_DAY_HOURS);
    expect(resolveDisplayHours(true, 0, 24)).toBe(FULL_DAY_HOURS);
  });

  it.each([
    [20, 8], [8, 8], [-1, 20], [8, 25], [8.5, 20], ["8", 20], [null, undefined],
  ])("falls back to the whole day for a malformed range %s-%s", (start, end) => {
    expect(resolveDisplayHours(true, start, end)).toBe(FULL_DAY_HOURS);
  });
});

describe("resolveWorkingDays (#1164)", () => {
  it("returns the selected weekdays", () => {
    expect(resolveWorkingDays(true, [1, 2, 3, 4, 5])).toEqual(new Set([1, 2, 3, 4, 5]));
  });

  it("shows every day when off, empty, complete or malformed", () => {
    expect(resolveWorkingDays(false, [1, 2])).toBeNull();
    expect(resolveWorkingDays(true, [])).toBeNull();
    expect(resolveWorkingDays(true, [0, 1, 2, 3, 4, 5, 6])).toBeNull();
    expect(resolveWorkingDays(true, "1,2")).toBeNull();
    expect(resolveWorkingDays(true, [7, -1, 1.5])).toBeNull();
  });

  it("ignores entries that are not weekdays", () => {
    expect(resolveWorkingDays(true, [1, 9, "2", 3])).toEqual(new Set([1, 3]));
  });
});

describe("partitionByDisplayHours (#1164)", () => {
  const day = new Date(2026, 8, 9);

  it("counts events above and below the visible hours instead of drawing them", () => {
    const result = partitionByDisplayHours([
      timed("early", "2026-09-09T06:00:00", "PT1H"),
      timed("ends-at-start", "2026-09-09T07:00:00", "PT1H"),
      timed("straddles-start", "2026-09-09T07:30:00", "PT1H"),
      timed("zero-at-start", "2026-09-09T08:00:00", "PT0M"),
      timed("ends-at-end", "2026-09-09T19:30:00", "PT30M"),
      timed("late", "2026-09-09T21:00:00", "PT1H"),
      timed("starts-at-end", "2026-09-09T20:00:00", "PT30M"),
    ], day, WORK_HOURS);

    expect(result.visible.map((e) => e.id)).toEqual(["straddles-start", "zero-at-start", "ends-at-end"]);
    expect(result.before).toBe(2);
    expect(result.firstBeforeMinutes).toBe(360);
    expect(result.after).toBe(2);
    expect(result.firstAfterMinutes).toBe(1200);
  });

  it("keeps every event when the whole day is shown", () => {
    const events = [timed("early", "2026-09-09T06:00:00", "PT1H")];
    const result = partitionByDisplayHours(events, day, FULL_DAY_HOURS);
    expect(result.visible).toBe(events);
    expect(result.before).toBe(0);
  });

  it("keeps an event spanning the visible hours from the previous night", () => {
    const result = partitionByDisplayHours([timed("overnight", "2026-09-08T22:00:00", "PT12H")], day, WORK_HOURS);
    expect(result.visible).toHaveLength(1);
  });
});

describe("clipToDisplayHours (#1164)", () => {
  it("cuts an event to the visible hours and reports which ends were cut", () => {
    expect(clipToDisplayHours(420, 540, WORK_HOURS)).toEqual({
      startMinutes: 480, endMinutes: 540, clippedStart: true, clippedEnd: false,
    });
    expect(clipToDisplayHours(1140, 1260, WORK_HOURS)).toEqual({
      startMinutes: 1140, endMinutes: 1200, clippedStart: false, clippedEnd: true,
    });
  });

  it("leaves a whole-day grid untouched", () => {
    expect(clipToDisplayHours(0, 1440, FULL_DAY_HOURS)).toEqual({
      startMinutes: 0, endMinutes: 1440, clippedStart: false, clippedEnd: false,
    });
  });
});

describe("remapSegmentsToShownDays (#1164)", () => {
  // Mon 7 .. Sun 20 Sep 2026 with weekends hidden: columns Mon-Fri, Mon-Fri.
  const shown = [0, 1, 2, 3, 4, -1, -1, 5, 6, 7, 8, 9, -1, -1];
  const segment = (startIndex: number, span: number): CalendarWeekSegment => ({
    event: timed("e", "2026-09-07T00:00:00", "P1D"),
    startIndex, span, row: 0, continuesBefore: false, continuesAfter: false,
  });

  it("moves a segment across a hidden weekend onto the shown columns", () => {
    // Fri 11 .. Mon 14 -> Fri column 4 .. Mon column 5
    expect(remapSegmentsToShownDays([segment(4, 4)], shown)).toEqual([
      expect.objectContaining({ startIndex: 4, span: 2, row: -1, continuesBefore: false, continuesAfter: false }),
    ]);
  });

  it("drops a segment that only covers hidden days", () => {
    expect(remapSegmentsToShownDays([segment(5, 2)], shown)).toEqual([]);
  });

  it("marks a segment as continuing where hidden days were cut off", () => {
    // Sat 12 .. Tue 15 -> Mon .. Tue, continuing before
    expect(remapSegmentsToShownDays([segment(5, 4)], shown)).toEqual([
      expect.objectContaining({ startIndex: 5, span: 2, continuesBefore: true, continuesAfter: false }),
    ]);
    // Thu 17 .. Sun 20 -> Thu .. Fri, continuing after
    expect(remapSegmentsToShownDays([segment(10, 4)], shown)).toEqual([
      expect.objectContaining({ startIndex: 8, span: 2, continuesBefore: false, continuesAfter: true }),
    ]);
  });
});

describe("indexOfDayOnOrAfter", () => {
  const days = [new Date(2026, 8, 11), new Date(2026, 8, 14), new Date(2026, 8, 15)];

  it("finds the next shown day for a hidden one", () => {
    expect(indexOfDayOnOrAfter(days, new Date(2026, 8, 12, 15, 30))).toBe(1);
    expect(indexOfDayOnOrAfter(days, new Date(2026, 8, 14))).toBe(1);
  });

  it("clamps to the loaded days", () => {
    expect(indexOfDayOnOrAfter(days, new Date(2026, 8, 1))).toBe(0);
    expect(indexOfDayOnOrAfter(days, new Date(2026, 9, 1))).toBe(2);
  });
});

describe("formatDisplayHour", () => {
  it("labels the end of the day as 24:00", () => {
    expect(formatDisplayHour(8, "24h")).toBe("08:00");
    expect(formatDisplayHour(24, "24h")).toBe("24:00");
    expect(formatDisplayHour(24, "12h")).toBe("12:00 AM");
    expect(formatDisplayHour(20, "12h")).toBe("8:00 PM");
  });
});
