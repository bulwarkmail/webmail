import { describe, expect, it } from 'vitest';
import { parseTypedOffset, timeZoneChoices, timeZoneCity, timeZoneSearchRank } from '../time-zone-choices';

const JAN = new Date(Date.UTC(2026, 0, 15, 12));

describe('time zone choices', () => {
  it('names zones by their current city', () => {
    expect(timeZoneCity('Asia/Calcutta')).toBe('Kolkata');
    expect(timeZoneCity('Europe/Kiev')).toBe('Kyiv');
    expect(timeZoneCity('Asia/Saigon')).toBe('Ho Chi Minh City');
    expect(timeZoneCity('America/Argentina/La_Rioja')).toBe('La Rioja, Argentina');
    expect(timeZoneCity('America/New_York')).toBe('New York');
  });

  it('sorts all zones by offset, then city, and gives the offset', () => {
    const { all } = timeZoneChoices(['Europe/Berlin', 'America/New_York', 'Asia/Tokyo', 'Europe/Paris', 'UTC'], { now: JAN });
    expect(all.map((c) => `${c.city} ${c.offset}`)).toEqual([
      'New York GMT-05:00',
      'UTC GMT',
      'Berlin GMT+01:00',
      'Paris GMT+01:00',
      'Tokyo GMT+09:00',
    ]);
  });

  it('puts the common zones first, found under their runtime ids', () => {
    const { common } = timeZoneChoices(['Asia/Calcutta', 'Europe/Berlin', 'Pacific/Fiji'], { now: JAN });
    expect(common.map((c) => c.value)).toEqual(['Europe/Berlin', 'Asia/Calcutta']);
  });

  it('shows one entry for two ids of the same city, keeping the stored one', () => {
    const { all } = timeZoneChoices(['Asia/Calcutta', 'Asia/Kolkata'], { now: JAN, extra: ['Asia/Kolkata'] });
    expect(all.map((c) => c.value)).toEqual(['Asia/Kolkata']);
  });

  it('keeps a stored zone the runtime does not list', () => {
    const { all } = timeZoneChoices(['Europe/Berlin'], { now: JAN, extra: ['America/Ciudad_Juarez'] });
    expect(all.map((c) => c.value)).toContain('America/Ciudad_Juarez');
  });
});

describe('time zone search', () => {
  it('reads offsets as people type them', () => {
    expect(parseTypedOffset('GMT+1')).toBe(60);
    expect(parseTypedOffset('utc-5')).toBe(-300);
    expect(parseTypedOffset('+05:30')).toBe(330);
    expect(parseTypedOffset('-0800')).toBe(-480);
    expect(parseTypedOffset('Berlin')).toBeNull();
    expect(parseTypedOffset('GMT')).toBeNull();
  });

  it('puts the zones of an abbreviation and the exact offset first', () => {
    expect(timeZoneSearchRank('CET', { value: 'Europe/Berlin', offsetMinutes: 60 }, false)).toBe(0);
    expect(timeZoneSearchRank('cest', { value: 'Europe/Paris', offsetMinutes: 120 }, false)).toBe(0);
    expect(timeZoneSearchRank('CET', { value: 'Asia/Tokyo', offsetMinutes: 540 }, false)).toBeNull();
    expect(timeZoneSearchRank('GMT+1', { value: 'Europe/Berlin', offsetMinutes: 60 }, true)).toBe(0);
    expect(timeZoneSearchRank('GMT+1', { value: 'Australia/Sydney', offsetMinutes: 660 }, true)).toBe(2);
    expect(timeZoneSearchRank('Berlin', { value: 'Europe/Berlin', offsetMinutes: 60 }, true)).toBe(1);
  });
});
