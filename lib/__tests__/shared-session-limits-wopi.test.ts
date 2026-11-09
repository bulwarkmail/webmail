// @vitest-environment node
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/logger', () => ({
  logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import { setStoreForTests } from '@/lib/shared-store';
import { resetLocalStoreForTests } from '@/lib/shared-store/local';
import { limitsEnforcedSince, resetLimitsEnforcedSince } from '@/lib/auth/session-age';
import { WOPI_TOKEN_TTL_MS, type WopiTokenPayload } from '@/lib/wopi/token';
import { switchableSharedStore } from './helpers/shared-store-down';

// Two pieces of auth state lived in the state dir and only reached replicas
// that shared it (#1066): when the server first enforced the session limits
// (replicas disagreed on when legacy sessions run out), and the office editor
// revocations written at sign-out (an editor opened through replica A kept
// working through B after signing out).

const dirs: string[] = [];
let store: ReturnType<typeof switchableSharedStore>;

function tempDir(prefix: string): string {
  const dir = mkdtempSync(path.join(tmpdir(), prefix));
  dirs.push(dir);
  return dir;
}

/** Another replica: its own state dir and nothing in this process's memory. */
function otherReplica(): void {
  vi.stubEnv('ADMIN_STATE_DIR', tempDir('bw-auth-replica-'));
  resetLimitsEnforcedSince();
  delete (globalThis as Record<symbol, unknown>)[Symbol.for('bulwark.wopiRevocations')];
}

function browser(id: string) {
  const jar = new Map<string, string>([['bulwark_wopi', id]]);
  return {
    get: (name: string) => (jar.has(name) ? { name, value: jar.get(name)! } : undefined),
    set: (name: string, value: string) => void jar.set(name, value),
    delete: (name: string) => void jar.delete(name),
  } as never;
}

/** This replica's copy of the revocation module (a fresh one after otherReplica()). */
async function wopi() {
  vi.resetModules();
  return import('@/lib/wopi/revocation');
}

async function token(cookies: never, slot: number, mintedAt: number): Promise<WopiTokenPayload> {
  const { wopiBrowserBinding } = await import('@/lib/wopi/revocation');
  return { bid: wopiBrowserBinding(cookies), slot, exp: mintedAt + WOPI_TOKEN_TTL_MS } as WopiTokenPayload;
}

beforeEach(() => {
  resetLocalStoreForTests();
  store = switchableSharedStore({ sharedDir: tempDir('bw-auth-store-') });
  setStoreForTests(store);
  otherReplica();
});

afterEach(() => {
  setStoreForTests(null);
  resetLocalStoreForTests();
  resetLimitsEnforcedSince();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('session limits start with a shared store', () => {
  it('is the same time on every replica: the first one to ask', async () => {
    vi.spyOn(Date, 'now').mockReturnValue(1_700_000_000_000);
    expect(await limitsEnforcedSince()).toBe(1_700_000_000_000);
    otherReplica();
    vi.spyOn(Date, 'now').mockReturnValue(1_700_000_500_000);
    expect(await limitsEnforcedSince()).toBe(1_700_000_000_000);
  });

  it('counts from the process start while the store is down, and asks again later', async () => {
    store.down = true;
    const fallback = await limitsEnforcedSince();
    expect(fallback).toBeLessThanOrEqual(Date.now());
    store.down = false;
    vi.spyOn(Date, 'now').mockReturnValue(1_700_000_000_000);
    expect(await limitsEnforcedSince()).toBe(1_700_000_000_000);
  });
});

describe('office editor revocations with a shared store', () => {
  it('refuses on another replica an editor token revoked at sign-out on this one', async () => {
    const tab = browser('browser-1');
    const minted = Date.now() - 1000;
    const payload = await token(tab, 0, minted);
    const a = await wopi();
    expect(await a.isWopiTokenRevoked(payload)).toBe(false);
    await a.revokeWopiTokens(tab, 0);
    otherReplica();
    const b = await wopi();
    expect(await b.isWopiTokenRevoked(payload)).toBe(true);
    // Another slot of that browser is untouched.
    expect(await b.isWopiTokenRevoked(await token(tab, 1, minted))).toBe(false);
  });

  it('keeps revocations written on two replicas', async () => {
    const minted = Date.now() - 1000;
    const one = browser('browser-1');
    const two = browser('browser-2');
    const first = await token(one, 0, minted);
    const second = await token(two, 0, minted);
    await (await wopi()).revokeWopiTokens(one, 0);
    otherReplica();
    await (await wopi()).revokeWopiTokens(two, 0);
    otherReplica();
    const c = await wopi();
    expect(await c.isWopiTokenRevoked(first)).toBe(true);
    expect(await c.isWopiTokenRevoked(second)).toBe(true);
  });

  it('writes a sign-out made during an outage once the store answers again', async () => {
    const tab = browser('browser-1');
    const payload = await token(tab, 0, Date.now() - 1000);
    const a = await wopi();
    store.down = true;
    await a.revokeWopiTokens(tab, 0);
    store.down = false;
    // The next editor request through A writes it.
    await a.isWopiTokenRevoked(await token(browser('browser-9'), 0, Date.now()));
    otherReplica();
    expect(await (await wopi()).isWopiTokenRevoked(payload)).toBe(true);
  });

  it('retries an unwritten sign-out on a timer, without any editor request', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    try {
      const tab = browser('browser-1');
      const payload = await token(tab, 0, Date.now() - 1000);
      const a = await wopi();
      store.down = true;
      await a.revokeWopiTokens(tab, 0);
      store.down = false;
      await vi.advanceTimersByTimeAsync(20_000);
      // The retry writes a file in the fake store: let that real I/O finish.
      await new Promise((resolve) => setTimeout(resolve, 300));
      otherReplica();
      expect(await (await wopi()).isWopiTokenRevoked(payload)).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it('refuses editor tokens while the store is down, and still signs out', async () => {
    const tab = browser('browser-1');
    const payload = await token(tab, 0, Date.now() - 1000);
    const a = await wopi();
    store.down = true;
    expect(await a.isWopiTokenRevoked(payload)).toBe(true);
    await expect(a.revokeWopiTokens(tab, 'all')).resolves.toBeUndefined();
  });
});
