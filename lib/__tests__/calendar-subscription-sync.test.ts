import { describe, it, expect } from 'vitest';
import {
  mergeSyncedSubscriptions,
  parseSyncedSubscriptions,
  parseSubscriptionTombstones,
  SUBSCRIPTION_TOMBSTONE_TTL_MS,
} from '../calendar-subscription-sync';
import type { ICalSubscription } from '@/stores/calendar-store';

function makeSubscription(overrides: Partial<ICalSubscription> = {}): ICalSubscription {
  return {
    id: 'sub-test-id',
    url: 'https://example.com/calendar.ics',
    calendarId: 'cal-123',
    name: 'Test Subscription',
    color: '#3b82f6',
    refreshInterval: 60,
    lastRefreshed: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z',
    ...overrides,
  };
}

const NOW = new Date('2026-03-01T00:00:00Z');

describe('parseSyncedSubscriptions', () => {
  it('returns null for non-array values (pre-sync build)', () => {
    expect(parseSyncedSubscriptions(undefined)).toBeNull();
    expect(parseSyncedSubscriptions({ not: 'an array' })).toBeNull();
  });

  it('preserves valid subscriptions and normalizes webcal URLs', () => {
    const result = parseSyncedSubscriptions([
      makeSubscription({ id: 'sub-1', url: 'webcal://example.com/feed.ics' }),
    ]);
    expect(result).toHaveLength(1);
    expect(result![0].id).toBe('sub-1');
    expect(result![0].url).toBe('https://example.com/feed.ics');
    expect(result![0].updatedAt).toBe('2026-01-01T00:00:00Z');
  });

  it('drops entries without required fields or duplicate ids', () => {
    const result = parseSyncedSubscriptions([
      makeSubscription({ id: 'a' }),
      makeSubscription({ id: 'a', name: 'Duplicate' }),
      { ...makeSubscription(), id: undefined },
      { ...makeSubscription(), url: '' },
      { ...makeSubscription(), calendarId: '' },
      { ...makeSubscription(), name: '   ' },
      'invalid string entry',
    ]);
    expect(result!.map((s) => s.id)).toEqual(['a']);
  });
});

describe('parseSubscriptionTombstones', () => {
  it('returns empty record for non-record values', () => {
    expect(parseSubscriptionTombstones(undefined)).toEqual({});
    expect(parseSubscriptionTombstones(['a'])).toEqual({});
  });

  it('drops invalid date values', () => {
    expect(
      parseSubscriptionTombstones({ a: '2026-01-02T00:00:00Z', b: 'invalid', c: 123 })
    ).toEqual({ a: '2026-01-02T00:00:00Z' });
  });
});

describe('mergeSyncedSubscriptions', () => {
  it('adds subscriptions present in incoming state', () => {
    const merged = mergeSyncedSubscriptions(
      { icalSubscriptions: [makeSubscription({ id: 'local' })], deletedSubscriptionIds: {} },
      { icalSubscriptions: [makeSubscription({ id: 'remote' })], deletedSubscriptionIds: {} },
      NOW
    );
    expect(merged.icalSubscriptions.map((s) => s.id).sort()).toEqual(['local', 'remote']);
  });

  it('keeps newer copy per id, preferring local on tie', () => {
    const merged = mergeSyncedSubscriptions(
      {
        icalSubscriptions: [
          makeSubscription({ id: 'a', name: 'Local newer', updatedAt: '2026-02-01T00:00:00Z' }),
          makeSubscription({ id: 'b', name: 'Local tie' }),
        ],
        deletedSubscriptionIds: {},
      },
      {
        icalSubscriptions: [
          makeSubscription({ id: 'a', name: 'Remote older', updatedAt: '2026-01-15T00:00:00Z' }),
          makeSubscription({ id: 'b', name: 'Remote tie' }),
        ],
        deletedSubscriptionIds: {},
      },
      NOW
    );
    const byId = Object.fromEntries(merged.icalSubscriptions.map((s) => [s.id, s.name]));
    expect(byId).toEqual({ a: 'Local newer', b: 'Local tie' });
  });

  it('applies incoming tombstone to local subscription', () => {
    const merged = mergeSyncedSubscriptions(
      { icalSubscriptions: [makeSubscription({ id: 'a' })], deletedSubscriptionIds: {} },
      { icalSubscriptions: [], deletedSubscriptionIds: { a: '2026-02-01T00:00:00Z' } },
      NOW
    );
    expect(merged.icalSubscriptions).toEqual([]);
    expect(merged.deletedSubscriptionIds).toEqual({ a: '2026-02-01T00:00:00Z' });
  });

  it('resurrects subscription edited after its deletion and clears tombstone', () => {
    const merged = mergeSyncedSubscriptions(
      {
        icalSubscriptions: [makeSubscription({ id: 'a', updatedAt: '2026-03-01T00:00:00Z' })],
        deletedSubscriptionIds: {},
      },
      { icalSubscriptions: [], deletedSubscriptionIds: { a: '2026-02-01T00:00:00Z' } },
      NOW
    );
    expect(merged.icalSubscriptions.map((s) => s.id)).toEqual(['a']);
    expect(merged.deletedSubscriptionIds).toEqual({});
  });

  it('prunes tombstones older than TTL', () => {
    const expired = new Date(NOW.getTime() - SUBSCRIPTION_TOMBSTONE_TTL_MS - 1000).toISOString();
    const merged = mergeSyncedSubscriptions(
      { icalSubscriptions: [], deletedSubscriptionIds: { old: expired } },
      { icalSubscriptions: [], deletedSubscriptionIds: {} },
      NOW
    );
    expect(merged.deletedSubscriptionIds).toEqual({});
  });
});
