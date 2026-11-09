/**
 * @vitest-environment node
 */
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Replicas that start in the setup state each print the setup token. With a
// shared store (#1066) they must print the same one, and the wizard must
// accept it on whichever replica the load balancer picks.

import { setStoreForTests } from '@/lib/shared-store';
import { resetLocalStoreForTests } from '@/lib/shared-store/local';
import { separateFakeStore } from '@/lib/admin/__tests__/shared-store-fake';

let dir: string;

let replicas = 0;

/**
 * One replica's copy of lib/setup/token.ts, with a state dir of its own:
 * replicas share the store, not a volume. Each call runs with that dir.
 */
async function replica() {
  vi.resetModules();
  const token = await import('@/lib/setup/token');
  const own = path.join(dir, `state-${++replicas}`);
  const inOwnDir = <A extends unknown[], R>(fn: (...args: A) => Promise<R>) => (...args: A) => {
    vi.stubEnv('ADMIN_STATE_DIR', own);
    return fn(...args);
  };
  return {
    ensureSetupToken: inOwnDir(token.ensureSetupToken),
    verifySetupToken: inOwnDir(token.verifySetupToken),
    clearSetupToken: inOwnDir(token.clearSetupToken),
  };
}

/** Whether any replica wrote a token file. */
const anyTokenFile = () => Array.from({ length: replicas }, (_, i) => path.join(dir, `state-${i + 1}`, '.setup-token')).some((f) => existsSync(f));

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'bw-setup-token-'));
  replicas = 0;
  resetLocalStoreForTests();
  setStoreForTests(separateFakeStore(path.join(dir, 'store')));
});

afterEach(() => {
  setStoreForTests(null);
  resetLocalStoreForTests();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  rmSync(dir, { recursive: true, force: true });
});

describe('setup token with a shared store', () => {
  it('gives replicas booting together one token that each of them accepts', async () => {
    const replicas = [await replica(), await replica(), await replica()];
    const tokens = await Promise.all(replicas.map((r) => r.ensureSetupToken()));
    expect(new Set(tokens).size).toBe(1);
    for (const r of replicas) expect(await r.verifySetupToken(tokens[0])).toBe(true);
    expect(await replicas[0].verifySetupToken('0'.repeat(64))).toBe(false);
    expect(anyTokenFile()).toBe(false);
  });

  it('keeps the token across restarts within the hour, then issues a new one', async () => {
    const first = await (await replica()).ensureSetupToken();
    expect(await (await replica()).ensureSetupToken()).toBe(first);

    const now = Date.now();
    vi.spyOn(Date, 'now').mockReturnValue(now + 61 * 60 * 1000);
    const later = await replica();
    expect(await later.verifySetupToken(first)).toBe(false);
    const second = await later.ensureSetupToken();
    expect(second).not.toBe(first);
    expect(await (await replica()).verifySetupToken(second)).toBe(true);
  });

  it('stops the token working on every replica once the wizard finished on one', async () => {
    const [a, b] = [await replica(), await replica()];
    const token = await a.ensureSetupToken();
    expect(await b.verifySetupToken(token)).toBe(true);
    await a.clearSetupToken();
    expect(await b.verifySetupToken(token)).toBe(false);
  });
});
