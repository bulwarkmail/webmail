// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/logger', () => ({
  logger: { warn: vi.fn(), error: vi.fn(), debug: vi.fn(), info: vi.fn() },
}));

import { setStoreForTests } from '@/lib/shared-store';
import { resetLocalStoreForTests } from '@/lib/shared-store/local';
import { switchableSharedStore } from './helpers/shared-store-down';

// With several replicas behind a load balancer every sign-in limit lived in
// one process's memory: each replica granted its own five wrong passwords,
// its own 30 pre-checks and its own pair step-ups (#1066). With a shared
// store they are counted once for the whole deployment.

const T0 = 1_800_000_000_000;
const CLIENT = '198.51.100.7';
let store: ReturnType<typeof switchableSharedStore>;

/**
 * Another replica: a fresh copy of the module, and none of the process
 * state the auth stores pin on globalThis (only the store itself is shared).
 */
async function replica<T>(load: () => Promise<T>): Promise<T> {
  vi.resetModules();
  const g = globalThis as Record<string, unknown>;
  delete g.__bulwarkPairAttempts;
  delete g.__bulwarkMobileHandoffStore;
  return load();
}
const budgets = () => replica(() => import('@/lib/auth/verify-budget'));
const attempts = () => replica(() => import('@/lib/auth/pair-attempts'));
const handoff = () => replica(() => import('@/lib/auth/handoff-store'));

beforeEach(() => {
  resetLocalStoreForTests();
  store = switchableSharedStore();
  setStoreForTests(store);
});

afterEach(() => {
  setStoreForTests(null);
  resetLocalStoreForTests();
});

describe('sign-in budgets with a shared store', () => {
  it('counts login failures of one client across replicas', async () => {
    const a = await budgets();
    for (let i = 0; i < 3; i++) expect(await a.reserveLoginAttempt(CLIENT, T0)).not.toBeNull();
    const b = await budgets();
    for (let i = 0; i < 2; i++) expect(await b.reserveLoginAttempt(CLIENT, T0)).not.toBeNull();
    const c = await budgets();
    expect(await c.reserveLoginAttempt(CLIENT, T0)).toBeNull();
    // Another client has its own budget, and the window still ends.
    expect(await c.reserveLoginAttempt('198.51.100.8', T0)).not.toBeNull();
    expect(await c.reserveLoginAttempt(CLIENT, T0 + 15 * 60 * 1000)).not.toBeNull();
  });

  it('does not count a refused attempt, and a refund on one replica frees a try on another', async () => {
    const a = await budgets();
    const refunds = [];
    for (let i = 0; i < 5; i++) refunds.push(await a.reserveLoginAttempt(CLIENT, T0));
    const b = await budgets();
    expect(await b.reserveLoginAttempt(CLIENT, T0)).toBeNull();
    expect(await b.reserveLoginAttempt(CLIENT, T0)).toBeNull();
    await refunds[0]!();
    await refunds[0]!(); // refunds once only
    const c = await budgets();
    expect(await c.reserveLoginAttempt(CLIENT, T0)).not.toBeNull();
    expect(await c.reserveLoginAttempt(CLIENT, T0)).toBeNull();
  });

  it('holds the pre-check ceiling of 30 across clients and replicas', async () => {
    for (let i = 0; i < 30; i++) {
      const replicaBudget = i % 3 === 0 ? await budgets() : (await import('@/lib/auth/verify-budget'));
      expect(await replicaBudget.reserveVerifyProbe(`203.0.113.${i}`, T0)).not.toBeNull();
    }
    const other = await budgets();
    expect(await other.reserveVerifyProbe('203.0.113.200', T0)).toBeNull();
  });

  it('refuses rather than allows when the store is down', async () => {
    const a = await budgets();
    store.down = true;
    await expect(a.reserveLoginAttempt(CLIENT, T0)).rejects.toThrow('down');
    await expect(a.reserveVerifyProbe(CLIENT, T0)).rejects.toThrow('down');
  });

  it('counts pair step-up failures of one account across replicas', async () => {
    const key = 'https://mail.example.org|alice@example.org';
    for (let i = 0; i < 5; i++) {
      const replicaAttempts = await attempts();
      expect(await replicaAttempts.beginPairStepUp(key, T0 + i)).toBe(true);
      await replicaAttempts.settlePairStepUp(key, 'wrong_credential', T0 + i);
    }
    const next = await attempts();
    expect(await next.isPairStepUpLocked(key, T0 + 10)).toBe(true);
    expect(await next.beginPairStepUp(key, T0 + 10)).toBe(false);

    // An attempt that said nothing about the password is given back.
    await next.clearPairStepUpFailures(key);
    expect(await next.beginPairStepUp(key, T0 + 20)).toBe(true);
    await (await attempts()).settlePairStepUp(key, 'other', T0 + 20);
    for (let i = 0; i < 5; i++) expect(await (await attempts()).beginPairStepUp(key, T0 + 30)).toBe(true);
    expect(await (await attempts()).beginPairStepUp(key, T0 + 30)).toBe(false);
  });

  it('gives an attempt back only to the windows it was counted in', async () => {
    const key = 'https://mail.example.org|carol@example.org';
    const early = await (await attempts()).reservePairStepUp(key, T0);
    expect(early).not.toBeNull();
    // The 15-minute window has reset; five new attempts fill the next one.
    const later = T0 + 16 * 60 * 1000;
    for (let i = 0; i < 5; i++) expect(await (await attempts()).beginPairStepUp(key, later)).toBe(true);
    // The early attempt turns out not to count: the new window keeps its five.
    await (await attempts()).settlePairStepUp(key, 'other', later, early!);
    expect(await (await attempts()).beginPairStepUp(key, later)).toBe(false);
  });

  it('caps pair step-ups at 20 a day across replicas', async () => {
    const key = 'https://mail.example.org|bob@example.org';
    let now = T0;
    for (let i = 0; i < 20; i++) {
      if (i > 0 && i % 5 === 0) now += 15 * 60 * 1000;
      expect(await (await attempts()).beginPairStepUp(key, now)).toBe(true);
    }
    now += 15 * 60 * 1000;
    expect(await (await attempts()).isPairStepUpLocked(key, now)).toBe(true);
    expect(await (await attempts()).isPairStepUpLocked(key, T0 + 24 * 60 * 60 * 1000)).toBe(false);
  });

  it('counts hand-off creates and redeems across replicas', async () => {
    for (let i = 0; i < 10; i++) expect(await (await handoff()).reserveHandoffCreate(CLIENT, T0)).toBe(true);
    expect(await (await handoff()).reserveHandoffCreate(CLIENT, T0)).toBe(false);
    for (let i = 0; i < 10; i++) expect(await (await handoff()).reserveHandoffRedeem(CLIENT, T0)).not.toBeNull();
    expect(await (await handoff()).reserveHandoffRedeem(CLIENT, T0)).toBeNull();
  });
});
