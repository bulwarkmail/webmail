import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest';
import {
  AUTO_TIME_ZONE,
  displayNow,
  fromDisplayDate,
  fromZonedDisplayDate,
  getBrowserTimeZone,
  getTimeZoneOffsetMs,
  getWallClock,
  isDisplayToday,
  isValidTimeZone,
  listTimeZones,
  resolveTimeZone,
  toDisplayDate,
  toZonedDisplayDate,
} from '../timezone';
import { formatDate, formatDateTime } from '../utils';
import { useSettingsStore } from '@/stores/settings-store';

// Pin the process zone so "browser" detection is deterministic - this is the
// LibreWolf / resistFingerprinting scenario from #755: the runtime reports
// UTC, the user actually lives somewhere else.
const ORIGINAL_TZ = process.env.TZ;
beforeAll(() => {
  process.env.TZ = 'UTC';
});
afterAll(() => {
  if (ORIGINAL_TZ === undefined) delete process.env.TZ;
  else process.env.TZ = ORIGINAL_TZ;
});
afterEach(() => {
  useSettingsStore.setState({ timeZone: AUTO_TIME_ZONE, dateFormat: 'smart', timeFormat: '24h', dateLocale: 'auto' });
  vi.useRealTimers();
});

const HOUR = 3600_000;

describe('resolveTimeZone', () => {
  it('follows the browser for auto / empty / unknown values', () => {
    expect(resolveTimeZone(AUTO_TIME_ZONE, 'Europe/Berlin')).toBe('Europe/Berlin');
    expect(resolveTimeZone('', 'Europe/Berlin')).toBe('Europe/Berlin');
    expect(resolveTimeZone(undefined, 'Europe/Berlin')).toBe('Europe/Berlin');
    expect(resolveTimeZone('Mars/Olympus_Mons', 'Europe/Berlin')).toBe('Europe/Berlin');
  });

  it('returns a valid explicit zone unchanged', () => {
    expect(resolveTimeZone('Asia/Tokyo', 'Europe/Berlin')).toBe('Asia/Tokyo');
  });

  it('validates zone ids against Intl', () => {
    expect(isValidTimeZone('America/New_York')).toBe(true);
    expect(isValidTimeZone('Not/A_Zone')).toBe(false);
    expect(isValidTimeZone('')).toBe(false);
    expect(isValidTimeZone(42)).toBe(false);
  });

  it('lists zones including the common ones', () => {
    const zones = listTimeZones();
    expect(zones).toContain('Europe/Berlin');
    expect(zones[0]).toBe('UTC');
    expect(zones.filter((z) => z === 'UTC')).toHaveLength(1);
    const rest = zones.slice(1);
    expect([...rest].sort()).toEqual(rest);
  });
});

describe('wall-clock helpers', () => {
  const noon = new Date('2026-07-01T12:00:00Z');

  it('reads the wall-clock of an instant in a zone', () => {
    expect(getWallClock(noon, 'Asia/Tokyo')).toEqual({ year: 2026, month: 7, day: 1, hour: 21, minute: 0, second: 0 });
    expect(getWallClock(noon, 'America/Los_Angeles')).toEqual({ year: 2026, month: 7, day: 1, hour: 5, minute: 0, second: 0 });
  });

  it('computes DST-aware offsets', () => {
    expect(getTimeZoneOffsetMs(noon, 'Asia/Tokyo')).toBe(9 * HOUR);
    expect(getTimeZoneOffsetMs(noon, 'Europe/Berlin')).toBe(2 * HOUR);
    expect(getTimeZoneOffsetMs(new Date('2026-01-15T12:00:00Z'), 'Europe/Berlin')).toBe(1 * HOUR);
    expect(getTimeZoneOffsetMs(noon, 'UTC')).toBe(0);
  });

  it('shifts an instant so local getters read as the zone wall-clock', () => {
    const berlin = toZonedDisplayDate(noon, 'Europe/Berlin');
    expect(berlin.getHours()).toBe(14);
    expect(berlin.getDate()).toBe(1);

    // Crosses midnight: 23:30Z on the 1st is 01:30 on the 2nd in Berlin.
    const late = toZonedDisplayDate(new Date('2026-07-01T23:30:00Z'), 'Europe/Berlin');
    expect(late.getDate()).toBe(2);
    expect(late.getHours()).toBe(1);
    expect(late.getMinutes()).toBe(30);
  });

  it('round-trips through fromZonedDisplayDate, including across a DST switch', () => {
    const instants = [
      '2026-07-01T12:00:00Z',
      '2026-07-01T23:30:00Z',
      '2026-01-15T00:15:00Z',
      '2026-03-29T00:59:00Z', // Berlin: last minute of CET before the spring-forward
      '2026-03-29T01:00:00Z', // Berlin: 03:00 CEST, right after the gap
      '2026-10-25T01:30:00Z', // Berlin: second 02:30 of the fall-back night
    ];
    for (const iso of instants) {
      for (const zone of ['Europe/Berlin', 'America/New_York', 'Asia/Kolkata', 'Pacific/Auckland', 'UTC']) {
        const instant = new Date(iso);
        const shifted = toZonedDisplayDate(instant, zone);
        expect(fromZonedDisplayDate(shifted, zone).getTime(), `${iso} in ${zone}`).toBe(instant.getTime());
      }
    }
  });

  it('keeps invalid dates invalid instead of throwing', () => {
    const bad = new Date('nope');
    expect(isNaN(toZonedDisplayDate(bad, 'Europe/Berlin').getTime())).toBe(true);
    expect(isNaN(fromZonedDisplayDate(bad, 'Europe/Berlin').getTime())).toBe(true);
  });
});

describe('store-aware display dates', () => {
  it('are the identity while the setting is auto', () => {
    expect(getBrowserTimeZone()).toBe('UTC');
    const d = new Date('2026-07-01T12:00:00Z');
    expect(toDisplayDate(d)).toBe(d);
    expect(fromDisplayDate(d)).toBe(d);
  });

  it('shift by the override zone and invert cleanly', () => {
    useSettingsStore.setState({ timeZone: 'Asia/Tokyo' });
    const d = new Date('2026-07-01T12:00:00Z');
    const display = toDisplayDate(d);
    expect(display.getHours()).toBe(21);
    expect(display.getTime() - d.getTime()).toBe(9 * HOUR);
    expect(fromDisplayDate(display).getTime()).toBe(d.getTime());
  });

  it('report "today" from the override zone, not the browser zone', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-07-01T16:00:00Z')); // 01:00 on July 2 in Tokyo
    useSettingsStore.setState({ timeZone: 'Asia/Tokyo' });

    const now = displayNow();
    expect(now.getDate()).toBe(2);
    expect(now.getHours()).toBe(1);
    expect(isDisplayToday(new Date(2026, 6, 2, 9, 0))).toBe(true);
    expect(isDisplayToday(new Date(2026, 6, 1, 23, 0))).toBe(false);
  });

  it('fall back to the browser zone for an unknown stored zone', () => {
    useSettingsStore.setState({ timeZone: 'Mars/Olympus_Mons' });
    const d = new Date('2026-07-01T12:00:00Z');
    expect(toDisplayDate(d)).toBe(d);
  });
});

describe('mail timestamp formatting honours the override', () => {
  it('formatDate buckets "today" in the override zone', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-07-01T16:00:00Z')); // 01:00 July 2 in Tokyo
    const received = new Date('2026-07-01T14:00:00Z'); // 23:00 July 1 in Tokyo

    // Browser zone (UTC): same day -> time only.
    expect(formatDate(received)).toBe('14:00');

    // Tokyo: yesterday -> short weekday + time, in Tokyo wall-clock.
    useSettingsStore.setState({ timeZone: 'Asia/Tokyo' });
    expect(formatDate(received)).toBe('Wed 23:00');
  });

  it('formatDate full and formatDateTime render the override wall-clock', () => {
    useSettingsStore.setState({ timeZone: 'Asia/Tokyo', dateFormat: 'full' });
    const received = new Date('2026-07-01T14:00:00Z');
    expect(formatDate(received)).toContain('23:00');
    expect(formatDateTime(received, '24h', { year: 'numeric', month: 'short', day: 'numeric' })).toContain('23:00');
  });

  it.each(['smart', 'relative', 'full'] as const)('formatDate returns "" for an invalid date in %s mode (#1099)', (dateFormat) => {
    useSettingsStore.setState({ timeZone: 'Asia/Tokyo', dateFormat });
    expect(formatDate('not-a-valid-date')).toBe('');
    expect(formatDate('10000-01-01T00:00:00Z')).toBe('');
    expect(formatDate(new Date('nope'))).toBe('');
    expect(formatDate(undefined as unknown as string)).toBe('');
  });
});
