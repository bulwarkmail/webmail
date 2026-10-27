import { describe, expect, it } from "vitest";
import { isPaused, minutesToTime, pauseUntil, timeToMinutes } from "../push";

describe("chat push settings (step 43, part C)", () => {
  it("converts times of the quiet hours", () => {
    expect(timeToMinutes("18:00")).toBe(1080);
    expect(timeToMinutes("8:05")).toBe(485);
    expect(timeToMinutes("24:00")).toBeNull();
    expect(timeToMinutes("")).toBeNull();
    expect(minutesToTime(485)).toBe("08:05");
    expect(minutesToTime(null)).toBe("");
  });

  it("pauses for a while or until tomorrow morning", () => {
    const now = new Date(2026, 9, 26, 22, 15);
    expect(pauseUntil("30m", now).getTime() - now.getTime()).toBe(30 * 60_000);
    expect(pauseUntil("2h", now).getTime() - now.getTime()).toBe(120 * 60_000);
    const tomorrow = pauseUntil("tomorrow", now);
    expect([tomorrow.getDate(), tomorrow.getHours(), tomorrow.getMinutes()]).toEqual([27, 8, 0]);
  });

  it("knows whether the pause is still on", () => {
    const base = { dndFrom: null, dndTo: null, dndDays: [], emailDigest: true };
    expect(isPaused(null)).toBe(false);
    expect(isPaused({ ...base, dndUntil: null })).toBe(false);
    expect(isPaused({ ...base, dndUntil: new Date(2000).toISOString() }, 1000)).toBe(true);
    expect(isPaused({ ...base, dndUntil: new Date(2000).toISOString() }, 3000)).toBe(false);
  });
});
