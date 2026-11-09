// @vitest-environment node
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/logger', () => ({
  logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import { setStoreForTests } from '@/lib/shared-store';
import { resetLocalStoreForTests } from '@/lib/shared-store/local';
import { steps } from '@/lib/shared-store/import/auth';
import { limitsEnforcedSince, resetLimitsEnforcedSince } from '@/lib/auth/session-age';
import { WOPI_TOKEN_TTL_MS, type WopiTokenPayload } from '@/lib/wopi/token';
import { isWopiTokenRevoked } from '@/lib/wopi/revocation';
import { switchableSharedStore } from './helpers/shared-store-down';

// Moving a single instance to the shared store (#1066) must carry over the
// auth state that outlives a restart, and never touch the local files.

let stateDir: string;
let sharedDir: string;

const run = async () => {
  const counts: Record<string, number> = {};
  for (const step of steps) counts[step.name] = await step.run();
  return counts;
};

beforeEach(() => {
  stateDir = mkdtempSync(path.join(tmpdir(), 'bw-import-auth-'));
  sharedDir = mkdtempSync(path.join(tmpdir(), 'bw-import-store-'));
  vi.stubEnv('ADMIN_STATE_DIR', stateDir);
  resetLocalStoreForTests();
  resetLimitsEnforcedSince();
  delete (globalThis as Record<symbol, unknown>)[Symbol.for('bulwark.wopiRevocations')];
  setStoreForTests(switchableSharedStore({ sharedDir }));
});

afterEach(() => {
  setStoreForTests(null);
  resetLocalStoreForTests();
  resetLimitsEnforcedSince();
  vi.unstubAllEnvs();
  rmSync(stateDir, { recursive: true, force: true });
  rmSync(sharedDir, { recursive: true, force: true });
});

describe('import steps of the auth stores', () => {
  it('copies session-limits-since and the WOPI revocations once, leaving the local files alone', async () => {
    const revokedAt = Date.now() - 60_000;
    writeFileSync(path.join(stateDir, 'session-limits-since'), '1700000000000');
    writeFileSync(path.join(stateDir, 'wopi-revocations.json'), JSON.stringify({ 'browser-a:0': revokedAt }));
    const before = [
      readFileSync(path.join(stateDir, 'session-limits-since')),
      readFileSync(path.join(stateDir, 'wopi-revocations.json')),
    ];

    expect(await run()).toEqual({ 'session-limits-since': 1, 'wopi-revocations': 1 });
    expect(await run()).toEqual({ 'session-limits-since': 0, 'wopi-revocations': 0 });

    expect(readFileSync(path.join(stateDir, 'session-limits-since'))).toEqual(before[0]);
    expect(readFileSync(path.join(stateDir, 'wopi-revocations.json'))).toEqual(before[1]);

    // What the replicas now read comes from the store, not the old volume.
    rmSync(stateDir, { recursive: true, force: true });
    expect(await limitsEnforcedSince()).toBe(1_700_000_000_000);
    const payload = { bid: 'browser-a', slot: 0, exp: revokedAt - 1000 + WOPI_TOKEN_TTL_MS } as WopiTokenPayload;
    expect(await isWopiTokenRevoked(payload)).toBe(true);
  });

  it('writes nothing for an install that has neither', async () => {
    expect(await run()).toEqual({ 'session-limits-since': 0, 'wopi-revocations': 0 });
  });
});
