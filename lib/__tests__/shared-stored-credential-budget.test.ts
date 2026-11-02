// @vitest-environment node
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  isStoredCredentialRefused,
  recordStoredCredentialStatus,
  resetStoredCredentialBudgetForTests,
} from '@/lib/stalwart/stored-credential-budget';
import { setStoreForTests } from '@/lib/shared-store';
import { resetLocalStoreForTests } from '@/lib/shared-store/local';
import { switchableSharedStore } from './helpers/shared-store-down';

// Each replica kept its own list of refused stored credentials, so a stale
// password was sent to the mail server once per replica and hour, and the
// global ceiling of 20 refusals became 20 per replica (#1066).

const basic = (user: string) => `Basic ${Buffer.from(`${user}:secret`).toString('base64')}`;
const MIN = 60 * 1000;
const T0 = 1_800_000_000_000;
let store: ReturnType<typeof switchableSharedStore>;

/** Another replica: this process forgets everything it kept itself. */
const otherReplica = () => resetStoredCredentialBudgetForTests();

beforeEach(() => {
  vi.stubEnv('SESSION_SECRET', 'a-test-session-secret-of-at-least-32-chars');
  resetLocalStoreForTests();
  resetStoredCredentialBudgetForTests();
  store = switchableSharedStore();
  setStoreForTests(store);
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  setStoreForTests(null);
  resetLocalStoreForTests();
  resetStoredCredentialBudgetForTests();
});

describe('stored credential budget with a shared store', () => {
  it('refuses on every replica a credential one replica saw refused', async () => {
    await recordStoredCredentialStatus(basic('stale'), 401, T0);
    otherReplica();
    expect(await isStoredCredentialRefused(basic('stale'), T0 + 59 * MIN)).toBe(true);
    expect(await isStoredCredentialRefused(basic('other'), T0 + 59 * MIN)).toBe(false);
    expect(await isStoredCredentialRefused(basic('stale'), T0 + 61 * MIN)).toBe(false);
  });

  it('counts the 20 refusals of the window across replicas', async () => {
    await recordStoredCredentialStatus(basic('active'), 200, T0);
    for (let i = 0; i < 20; i++) {
      if (i % 5 === 0) otherReplica();
      await recordStoredCredentialStatus(basic(`stale-${i}`), 401, T0 + i);
    }
    otherReplica();
    expect(await isStoredCredentialRefused(basic('fresh'), T0 + MIN)).toBe(true);
    // Worked within the window on another replica: still goes upstream.
    expect(await isStoredCredentialRefused(basic('active'), T0 + MIN)).toBe(false);
    expect(await isStoredCredentialRefused(basic('fresh'), T0 + 16 * MIN)).toBe(false);
  });

  it('lifts a refusal everywhere when the credential signs in again', async () => {
    await recordStoredCredentialStatus(basic('a'), 401, T0);
    otherReplica();
    await recordStoredCredentialStatus(basic('a'), 200, T0 + MIN);
    otherReplica();
    expect(await isStoredCredentialRefused(basic('a'), T0 + 2 * MIN)).toBe(false);
  });

  it('writes a working credential to the store at most once a minute', async () => {
    const set = vi.spyOn(store.kv, 'set');
    for (let i = 0; i < 5; i++) await recordStoredCredentialStatus(basic('busy'), 200, T0 + i * 1000);
    expect(set).toHaveBeenCalledTimes(1);
    await recordStoredCredentialStatus(basic('busy'), 200, T0 + MIN);
    expect(set).toHaveBeenCalledTimes(2);
  });

  it('falls back to what this replica knows when the store is down', async () => {
    await recordStoredCredentialStatus(basic('stale'), 401, T0);
    store.down = true;
    expect(await isStoredCredentialRefused(basic('stale'), T0 + MIN)).toBe(true);
    expect(await isStoredCredentialRefused(basic('good'), T0 + MIN)).toBe(false);
    // Recorded here even though the store can't take it.
    await recordStoredCredentialStatus(basic('later'), 401, T0 + MIN);
    expect(await isStoredCredentialRefused(basic('later'), T0 + 2 * MIN)).toBe(true);
  });

  it('lifts a refusal recorded on another replica even right after its own success was written', async () => {
    // Each replica keeps its own process state; swap it to act as B, A and C.
    const KEY = Symbol.for('bulwark.storedCredentialBudget');
    const g = globalThis as Record<symbol, unknown>;
    const replicas = new Map<string, unknown>();
    const as = async (name: string, fn: () => Promise<unknown>) => {
      if (replicas.has(name)) g[KEY] = replicas.get(name);
      else delete g[KEY];
      await fn();
      replicas.set(name, g[KEY]);
    };
    await as('B', () => recordStoredCredentialStatus(basic('a'), 200, T0));
    await as('A', () => recordStoredCredentialStatus(basic('a'), 401, T0 + 10_000));
    // The user signs in again through B 20 s after B's last write.
    await as('B', () => recordStoredCredentialStatus(basic('a'), 200, T0 + 20_000));
    await as('C', async () => expect(await isStoredCredentialRefused(basic('a'), T0 + 30_000)).toBe(false));
  });

  it('keys the store by an HMAC of the session secret, never a plain hash of the credential', async () => {
    const set = vi.spyOn(store.kv, 'set');
    await recordStoredCredentialStatus(basic('stale'), 401, T0);
    const keys = set.mock.calls.map(([key]) => key);
    const plain = createHash('sha256').update(basic('stale')).digest('base64url');
    expect(keys.length).toBeGreaterThan(0);
    for (const key of keys) expect(key).not.toContain(plain);

    // Another secret, another key: a store backup alone can't be tried against passwords.
    otherReplica();
    vi.stubEnv('SESSION_SECRET', 'another-test-session-secret-of-32-chars');
    expect(await isStoredCredentialRefused(basic('stale'), T0 + MIN)).toBe(false);
  });

  it('writes nothing to the store without a session secret', async () => {
    vi.stubEnv('SESSION_SECRET', '');
    vi.stubEnv('ADMIN_STATE_DIR', path.join(tmpdir(), 'bw-no-secret-does-not-exist'));
    const set = vi.spyOn(store.kv, 'set');
    const get = vi.spyOn(store.kv, 'get');
    await recordStoredCredentialStatus(basic('stale'), 401, T0);
    expect(await isStoredCredentialRefused(basic('stale'), T0 + MIN)).toBe(true);
    expect(set).not.toHaveBeenCalled();
    expect(get).not.toHaveBeenCalled();
  });

  it('decides from this replica within the deadline when the store is slow', async () => {
    await recordStoredCredentialStatus(basic('stale'), 401, T0);
    vi.spyOn(store.kv, 'get').mockImplementation(() => new Promise((resolve) => setTimeout(() => resolve(null), 2000)));
    const started = Date.now();
    expect(await isStoredCredentialRefused(basic('stale'), T0 + MIN)).toBe(true);
    expect(await isStoredCredentialRefused(basic('fresh'), T0 + MIN)).toBe(false);
    expect(Date.now() - started).toBeLessThan(1500);
  });

  it('honours and later writes a refusal seen while the store was down', async () => {
    store.down = true;
    await recordStoredCredentialStatus(basic('stale'), 401, T0);
    store.down = false;
    // The store doesn't know it yet; this replica still refuses it.
    expect(await isStoredCredentialRefused(basic('stale'), T0 + MIN)).toBe(true);
    // The next write carries it to the store, and other replicas refuse it too.
    await recordStoredCredentialStatus(basic('other'), 200, T0 + MIN);
    otherReplica();
    expect(await isStoredCredentialRefused(basic('stale'), T0 + 2 * MIN)).toBe(true);
  });

  it('answers a JMAP call without waiting for the shared writes', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('', { status: 401 })));
    vi.spyOn(store.kv, 'set').mockImplementation(() => new Promise(() => {}));
    vi.spyOn(store.counters, 'hit').mockImplementation(() => new Promise(() => {}));
    const { fetchJmapServer } = await import('@/lib/stalwart/server-fetch');
    const res = await Promise.race([
      fetchJmapServer('https://mail.example/jmap/session', { headers: { Authorization: basic('stale') } }, true),
      new Promise<'hung'>((resolve) => setTimeout(() => resolve('hung'), 1000)),
    ]);
    expect(res).not.toBe('hung');
    expect((res as Response).status).toBe(401);
    vi.unstubAllGlobals();
  });
});
