import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { formatDate } from '../utils';
import { useSettingsStore } from '@/stores/settings-store';

// mail-p2-10: on Wednesday Nov 4 at 10:40, a mail from Wednesday Oct 28 at
// 17:40 read "Wed 17:40", as if it came later today. The weekday names only
// the last six calendar days; older mail shows its date.

describe('formatDate weekday window', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-11-04T09:40:00Z')); // Wed 10:40 in Berlin
    useSettingsStore.setState({ dateFormat: 'smart', timeFormat: '24h', dateLocale: 'auto', timeZone: 'Europe/Berlin' });
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('gives a mail from the same weekday last week its date, not the weekday', () => {
    expect(formatDate(new Date('2026-10-28T16:40:00Z'))).toBe('Oct 28');
  });

  it('keeps the weekday for the last six calendar days', () => {
    expect(formatDate(new Date('2026-10-29T16:40:00Z'))).toBe('Thu 17:40');
    expect(formatDate(new Date('2026-11-03T22:40:00Z'))).toBe('Tue 23:40');
  });

  it('counts days in the display zone, not 24-hour periods', () => {
    // Late on Oct 28 in Berlin is less than seven 24-hour periods ago but
    // still last Wednesday.
    expect(formatDate(new Date('2026-10-28T22:30:00Z'))).toBe('Oct 28');
  });
});
