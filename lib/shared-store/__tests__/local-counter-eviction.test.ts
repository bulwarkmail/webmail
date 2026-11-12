// @vitest-environment node
/**
 * Without REDIS_URL every limit that goes through `getStore().counters` lives
 * in one map of at most 50,000 counters, and short-lived values in the kv map.
 * A flood of new keys (one counter per client address, from routes that need
 * no session) must not make the store forget a live counter: the admin
 * sign-in ceiling across all clients is one of the oldest keys, and it exists
 * for exactly the client that rotates addresses. So a full store drops only
 * expired entries and refuses new ones until some expire.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { checkRateLimit } from '@/lib/admin/rate-limit';
import { getStore, isStoreUnavailableError, setStoreForTests } from '@/lib/shared-store';
import { resetLocalStoreForTests } from '@/lib/shared-store/local';
import { createFailureBudget } from '@/lib/auth/verify-budget';

const FULL = 50_000;

/** What 50,000 POST /api/devices from distinct addresses do (one 60-second counter each). */
async function floodCounters(now = Date.now(), windowMs = 60_000) {
  const counters = getStore().counters;
  for (let i = 0; i < FULL; i++) {
    await counters.reserve([{ key: `device-checkin:2001:db8::c:${i.toString(16)}`, max: 20, windowMs }], now);
  }
}

describe('local counters under a flood of other keys', () => {
  beforeEach(() => {
    delete process.env.REDIS_URL;
    delete process.env.REDIS_URL_FILE;
    setStoreForTests(null);
    resetLocalStoreForTests();
  });
  afterEach(() => resetLocalStoreForTests());

  it('keeps the admin sign-in ceiling when 50,000 other clients show up', async () => {
    // Use up the ceiling: 50 wrong passwords, each from another address (5 per address are allowed).
    for (let i = 0; i < 50; i++) {
      expect((await checkRateLimit(`2001:db8::a:${i.toString(16)}`)).allowed).toBe(true);
    }
    expect((await checkRateLimit('2001:db8::b:1')).allowed).toBe(false);

    await floodCounters();

    // The window has not ended, so the ceiling must still hold.
    expect((await checkRateLimit('2001:db8::b:2')).allowed).toBe(false);
  }, 60_000);

  it('refuses a new key while full of live counters, and keeps counting the existing ones', async () => {
    const counters = getStore().counters;
    const now = Date.now();
    const before = await counters.reserve([{ key: 'early:client', max: 3, windowMs: 15 * 60_000 }], now);
    expect(before.ok).toBe(true);
    await floodCounters(now);

    const fresh = await counters.reserve([{ key: 'late:client', max: 3, windowMs: 60_000 }], now + 1000);
    expect(fresh.ok).toBe(false);
    expect(fresh.retryAfterMs).toBeGreaterThan(0);
    expect(await counters.get('late:client', now + 1000)).toBeNull();

    const again = await counters.reserve([{ key: 'early:client', max: 3, windowMs: 15 * 60_000 }], now + 1000);
    expect(again).toMatchObject({ ok: true, counts: [2] });
  }, 60_000);

  it('makes room again once counters expire while it is full', async () => {
    const counters = getStore().counters;
    const now = Date.now();
    await floodCounters(now, 60_000);
    expect((await counters.reserve([{ key: 'late:client', max: 3, windowMs: 60_000 }], now + 30_000)).ok).toBe(false);
    const later = await counters.reserve([{ key: 'late:client', max: 3, windowMs: 60_000 }], now + 61_000);
    expect(later).toMatchObject({ ok: true, counts: [1] });
  }, 60_000);

  it('answers a hit on a new key while full with a count over any limit, and stores nothing', async () => {
    const counters = getStore().counters;
    const now = Date.now();
    await floodCounters(now);
    const hit = await counters.hit('late:failures', 60_000, now);
    expect(hit.count).toBeGreaterThan(1_000_000);
    expect(await counters.get('late:failures', now)).toBeNull();
  }, 60_000);
});

describe('local kv under a flood of keys', () => {
  beforeEach(() => {
    setStoreForTests(null);
    resetLocalStoreForTests();
  });
  afterEach(() => resetLocalStoreForTests());

  it('holds at most 50,000 live entries, keeps the ones it has, and makes room as they expire', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      const kv = getStore().kv;
      for (let i = 0; i < FULL; i++) await kv.set(`flood:${i}`, 'x', { ttlMs: 60_000 });

      const error = await kv.set('late:entry', 'y', { ttlMs: 60_000 }).catch((e: unknown) => e);
      expect(isStoreUnavailableError(error)).toBe(true);
      expect(await kv.get('late:entry')).toBeNull();
      // An entry it holds can still change.
      expect(await kv.set('flood:7', 'changed', { ttlMs: 120_000 })).toBe(true);
      expect(await kv.get('flood:7')).toBe('changed');

      vi.setSystemTime(Date.now() + 61_000);
      expect(await kv.set('late:entry', 'y', { ttlMs: 60_000 })).toBe(true);
      expect(await kv.get('late:entry')).toBe('y');
      expect(await kv.get('flood:7')).toBe('changed');
    } finally {
      vi.useRealTimers();
    }
  }, 60_000);
});

describe('sign-in budgets under a flood of clients', () => {
  // Their client map holds 10,000 and drops the oldest when full of live
  // windows, but the ceiling across clients is counted apart and holds.
  it('keeps the ceiling across clients when more clients show up than the map holds', async () => {
    setStoreForTests(null);
    const budget = createFailureBudget({ name: 'flood-test', clientMax: 5, globalMax: 30 });
    const now = Date.now();
    let granted = 0;
    for (let i = 0; i < 12_000; i++) if (await budget.reserve(`2001:db8::d:${i.toString(16)}`, now)) granted++;
    expect(granted).toBe(30);
    expect(await budget.reserve('2001:db8::e:1', now)).toBeNull();
  }, 60_000);
});
