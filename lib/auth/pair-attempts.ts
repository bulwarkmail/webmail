// Failed password step-ups for "Link mobile app", per mail account.
//
// The step-up checks the typed password against the mail server from this
// server's address. Stalwart bans an address after too many failed logins
// (100 a day per IP or login name) - across the whole server - so a signed-in
// session must not be able to guess passwords through the webmail and get it
// banned for everyone. A handful of mistakes is plenty for a person: 5 in 15
// minutes, and 20 a day, well below the ban.
//
// The key is the account on its server, not the browser's cookie slot, which
// the client chooses. An attempt counts as a failure from the moment it
// starts, and is given back only once it turns out not to have been a wrong
// credential: otherwise parallel requests would all pass the check before the
// first one failed.
//
// One process keeps the counts in memory, as always. With a shared store
// (#1066) they are counters there, so every replica counts the same attempts;
// when the store is down every function rejects with StoreUnavailableError
// and the step-up is refused.

import { createHash } from 'node:crypto';
import { getStore, isSharedMode } from '@/lib/shared-store';

const MAX_FAILURES = 5;
const WINDOW_MS = 15 * 60 * 1000;
const MAX_DAILY_FAILURES = 20;
const DAY_MS = 24 * 60 * 60 * 1000;
const STORE_KEY = '__bulwarkPairAttempts';

interface Entry {
  failures: number;
  windowStart: number;
  daily: number;
  dayStart: number;
}

function store(): Map<string, Entry> {
  const g = globalThis as typeof globalThis & { [STORE_KEY]?: Map<string, Entry> };
  if (!g[STORE_KEY]) g[STORE_KEY] = new Map();
  return g[STORE_KEY];
}

/** The limiter key for an account: its server and login name. */
export function pairAttemptKey(serverUrl: string, accountName: string): string {
  return `${serverUrl.replace(/\/+$/, '').toLowerCase()}|${accountName.trim().toLowerCase()}`;
}

function live(key: string, now: number): Entry | null {
  const entry = store().get(key);
  if (!entry) return null;
  if (now - entry.dayStart >= DAY_MS) {
    store().delete(key);
    return null;
  }
  if (now - entry.windowStart >= WINDOW_MS) {
    entry.failures = 0;
    entry.windowStart = now;
  }
  return entry;
}

// ─── shared store ──────────────────────────────────────────────────────────

/** The two counters of an account; the key itself holds a login name, so it is hashed. */
function sharedLimits(key: string) {
  const id = createHash('sha256').update(key).digest('base64url');
  return [
    { key: `pair-attempts:window:${id}`, max: MAX_FAILURES, windowMs: WINDOW_MS },
    { key: `pair-attempts:day:${id}`, max: MAX_DAILY_FAILURES, windowMs: DAY_MS },
  ];
}

// ─── API ───────────────────────────────────────────────────────────────────

export async function isPairStepUpLocked(key: string, now = Date.now()): Promise<boolean> {
  if (isSharedMode()) {
    const limits = sharedLimits(key);
    const counts = await Promise.all(limits.map((limit) => getStore().counters.get(limit.key, now)));
    return limits.some((limit, i) => (counts[i]?.count ?? 0) >= limit.max);
  }
  return isLockedLocal(key, now);
}

export async function recordPairStepUpFailure(key: string, now = Date.now()): Promise<void> {
  if (isSharedMode()) {
    await getStore().counters.reserve(sharedLimits(key).map((limit) => ({ ...limit, max: Infinity })), now);
    return;
  }
  recordFailureLocal(key, now);
}

function isLockedLocal(key: string, now: number): boolean {
  const entry = live(key, now);
  return !!entry && (entry.failures >= MAX_FAILURES || entry.daily >= MAX_DAILY_FAILURES);
}

function recordFailureLocal(key: string, now: number): void {
  const entry = live(key, now);
  if (entry) {
    entry.failures += 1;
    entry.daily += 1;
  } else {
    store().set(key, { failures: 1, windowStart: now, daily: 1, dayStart: now });
  }
  // Bound the map: drop entries whose day ran out.
  for (const [k, e] of store()) {
    if (now - e.dayStart >= DAY_MS) store().delete(k);
  }
}

/**
 * Start a step-up: false when the account is locked out, otherwise the
 * attempt is counted as a failure until {@link settlePairStepUp} says better.
 */
export async function beginPairStepUp(key: string, now = Date.now()): Promise<boolean> {
  return (await reservePairStepUp(key, now)) !== null;
}

/** A counted step-up attempt: which windows it was counted in (shared store). */
export interface PairStepUpTicket {
  resetAts?: number[];
}

/**
 * {@link beginPairStepUp}, returning the attempt (null when locked out), so
 * {@link settlePairStepUp} gives it back only to the windows it was counted in.
 */
export async function reservePairStepUp(key: string, now = Date.now()): Promise<PairStepUpTicket | null> {
  if (isSharedMode()) {
    // Check and count in one step, so parallel attempts on several replicas
    // can't all pass before the first one is counted.
    const result = await getStore().counters.reserve(sharedLimits(key), now);
    return result.ok ? { resetAts: result.resetAts } : null;
  }
  // Check and count with nothing in between, as parallel requests would
  // otherwise all pass the check.
  if (isLockedLocal(key, now)) return null;
  recordFailureLocal(key, now);
  return {};
}

/**
 * Finish a step-up begun with {@link beginPairStepUp}: a success clears the
 * count, a wrong credential keeps its failure, anything else (the server was
 * unreachable, pairing is unavailable) gives the attempt back.
 */
export async function settlePairStepUp(
  key: string,
  outcome: 'success' | 'wrong_credential' | 'other',
  now = Date.now(),
  ticket?: PairStepUpTicket,
): Promise<void> {
  if (outcome === 'success') {
    await clearPairStepUpFailures(key);
    return;
  }
  if (outcome === 'other') {
    if (isSharedMode()) {
      // A window that has reset since the attempt was counted is left alone.
      await getStore().counters.refund(sharedLimits(key).map((limit, i) => ({ key: limit.key, resetAt: ticket?.resetAts?.[i] })), now);
      return;
    }
    const entry = store().get(key);
    if (entry) {
      entry.failures = Math.max(0, entry.failures - 1);
      entry.daily = Math.max(0, entry.daily - 1);
    }
  }
}

export async function clearPairStepUpFailures(key: string): Promise<void> {
  if (isSharedMode()) {
    await Promise.all(sharedLimits(key).map((limit) => getStore().counters.reset(limit.key)));
    return;
  }
  store().delete(key);
}
