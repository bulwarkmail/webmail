import { describe, expect, it } from 'vitest';
import table from '../data/airport-timezones.json';
import {
  countryZone,
  fixedOffsetZone,
  isValidTimeZone,
  loadAirportZones,
  resolveZone,
  wallClockAt,
  zonedTimeToUtc,
  zoneOffsetAt,
} from '../time-zones';

const utc = (iso: string) => Date.parse(iso);

describe('airport time zone table', () => {
  it('maps IATA codes to their IANA zones', async () => {
    const zoneOf = await loadAirportZones();
    expect(zoneOf('FRA')).toBe('Europe/Berlin');
    expect(zoneOf('JFK')).toBe('America/New_York');
    expect(zoneOf('SFO')).toBe('America/Los_Angeles');
    expect(zoneOf('NRT')).toBe('Asia/Tokyo');
    expect(zoneOf('HNL')).toBe('Pacific/Honolulu');
    expect(zoneOf('syd')).toBe('Australia/Sydney');
  });

  it('knows nothing about codes it does not have', async () => {
    const zoneOf = await loadAirportZones();
    expect(zoneOf('QQQ')).toBeUndefined();
    expect(zoneOf('FRAX')).toBeUndefined();
    expect(zoneOf(undefined)).toBeUndefined();
  });

  it('holds only valid zone names and indexes inside the zone list', () => {
    expect(Object.keys(table.airports).length).toBeGreaterThan(7000);
    for (const zone of table.zones) expect(isValidTimeZone(zone), zone).toBe(true);
    for (const index of Object.values(table.airports)) {
      expect(index).toBeGreaterThanOrEqual(0);
      expect(index).toBeLessThan(table.zones.length);
    }
  });
});

describe('fixedOffsetZone', () => {
  it('inverts the sign for whole hours', () => {
    expect(fixedOffsetZone(-8 * 60)).toBe('Etc/GMT+8');
    expect(fixedOffsetZone(5 * 60)).toBe('Etc/GMT-5');
    expect(fixedOffsetZone(14 * 60)).toBe('Etc/GMT-14');
    expect(fixedOffsetZone(-12 * 60)).toBe('Etc/GMT+12');
  });

  it('keeps the UTC instant for half hours and offsets without an Etc zone', () => {
    expect(fixedOffsetZone(0)).toBe('Etc/UTC');
    expect(fixedOffsetZone(330)).toBe('Etc/UTC');
    expect(fixedOffsetZone(345)).toBe('Etc/UTC');
    expect(fixedOffsetZone(-13 * 60)).toBe('Etc/UTC');
  });

  it('produces zones whose offset is the one asked for', () => {
    for (const hours of [-12, -8, -1, 1, 5, 9, 14]) {
      const zone = fixedOffsetZone(hours * 60);
      expect(zoneOffsetAt(zone, utc('2026-07-01T00:00:00Z'))).toBe(hours * 60);
    }
  });
});

describe('zoneOffsetAt and wall clocks', () => {
  it('follows DST', () => {
    expect(zoneOffsetAt('Europe/Berlin', utc('2026-01-15T12:00:00Z'))).toBe(60);
    expect(zoneOffsetAt('Europe/Berlin', utc('2026-07-15T12:00:00Z'))).toBe(120);
    expect(zoneOffsetAt('America/Los_Angeles', utc('2027-03-05T04:15:00Z'))).toBe(-480);
    expect(zoneOffsetAt('Asia/Kathmandu', utc('2026-07-15T12:00:00Z'))).toBe(345);
  });

  it('turns an instant into the local date and time across the date line', () => {
    expect(wallClockAt(utc('2027-03-05T04:15:00Z'), 'America/Los_Angeles')).toEqual({ date: '2027-03-04', time: '20:15:00' });
    expect(wallClockAt(utc('2026-12-01T00:30:00Z'), 'Asia/Tokyo')).toEqual({ date: '2026-12-01', time: '09:30:00' });
    expect(wallClockAt(utc('2026-12-01T00:30:00Z'), 'Pacific/Honolulu')).toEqual({ date: '2026-11-30', time: '14:30:00' });
  });

  it('turns a local time back into the instant, and refuses DST gaps and overlaps', () => {
    expect(zonedTimeToUtc('2027-03-04', '20:15', 'America/Los_Angeles')).toBe(utc('2027-03-05T04:15:00Z'));
    expect(zonedTimeToUtc('2026-12-01', '09:30:00', 'Asia/Tokyo')).toBe(utc('2026-12-01T00:30:00Z'));
    // 02:30 on 29 March 2026 doesn't exist in Berlin; 02:30 on 25 October happens twice.
    expect(zonedTimeToUtc('2026-03-29', '02:30', 'Europe/Berlin')).toBeNull();
    expect(zonedTimeToUtc('2026-10-25', '02:30', 'Europe/Berlin')).toBeNull();
    expect(zonedTimeToUtc('2026-13-01', '10:00', 'Europe/Berlin')).toBeNull();
  });
});

describe('countryZone', () => {
  it('names the zone of single-zone countries only', () => {
    expect(countryZone('DE')).toBe('Europe/Berlin');
    expect(countryZone(' de ')).toBe('Europe/Berlin');
    expect(countryZone('US')).toBeUndefined();
    expect(countryZone('ES')).toBeUndefined();
    expect(countryZone('Germany')).toBeUndefined();
  });

  it('does not trust France for a time without an offset', () => {
    expect(countryZone('FR')).toBe('Europe/Paris');
    expect(countryZone('FR', { floating: true })).toBeUndefined();
  });
});

describe('resolveZone', () => {
  const at = utc('2026-06-04T09:44:00Z');

  it('accepts a named zone that agrees with the offset', () => {
    expect(resolveZone({ named: { zone: 'Europe/Berlin', source: 'country' }, offsetMinutes: 120, utcMs: at }))
      .toEqual({ zone: 'Europe/Berlin', source: 'country' });
  });

  it('reports a mismatch when table and mail disagree', () => {
    expect(resolveZone({ named: { zone: 'Europe/Berlin', source: 'airport' }, offsetMinutes: 60, utcMs: at })).toBe('mismatch');
  });

  it('falls back to a fixed offset, then to UTC, without a named zone', () => {
    expect(resolveZone({ offsetMinutes: -480, utcMs: at })).toEqual({ zone: 'Etc/GMT+8', source: 'offset' });
    expect(resolveZone({ offsetMinutes: 330, utcMs: at })).toEqual({ zone: 'Etc/UTC', source: 'utc' });
  });

  it('reads a time without offset in the named zone, or leaves it floating', () => {
    expect(resolveZone({ named: { zone: 'Asia/Tokyo', source: 'airport' } })).toEqual({ zone: 'Asia/Tokyo', source: 'airport' });
    expect(resolveZone({})).toEqual({ zone: null, source: 'floating' });
  });
});
