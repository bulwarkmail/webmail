// @vitest-environment node
import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/logger', () => ({
  logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import { setStoreForTests } from '@/lib/shared-store';
import { resetLocalStoreForTests } from '@/lib/shared-store/local';
import { impersonationReplayCache } from '@/lib/impersonation/jwt';
import { consumeImpersonationJti } from '@/lib/impersonation/replay-store';
import { switchableSharedStore } from './helpers/shared-store-down';

// Without a shared state volume each replica knew only its own used
// impersonation tokens (#1066): a captured hand-off link redeemed on A could
// be redeemed again on B within its lifetime.

let stateDir: string;
let sharedDir: string;
let store: ReturnType<typeof switchableSharedStore>;

beforeEach(() => {
  stateDir = mkdtempSync(path.join(tmpdir(), 'bw-jti-a-'));
  sharedDir = mkdtempSync(path.join(tmpdir(), 'bw-jti-store-'));
  vi.stubEnv('ADMIN_STATE_DIR', stateDir);
  impersonationReplayCache.clear();
  resetLocalStoreForTests();
  store = switchableSharedStore({ sharedDir });
  setStoreForTests(store);
});

afterEach(() => {
  setStoreForTests(null);
  resetLocalStoreForTests();
  vi.unstubAllEnvs();
  rmSync(stateDir, { recursive: true, force: true });
  rmSync(sharedDir, { recursive: true, force: true });
  for (const dir of otherDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const otherDirs: string[] = [];

/** Another replica: its own state dir and nothing in its memory. */
function otherReplica(): void {
  const dir = mkdtempSync(path.join(tmpdir(), 'bw-jti-b-'));
  otherDirs.push(dir);
  vi.stubEnv('ADMIN_STATE_DIR', dir);
  impersonationReplayCache.clear();
}

describe('impersonation replay with a shared store', () => {
  const now = Date.now();
  const exp = Math.floor(now / 1000) + 120;

  it('refuses on another replica a token used on this one', async () => {
    expect(await consumeImpersonationJti('jti-1', exp, now)).toBe(true);
    otherReplica();
    expect(await consumeImpersonationJti('jti-1', exp, now)).toBe(false);
    expect(await consumeImpersonationJti('jti-2', exp, now)).toBe(true);
  });

  it('lets exactly one of several replicas accept a token at once', async () => {
    const results = await Promise.all(
      Array.from({ length: 4 }, () => {
        otherReplica();
        return consumeImpersonationJti('jti-race', exp, now);
      }),
    );
    expect(results.filter(Boolean)).toHaveLength(1);
  });

  it('refuses the token while the store is down, without remembering it as used', async () => {
    store.down = true;
    await expect(consumeImpersonationJti('jti-down', exp, now)).rejects.toMatchObject({ name: 'ImpersonationReplayUnavailableError' });
    store.down = false;
    expect(await consumeImpersonationJti('jti-down', exp, now)).toBe(true);
    expect(await consumeImpersonationJti('jti-down', exp, now)).toBe(false);
  });

  it('keeps used tokens as expiring keys, not as documents of an ever-growing collection', async () => {
    const set = vi.spyOn(store.kv, 'set');
    expect(await consumeImpersonationJti('jti-kv', exp, now)).toBe(true);
    expect(set).toHaveBeenCalledWith(expect.stringMatching(/^imp-jti:[0-9a-f]{64}$/), '1', { ifAbsent: true, ttlMs: 420_000 });
    expect(readdirSync(sharedDir)).toEqual([]);
  });
});
