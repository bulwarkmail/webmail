import { describe, expect, it } from 'vitest';
import type { Email, ThreadGroup } from '@/lib/jmap/types';
import { listDateGroup, listDateGroupLabel, sectionThreadsByDate, threadGroupDate } from '@/lib/list-date-groups';

// Thursday, 12 November 2026, midday in Berlin.
const NOW = new Date('2026-11-12T11:00:00Z');
const TZ = 'Europe/Berlin';

/** Noon in Berlin, `days` calendar days before 12 November 2026 (or the given date). */
const daysAgo = (days: number) => new Date(Date.UTC(2026, 10, 12 - days, 11));

describe('listDateGroup', () => {
  it.each([
    [0, 'today'],
    [1, 'yesterday'],
    [2, 'weekday-2'], // Tuesday
    [6, 'weekday-5'], // Friday
    [7, 'last_week'],
    [13, 'last_week'],
    [14, 'last_month'],
    [20, 'last_month'],
    [31, 'last_month'], // 12 October
    [32, 'older'], // 11 October
  ])('puts %i days ago under %s', (days, group) => {
    expect(listDateGroup(daysAgo(days), NOW, TZ)).toBe(group);
  });

  it('puts a date in the future under Today', () => {
    expect(listDateGroup(new Date('2026-11-20T08:00:00Z'), NOW, TZ)).toBe('today');
  });

  it('compares the days of the time zone, not of UTC', () => {
    // 23:30 UTC on 11 November is already 12 November in Berlin.
    expect(listDateGroup('2026-11-11T23:30:00Z', NOW, TZ)).toBe('today');
    expect(listDateGroup('2026-11-11T23:30:00Z', NOW, 'UTC')).toBe('yesterday');
    // Shortly after midnight in Tokyo it is 13 November there, so 12 November is yesterday.
    expect(listDateGroup('2026-11-12T01:00:00Z', new Date('2026-11-12T15:30:00Z'), 'Asia/Tokyo')).toBe('yesterday');
  });

  it('clamps one month back to the last day of a shorter month', () => {
    const now = new Date('2026-03-31T10:00:00Z');
    expect(listDateGroup('2026-02-28T10:00:00Z', now, 'UTC')).toBe('last_month');
    expect(listDateGroup('2026-02-27T10:00:00Z', now, 'UTC')).toBe('older');
  });

  it('reaches back into the year before in January', () => {
    const now = new Date('2026-01-20T10:00:00Z');
    expect(listDateGroup('2025-12-20T10:00:00Z', now, 'UTC')).toBe('last_month');
    expect(listDateGroup('2025-12-19T10:00:00Z', now, 'UTC')).toBe('older');
  });
});

describe('listDateGroupLabel', () => {
  const t = (key: string) => `t:${key}`;

  it('names weekdays in the locale, capitalised', () => {
    expect(listDateGroupLabel('weekday-1', t, 'en-US')).toBe('Monday');
    expect(listDateGroupLabel('weekday-1', t, 'de')).toBe('Montag');
    expect(listDateGroupLabel('weekday-0', t, 'fr')).toBe('Dimanche');
  });

  it('looks the other groups up', () => {
    expect(listDateGroupLabel('last_week', t, 'en-US')).toBe('t:date_groups.last_week');
    expect(listDateGroupLabel('pinned', t, 'en-US')).toBe('t:pinned');
  });
});

function thread(id: string, dates: string[], hasPinned = false): ThreadGroup {
  const emails = dates.map((receivedAt, i) => ({ id: `${id}-${i}`, threadId: id, receivedAt }) as Email);
  const latestEmail = [...emails].sort((a, b) => Date.parse(b.receivedAt) - Date.parse(a.receivedAt))[0];
  return { threadId: id, threadKey: id, emails, latestEmail, hasPinned } as unknown as ThreadGroup;
}

describe('threadGroupDate', () => {
  it('takes the newest message newest first and the oldest oldest first', () => {
    const t = thread('a', ['2026-11-12T08:00:00Z', '2026-11-01T08:00:00Z']);
    expect(threadGroupDate(t, false)).toBe('2026-11-12T08:00:00Z');
    expect(threadGroupDate(t, true)).toBe('2026-11-01T08:00:00Z');
  });
});

describe('sectionThreadsByDate', () => {
  it('starts a section where the group changes, pinned threads first', () => {
    const threads = [
      thread('pin', ['2026-10-01T08:00:00Z'], true),
      thread('a', [daysAgo(0).toISOString()]),
      thread('b', [daysAgo(0).toISOString()]),
      thread('c', [daysAgo(1).toISOString()]),
      thread('d', [daysAgo(60).toISOString()]),
    ];
    const sections = sectionThreadsByDate(threads, { now: NOW, timeZone: TZ, oldestFirst: false });
    expect(sections.map((s) => [s.key, s.threads.map((x) => x.threadKey)])).toEqual([
      ['pinned', ['pin']],
      ['today', ['a', 'b']],
      ['yesterday', ['c']],
      ['older', ['d']],
    ]);
  });

  it('places oldest first by the earliest message', () => {
    const threads = [
      thread('a', [daysAgo(60).toISOString(), daysAgo(0).toISOString()]),
      thread('b', [daysAgo(1).toISOString()]),
    ];
    const sections = sectionThreadsByDate(threads, { now: NOW, timeZone: TZ, oldestFirst: true });
    expect(sections.map((s) => s.key)).toEqual(['older', 'yesterday']);
  });
});
