// @vitest-environment node
import { createHash } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/logger', () => ({
  logger: { warn: vi.fn(), error: vi.fn(), debug: vi.fn(), info: vi.fn() },
}));

import { getStore, setStoreForTests } from '@/lib/shared-store';
import { resetLocalStoreForTests } from '@/lib/shared-store/local';
import type { RedeemBundle } from '@/lib/auth/pair-bundle';
import { switchableSharedStore } from './helpers/shared-store-down';

// The mobile hand-off parked its sign-in in one process's memory (#1066).
// The SSO hand-off is three requests from two clients (sso/complete parks,
// the page confirms, the app redeems), so behind a load balancer each could
// reach another replica and get invalid_code.

const T0 = 1_800_000_000_000;
const VERIFIER = 'v'.repeat(43);
const CHALLENGE = createHash('sha256').update(VERIFIER, 'ascii').digest('base64url');
const PASSWORD_BUNDLE: RedeemBundle = { flow: 'password', server_url: 'https://mail.example.org', username: 'alice@example.org', password: 'hunter2-secret' };
let store: ReturnType<typeof switchableSharedStore>;

/** Another replica: a fresh module copy without this process's own map. */
async function replica() {
  vi.resetModules();
  delete (globalThis as Record<string, unknown>).__bulwarkMobileHandoffStore;
  return import('@/lib/auth/handoff-store');
}

beforeEach(() => {
  vi.stubEnv('SESSION_SECRET', 'a-test-session-secret-of-at-least-32-chars');
  resetLocalStoreForTests();
  store = switchableSharedStore();
  setStoreForTests(store);
});

afterEach(() => {
  setStoreForTests(null);
  resetLocalStoreForTests();
  vi.unstubAllEnvs();
});

describe('mobile hand-off with a shared store', () => {
  it('redeems on another replica a code parked on this one, only once', async () => {
    const browser = await replica();
    const code = await browser.stashHandoff(PASSWORD_BUNDLE, { challenge: CHALLENGE, state: 's-1' }, T0);

    const apps = await Promise.all([replica(), replica(), replica()]);
    const results = await Promise.all(apps.map((app) => app.redeemHandoff(code, VERIFIER, T0 + 1000)));
    expect(results.filter((r) => r.ok)).toEqual([{ ok: true, bundle: PASSWORD_BUNDLE, state: 's-1' }]);
    expect(results.filter((r) => !r.ok)).toEqual([{ ok: false, reason: 'invalid' }, { ok: false, reason: 'invalid' }]);
  });

  it('parks on one replica, confirms on a second and redeems on a third', async () => {
    const code = await (await replica()).stashHandoff(PASSWORD_BUNDLE, { challenge: CHALLENGE, state: 's-2', awaitConfirm: true }, T0);
    expect(await (await replica()).confirmHandoff(code, T0 + 60_000)).toBe(true);
    // Confirmed once only.
    expect(await (await replica()).confirmHandoff(code, T0 + 60_001)).toBe(false);
    // Its 60 seconds started at the confirmation.
    expect(await (await replica()).redeemHandoff(code, VERIFIER, T0 + 110_000)).toMatchObject({ ok: true, state: 's-2' });
  });

  it('spends an unconfirmed code on the first attempt, on any replica', async () => {
    // Parked on A (the SSO callback), tried too early on B: A can't confirm it any more.
    const a = await replica();
    const code = await a.stashHandoff(PASSWORD_BUNDLE, { challenge: CHALLENGE, state: 's', awaitConfirm: true }, T0);
    const g = globalThis as Record<string, unknown>;
    const aMemory = g.__bulwarkMobileHandoffStore;
    expect(await (await replica()).redeemHandoff(code, VERIFIER, T0 + 1)).toEqual({ ok: false, reason: 'invalid' });
    // Back on A, with A's own memory.
    g.__bulwarkMobileHandoffStore = aMemory;
    expect(await a.confirmHandoff(code, T0 + 2)).toBe(false);
    expect(await a.redeemHandoff(code, VERIFIER, T0 + 3)).toEqual({ ok: false, reason: 'invalid' });
  });

  it('still hands out the sign-in when the tombstone after the redeem cannot be written', async () => {
    const code = await (await replica()).stashHandoff(PASSWORD_BUNDLE, { challenge: CHALLENGE, state: 's' }, T0);
    const app = await replica();
    vi.spyOn(store.kv, 'set').mockRejectedValueOnce(Object.assign(new Error('down (test)'), { name: 'StoreUnavailableError' }));
    expect(await app.redeemHandoff(code, VERIFIER, T0 + 1)).toMatchObject({ ok: true, bundle: PASSWORD_BUNDLE });
    vi.restoreAllMocks();
  });

  it('spends a code on a wrong verifier and tells a late attempt it expired', async () => {
    const code = await (await replica()).stashHandoff(PASSWORD_BUNDLE, { challenge: CHALLENGE, state: 's' }, T0);
    expect(await (await replica()).redeemHandoff(code, 'w'.repeat(43), T0 + 1)).toEqual({ ok: false, reason: 'verifier_mismatch' });
    expect(await (await replica()).redeemHandoff(code, VERIFIER, T0 + 2)).toEqual({ ok: false, reason: 'invalid' });
    expect(await (await replica()).redeemHandoff(code, VERIFIER, T0 + 61_000)).toEqual({ ok: false, reason: 'expired' });
  });

  it('keeps the sign-in sealed and the code hashed in the store', async () => {
    const code = await (await replica()).stashHandoff(PASSWORD_BUNDLE, { challenge: CHALLENGE, state: 's' }, T0);
    const raw = await getStore().kv.get(`handoff:${createHash('sha256').update(code).digest('hex')}`);
    expect(raw).toBeTruthy();
    expect(raw).not.toContain('hunter2-secret');
    expect(await getStore().kv.get(`handoff:${code}`)).toBeNull();
  });

  it('parks and redeems nothing while the store is down', async () => {
    const browser = await replica();
    const code = await browser.stashHandoff(PASSWORD_BUNDLE, { challenge: CHALLENGE, state: 's' }, T0);
    store.down = true;
    await expect(browser.stashHandoff(PASSWORD_BUNDLE, { challenge: CHALLENGE, state: 's' }, T0)).rejects.toThrow('down');
    await expect(browser.redeemHandoff(code, VERIFIER, T0 + 1)).rejects.toThrow('down');
    await expect(browser.confirmHandoff(code, T0 + 1)).rejects.toThrow('down');
    store.down = false;
    expect(await (await replica()).redeemHandoff(code, VERIFIER, T0 + 2)).toMatchObject({ ok: true });
  });
});
