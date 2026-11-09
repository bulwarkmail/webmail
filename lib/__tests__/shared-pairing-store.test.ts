// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/logger', () => ({
  logger: { warn: vi.fn(), error: vi.fn(), debug: vi.fn(), info: vi.fn() },
}));

import { getStore, setStoreForTests } from '@/lib/shared-store';
import { resetLocalStoreForTests } from '@/lib/shared-store/local';
import type { PairingGrant } from '@/lib/auth/pairing-store';
import { switchableSharedStore } from './helpers/shared-store-down';

// "Link mobile app" kept its grants, codes and status index in one process's
// memory (#1066). Behind a load balancer the phone's redeem, the desktop's
// status polls and a sign-out each land on any replica, so the records live
// in the shared store, sealed with the session key.

const OWNER = '0:alice@example.org';
const BASE = 'https://webmail.example';
const T0 = 1_800_000_000_000;
const GRANT_TTL_MS = 5 * 60 * 1000;

const GRANT: PairingGrant = {
  flow: 'oauth',
  serverUrl: 'https://mail.example.org',
  serverId: null,
  accessToken: 'access-secret-1',
  refreshToken: 'refresh-secret-1',
  expiresIn: 3600,
  issuedAt: T0,
  tokenEndpoint: 'https://mail.example.org/auth/token',
  clientId: 'bulwark-webmail',
  confidential: false,
  trusted: true,
};

const APP_GRANT: PairingGrant = {
  flow: 'password',
  serverUrl: 'https://mail.example.org',
  username: 'alice@example.org',
  password: 'app-secret',
  credential: 'app-password',
  appPasswordId: 'ap-1',
};

let store: ReturnType<typeof switchableSharedStore>;

/**
 * Another replica: a fresh module copy and none of the process state the
 * pairing store pins on globalThis. Only the shared store is common.
 */
async function replica(disposer?: (grant: PairingGrant) => void) {
  vi.resetModules();
  const pinned = (globalThis as unknown as Record<string, { sweepTimer?: ReturnType<typeof setInterval> } | undefined>).__bulwarkPairingStore;
  if (pinned?.sweepTimer) clearInterval(pinned.sweepTimer);
  delete (globalThis as Record<string, unknown>).__bulwarkPairingStore;
  const mod = await import('@/lib/auth/pairing-store');
  if (disposer) mod.registerGrantDisposer(disposer);
  return mod;
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

describe('pairing store with a shared store', () => {
  it('redeems on another replica a code stashed on this one, exactly once', async () => {
    const desktop = await replica();
    const grantId = await desktop.stashGrant(GRANT, OWNER, T0);
    const pairing = (await desktop.createPairingCode(grantId, OWNER, BASE, T0))!;
    expect(pairing).not.toBeNull();

    const phones = await Promise.all([replica(), replica(), replica()]);
    const results = await Promise.all(phones.map((phone) => phone.redeemPairingCode(pairing.code, T0 + 1000)));
    expect(results.filter((r) => r.ok)).toEqual([{ ok: true, grant: GRANT, webmailBase: BASE }]);
    expect(results.filter((r) => !r.ok)).toEqual([{ ok: false, reason: 'used' }, { ok: false, reason: 'used' }]);

    const late = await replica();
    expect(await late.redeemPairingCode(pairing.code, T0 + 2000)).toEqual({ ok: false, reason: 'used' });
    expect(await late.isGrantAvailable(grantId, OWNER, T0 + 2000)).toBe(false);
  });

  it('answers status polls on any replica: pending, then redeemed', async () => {
    const desktop = await replica();
    const grantId = await desktop.stashGrant(GRANT, OWNER, T0);
    const pairing = (await desktop.createPairingCode(grantId, OWNER, BASE, T0))!;

    expect(await (await replica()).getPairingStatus(pairing.statusId, T0 + 1)).toBe('pending');
    expect(await (await replica()).redeemPairingCode(pairing.code, T0 + 2)).toMatchObject({ ok: true });
    expect(await (await replica()).getPairingStatus(pairing.statusId, T0 + 3)).toBe('redeemed');
    expect(await (await replica()).getPairingStatus('0'.repeat(32), T0 + 3)).toBe('unknown');
  });

  it('lets only the newest QR redeem, and tells a late scan of an older one it was used', async () => {
    const desktop = await replica();
    const grantId = await desktop.stashGrant(GRANT, OWNER, T0);
    const first = (await desktop.createPairingCode(grantId, OWNER, BASE, T0))!;
    const second = (await (await replica()).createPairingCode(grantId, OWNER, BASE, T0 + 1000))!;

    const phone = await replica();
    expect(await phone.getPairingStatus(first.statusId, T0 + 1001)).toBe('expired');
    expect(await phone.redeemPairingCode(first.code, T0 + 1001)).toEqual({ ok: false, reason: 'expired' });
    expect(await phone.redeemPairingCode(second.code, T0 + 2000)).toMatchObject({ ok: true });
    expect(await phone.redeemPairingCode(first.code, T0 + 2001)).toEqual({ ok: false, reason: 'used' });
    expect(await phone.getPairingStatus(first.statusId, T0 + 2001)).toBe('expired');
  });

  it('keeps only the last few replaced codes of a grant', async () => {
    const desktop = await replica();
    const id = await desktop.stashGrant(GRANT, OWNER, T0);
    const all = [];
    for (let i = 0; i < 8; i++) all.push((await desktop.createPairingCode(id, OWNER, BASE, T0 + i))!);
    const phone = await replica();
    expect(await phone.getPairingStatus(all[7].statusId, T0 + 10)).toBe('pending');
    expect(await phone.getPairingStatus(all[4].statusId, T0 + 10)).toBe('expired');
    expect(await phone.getPairingStatus(all[3].statusId, T0 + 10)).toBe('unknown');
    expect(await phone.redeemPairingCode(all[0].code, T0 + 10)).toEqual({ ok: false, reason: 'invalid' });
  });

  it('stops a QR when the desktop signs out through another replica', async () => {
    const desktop = await replica();
    const grantId = await desktop.stashGrant(GRANT, OWNER, T0);
    const pairing = (await desktop.createPairingCode(grantId, OWNER, BASE, T0))!;

    await (await replica()).discardGrant(grantId, T0 + 1);

    const phone = await replica();
    expect(await phone.getPairingStatus(pairing.statusId, T0 + 2)).toBe('expired');
    expect(await phone.redeemPairingCode(pairing.code, T0 + 2)).toEqual({ ok: false, reason: 'expired' });
    expect(await phone.createPairingCode(grantId, OWNER, BASE, T0 + 2)).toBeNull();
  });

  it('keeps grants of other owners apart and lets a code never outlive its grant', async () => {
    const desktop = await replica();
    const grantId = await desktop.stashGrant(GRANT, OWNER, T0);
    expect(await desktop.isGrantAvailable(grantId, '1:alice@example.org', T0)).toBe(false);
    expect(await desktop.createPairingCode(grantId, '0:mallory@example.org', BASE, T0)).toBeNull();

    const late = (await desktop.createPairingCode(grantId, OWNER, BASE, T0 + GRANT_TTL_MS - 30_000))!;
    expect(late.expiresIn).toBe(30);
    const phone = await replica();
    expect(await phone.redeemPairingCode(late.code, T0 + GRANT_TTL_MS)).toEqual({ ok: false, reason: 'expired' });
    expect(await phone.isGrantAvailable(grantId, OWNER, T0 + GRANT_TTL_MS)).toBe(false);
  });

  it('disposes of an unredeemed grant from whichever replica handles pairing next, once', async () => {
    const disposed: PairingGrant[] = [];
    const desktop = await replica((g) => disposed.push(g));
    await desktop.stashGrant(APP_GRANT, OWNER, T0);
    const redeemedId = await desktop.stashGrant(APP_GRANT, OWNER, T0);
    const code = (await desktop.createPairingCode(redeemedId, OWNER, BASE, T0))!;
    expect((await desktop.redeemPairingCode(code.code, T0 + 1)).ok).toBe(true);

    // A replica that can't dispose (never loaded the step-up code) leaves it.
    await (await replica()).getPairingStatus('0'.repeat(32), T0 + GRANT_TTL_MS + 1);
    expect(disposed).toEqual([]);

    // The next one that can, does: once, and not the redeemed grant.
    await (await replica((g) => disposed.push(g))).getPairingStatus('0'.repeat(32), T0 + GRANT_TTL_MS + 2);
    await (await replica((g) => disposed.push(g))).getPairingStatus('0'.repeat(32), T0 + GRANT_TTL_MS + 3);
    expect(disposed).toEqual([APP_GRANT]);
  });

  it('disposes of a grant discarded on another replica once', async () => {
    const disposed: PairingGrant[] = [];
    const desktop = await replica((g) => disposed.push(g));
    const grantId = await desktop.stashGrant(APP_GRANT, OWNER, T0);
    await (await replica((g) => disposed.push(g))).discardGrant(grantId, T0 + 1);
    await (await replica((g) => disposed.push(g))).discardGrant(grantId, T0 + 2);
    await (await replica((g) => disposed.push(g))).isGrantAvailable(grantId, OWNER, T0 + GRANT_TTL_MS + 1);
    expect(disposed).toEqual([APP_GRANT]);
  });

  it('keeps the secrets sealed and the codes hashed in the store', async () => {
    const desktop = await replica();
    const grantId = await desktop.stashGrant(GRANT, OWNER, T0);
    const pairing = (await desktop.createPairingCode(grantId, OWNER, BASE, T0))!;
    const raw = await getStore().kv.get(`pairing:grant:${grantId}`);
    expect(raw).toBeTruthy();
    expect(raw).not.toContain('access-secret-1');
    expect(raw).not.toContain('alice');
    expect(await getStore().kv.get(`pairing:code:${pairing.code}`)).toBeNull();
  });

  it('issues and redeems nothing while the store is down, and disposes of what it could not keep', async () => {
    const disposed: PairingGrant[] = [];
    const desktop = await replica((g) => disposed.push(g));
    const grantId = await desktop.stashGrant(GRANT, OWNER, T0);
    const pairing = (await desktop.createPairingCode(grantId, OWNER, BASE, T0))!;

    store.down = true;
    await expect(desktop.stashGrant(APP_GRANT, OWNER, T0)).rejects.toThrow('down');
    expect(disposed).toEqual([APP_GRANT]);
    await expect(desktop.redeemPairingCode(pairing.code, T0 + 1)).rejects.toThrow('down');
    await expect(desktop.getPairingStatus(pairing.statusId, T0 + 1)).rejects.toThrow('down');

    // Back up: the code was never spent.
    store.down = false;
    expect(await (await replica()).redeemPairingCode(pairing.code, T0 + 2)).toMatchObject({ ok: true });
  });
});

describe('app-password disposal with a shared store, as time passes', () => {
  // Fake Date: the fake store's own expiries follow it, as Redis TTLs follow the wall clock.
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(T0);
  });
  afterEach(() => vi.useRealTimers());

  const later = (ms: number) => vi.setSystemTime(Date.now() + ms);

  for (const idle of [7 * 60_000, 20 * 60_000, 2 * 24 * 60 * 60_000]) {
    it(`disposes of an abandoned grant when pairing is next used ${Math.round(idle / 60_000)} min later, once`, async () => {
      const disposed: PairingGrant[] = [];
      await (await replica((g) => disposed.push(g))).stashGrant(APP_GRANT, OWNER);
      later(idle);
      await (await replica((g) => disposed.push(g))).getPairingStatus('0'.repeat(32));
      later(60_000);
      await (await replica((g) => disposed.push(g))).getPairingStatus('0'.repeat(32));
      expect(disposed).toEqual([APP_GRANT]);
    });
  }

  it('never disposes of a redeemed grant, even after its record is gone', async () => {
    const disposed: PairingGrant[] = [];
    const desktop = await replica((g) => disposed.push(g));
    const id = await desktop.stashGrant(APP_GRANT, OWNER);
    const code = (await desktop.createPairingCode(id, OWNER, BASE))!;
    expect((await (await replica()).redeemPairingCode(code.code)).ok).toBe(true);
    later(2 * 24 * 60 * 60_000);
    await (await replica((g) => disposed.push(g))).getPairingStatus('0'.repeat(32));
    expect(disposed).toEqual([]);
  });

  it('sweeps from a timer in the process holding the disposer, without any request', async () => {
    vi.useFakeTimers({ toFake: ['Date', 'setInterval', 'clearInterval'] });
    vi.setSystemTime(T0);
    const disposed: PairingGrant[] = [];
    const desktop = await replica((g) => disposed.push(g));
    await desktop.stashGrant(APP_GRANT, OWNER);
    await vi.advanceTimersByTimeAsync(7 * 60_000);
    expect(disposed).toEqual([APP_GRANT]);
    desktop.resetPairingStoreForTests();
  });

  it('keeps an unreadable disposal list and refuses to stash an app password it could not list', async () => {
    await getStore().kv.set('pairing:disposals', 'not-sealed');
    const disposed: PairingGrant[] = [];
    const desktop = await replica((g) => disposed.push(g));
    await expect(desktop.stashGrant(APP_GRANT, OWNER)).rejects.toThrow('unreadable');
    expect(disposed).toEqual([APP_GRANT]);
    later(10 * 60_000);
    await desktop.getPairingStatus('0'.repeat(32));
    expect(await getStore().kv.get('pairing:disposals')).toBe('not-sealed');
  });

  it('retries a sign-out discard that hit an outage once the store is back', async () => {
    const desktop = await replica();
    const id = await desktop.stashGrant(GRANT, OWNER);
    const code = (await desktop.createPairingCode(id, OWNER, BASE))!;
    store.down = true;
    await expect(desktop.discardGrant(id)).rejects.toThrow('down');
    store.down = false;
    later(1000);
    // The next pairing request on that replica finishes the sign-out.
    await desktop.getPairingStatus('0'.repeat(32));
    expect(await (await replica()).redeemPairingCode(code.code)).toEqual({ ok: false, reason: 'expired' });
  });
});
