import { describe, expect, it } from 'vitest';
import { createCompactNightTimeScale, createLinearTimeScale, hourRowHeight } from '../calendar-time-scale';

describe('createLinearTimeScale', () => {
  const scale = createLinearTimeScale(60);

  it('reports the full 24h height as hourHeight * 24', () => {
    expect(scale.totalHeight).toBe(1440);
  });

  it('maps minutes to Y proportionally', () => {
    expect(scale.minutesToY(0)).toBe(0);
    expect(scale.minutesToY(60)).toBe(60);
    expect(scale.minutesToY(90)).toBe(90);
    expect(scale.minutesToY(1440)).toBe(1440);
  });

  it('yToMinutes is the exact inverse of minutesToY', () => {
    for (const minutes of [0, 15, 90, 360, 720, 1320, 1440]) {
      expect(scale.yToMinutes(scale.minutesToY(minutes))).toBeCloseTo(minutes, 6);
    }
  });

  it('every hour row is the same height', () => {
    for (let h = 0; h < 24; h++) {
      expect(hourRowHeight(scale, h)).toBe(60);
    }
  });
});

describe('createCompactNightTimeScale', () => {
  // Default day band 06:00-22:00 (16h) at 60px/h, night band (22:00-06:00,
  // 8h split across midnight) at 20px/h.
  const scale = createCompactNightTimeScale({ dayHourHeight: 60, nightHourHeight: 20 });

  it('totals day-band + night-band heights (16*60 + 8*20 = 1120)', () => {
    expect(scale.totalHeight).toBe(1120);
  });

  it('uses the night rate before 06:00 and after 22:00', () => {
    expect(scale.minutesToY(0)).toBe(0);
    expect(scale.minutesToY(60)).toBe(20); // 01:00 -> one night-hour
    expect(scale.minutesToY(6 * 60)).toBe(6 * 20); // 06:00, end of the pre-day night band
  });

  it('uses the day rate between 06:00 and 22:00', () => {
    const dayStartY = scale.minutesToY(6 * 60);
    expect(scale.minutesToY(7 * 60)).toBe(dayStartY + 60); // one full-rate hour into the day
    expect(scale.minutesToY(22 * 60)).toBe(dayStartY + 16 * 60); // 22:00, end of the day band
  });

  it('is continuous at both day/night boundaries (no jump)', () => {
    const justBefore6 = scale.minutesToY(6 * 60 - 1);
    const at6 = scale.minutesToY(6 * 60);
    expect(at6 - justBefore6).toBeCloseTo(20 / 60, 3); // one minute at the night rate

    const at22 = scale.minutesToY(22 * 60);
    const justAfter22 = scale.minutesToY(22 * 60 + 1);
    expect(justAfter22 - at22).toBeCloseTo(20 / 60, 3); // one minute at the night rate
  });

  it('reaches totalHeight exactly at end of day (24:00 / 1440 minutes)', () => {
    expect(scale.minutesToY(1440)).toBe(scale.totalHeight);
  });

  it('yToMinutes is the exact inverse of minutesToY across all three bands', () => {
    for (const minutes of [0, 30, 180, 359, 360, 600, 900, 1319, 1320, 1380, 1440]) {
      expect(scale.yToMinutes(scale.minutesToY(minutes))).toBeCloseTo(minutes, 6);
    }
  });

  it('night hour rows are shorter than day hour rows', () => {
    expect(hourRowHeight(scale, 2)).toBe(20); // 02:00-03:00, night
    expect(hourRowHeight(scale, 12)).toBe(60); // 12:00-13:00, day
    expect(hourRowHeight(scale, 23)).toBe(20); // 23:00-24:00, night
  });

  it('clamps out-of-range minutes instead of extrapolating', () => {
    expect(scale.minutesToY(-100)).toBe(scale.minutesToY(0));
    expect(scale.minutesToY(2000)).toBe(scale.minutesToY(1440));
  });

  it('respects custom day-band boundaries', () => {
    const custom = createCompactNightTimeScale({
      dayHourHeight: 40,
      nightHourHeight: 10,
      dayStartMinutes: 8 * 60,
      dayEndMinutes: 20 * 60,
    });
    // 8h night before + 12h day + 4h night after
    expect(custom.totalHeight).toBe(8 * 10 + 12 * 40 + 4 * 10);
  });
});
