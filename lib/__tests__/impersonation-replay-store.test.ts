// @vitest-environment node
import { mkdtempSync, readdirSync, rmSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/logger', () => ({
  logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import { IMPERSONATION_REPLAY_WINDOW_SEC, impersonationReplayCache } from '@/lib/impersonation/jwt';
import { consumeImpersonationJti } from '@/lib/impersonation/replay-store';

// The jti cache lived only in process memory: after a restart, or on another
// replica, a captured handoff link could be redeemed again.

let stateDir: string;
const previous = process.env.ADMIN_STATE_DIR;

beforeEach(() => {
  stateDir = mkdtempSync(path.join(tmpdir(), 'bw-jti-'));
  process.env.ADMIN_STATE_DIR = stateDir;
  impersonationReplayCache.clear();
});

afterEach(() => {
  if (previous === undefined) delete process.env.ADMIN_STATE_DIR;
  else process.env.ADMIN_STATE_DIR = previous;
  rmSync(stateDir, { recursive: true, force: true });
});

describe('consumeImpersonationJti', () => {
  const now = Date.now();
  const exp = Math.floor(now / 1000) + 120;

  it('refuses a jti the second time', async () => {
    expect(await consumeImpersonationJti('jti-1', exp, now)).toBe(true);
    expect(await consumeImpersonationJti('jti-1', exp, now)).toBe(false);
  });

  it('still refuses it after the in-process cache is gone (restart, other replica)', async () => {
    expect(await consumeImpersonationJti('jti-1', exp, now)).toBe(true);
    impersonationReplayCache.clear();
    expect(await consumeImpersonationJti('jti-1', exp, now)).toBe(false);
  });

  it('prunes markers once their token can no longer verify', async () => {
    await consumeImpersonationJti('jti-old', exp, now);
    const dir = path.join(stateDir, 'impersonation-jti');
    const [marker] = readdirSync(dir);
    const old = (now - (IMPERSONATION_REPLAY_WINDOW_SEC + 5) * 1000) / 1000;
    utimesSync(path.join(dir, marker), old, old);

    await consumeImpersonationJti('jti-new', exp, now);
    expect(readdirSync(dir)).toHaveLength(1);
    expect(readdirSync(dir)).not.toContain(marker);
  });
});
