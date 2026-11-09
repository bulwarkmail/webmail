// @vitest-environment node
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Next loads lib/telemetry and lib/version-check once per bundle. The timer
// sat in a module-level variable, so the admin route's reschedule() acted on
// its own copy: the timer instrumentation started kept running next to the
// new one (two heartbeats), and turning consent off didn't stop it.

vi.mock('@/lib/admin/third-party-mode', () => ({ isNoThirdPartyTrafficOn: async () => false }));

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'bw-scheduler-copies-'));
  vi.stubEnv('TELEMETRY_DATA_DIR', path.join(dir, 'telemetry'));
  vi.stubEnv('VERSION_CHECK_DATA_DIR', path.join(dir, 'version-check'));
  vi.stubEnv('BULWARK_TELEMETRY', 'on');
  vi.stubEnv('BULWARK_UPDATE_CHECK', '');
  vi.stubEnv('BULWARK_UPDATE_CHECK_URL', 'https://version.example/');
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  vi.resetModules();
  rmSync(dir, { recursive: true, force: true });
});

async function copy<T>(load: () => Promise<T>): Promise<T> {
  vi.resetModules();
  return load();
}

describe('scheduler timers across module copies', () => {
  it('telemetry: a stop from another copy clears the running timer, a restart leaves one', async () => {
    const instrumentation = await copy(() => import('@/lib/telemetry/sender'));
    const route = await copy(() => import('@/lib/telemetry/sender'));

    await instrumentation.startScheduler();
    expect(vi.getTimerCount()).toBe(1);
    await route.startScheduler();
    expect(vi.getTimerCount()).toBe(1);
    await route.stopScheduler();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('version check: the same', async () => {
    const instrumentation = await copy(() => import('@/lib/version-check/sender'));
    const route = await copy(() => import('@/lib/version-check/sender'));

    await instrumentation.startScheduler();
    expect(vi.getTimerCount()).toBe(1);
    await route.startScheduler();
    expect(vi.getTimerCount()).toBe(1);
    await route.stopScheduler();
    expect(vi.getTimerCount()).toBe(0);
  });
});
