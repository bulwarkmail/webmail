// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

// A plugin's admin config was read, changed and written back with nothing
// in between to stop a second save, through one shared ".tmp" file: two
// keys saved at once (the admin form saves each field) lost one of them or
// answered 500.

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'bw-plugin-config-'));
  vi.stubEnv('ADMIN_CONFIG_DIR', dir);
  vi.resetModules();
});

afterEach(async () => {
  vi.unstubAllEnvs();
  await rm(dir, { recursive: true, force: true });
});

describe('plugin config saved at the same time', () => {
  it('keeps every key', async () => {
    const config = await import('../plugin-config');
    const keys = Array.from({ length: 8 }, (_, i) => `key${i}`);
    const results = await Promise.allSettled(keys.map((key, i) => config.setPluginConfig('cloud-sync', key, i)));

    expect(results.filter((r) => r.status === 'rejected')).toEqual([]);
    const expected = Object.fromEntries(keys.map((key, i) => [key, i]));
    expect(await config.getPluginConfig('cloud-sync')).toEqual(expected);
    expect(JSON.parse(await readFile(path.join(dir, 'plugin-config', 'cloud-sync.json'), 'utf-8'))).toEqual(expected);
  });

  it('keeps the other keys when one is deleted while another is set', async () => {
    const config = await import('../plugin-config');
    await config.setPluginConfig('cloud-sync', 'a', 1);
    await config.setPluginConfig('cloud-sync', 'b', 2);
    await Promise.all([config.deletePluginConfigKey('cloud-sync', 'a'), config.setPluginConfig('cloud-sync', 'c', 3)]);
    expect(await config.getPluginConfig('cloud-sync')).toEqual({ b: 2, c: 3 });
  });
});
