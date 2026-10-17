import { describe, it, expect, afterEach } from 'vitest';
import { formatRelativeAgo } from '../utils';
import { AUTO_TIME_ZONE } from '../timezone';
import { useSettingsStore } from '@/stores/settings-store';

describe('formatRelativeAgo', () => {
  const now = new Date('2026-07-01T12:00:00Z');

  afterEach(() => {
    useSettingsStore.setState({ timeZone: AUTO_TIME_ZONE });
  });

  it('says how long ago in the largest whole unit', () => {
    expect(formatRelativeAgo(new Date('2026-07-01T11:57:00Z'), now)).toBe('3 minutes ago');
    expect(formatRelativeAgo(new Date('2026-07-01T08:00:00Z'), now)).toBe('4 hours ago');
    expect(formatRelativeAgo(new Date('2026-06-29T12:00:00Z'), now)).toBe('2 days ago');
  });

  it('says nothing once the message is a month old, or when the date is bad', () => {
    expect(formatRelativeAgo(new Date('2026-05-01T12:00:00Z'), now)).toBe('');
    expect(formatRelativeAgo('not a date', now)).toBe('');
  });

  it('counts calendar days in the effective time zone (#1259)', () => {
    useSettingsStore.setState({ timeZone: 'America/Denver' });
    // 16 Oct, 10:00 in Denver.
    const denverNow = new Date('2026-10-16T16:00:00Z');
    // 14 Oct, 20:51 in Denver: only 37 hours ago, but two days back.
    expect(formatRelativeAgo(new Date('2026-10-15T02:51:30Z'), denverNow)).toBe('2 days ago');
    // 15 Oct, 08:00 in Denver: 26 hours ago, and yesterday.
    expect(formatRelativeAgo(new Date('2026-10-15T14:00:00Z'), denverNow)).toBe('yesterday');
    // Under a day still reads in hours, even across midnight.
    expect(formatRelativeAgo(new Date('2026-10-15T23:00:00Z'), denverNow)).toBe('17 hours ago');
  });
});
