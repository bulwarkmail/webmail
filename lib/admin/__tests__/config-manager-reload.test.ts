// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { configManager } from '../config-manager';

// Several replicas share one config volume. An admin change saved by one has
// to reach the others without a restart.

let dir: string;
let now: number;

/** What another replica's save does: write a temp file, rename it over. */
async function otherReplicaWrites(file: string, data: Record<string, unknown>) {
  const target = path.join(dir, file);
  await writeFile(target + '.other', JSON.stringify(data), 'utf-8');
  await rename(target + '.other', target);
}

beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'bw-config-reload-'));
  vi.stubEnv('ADMIN_CONFIG_DIR', dir);
  now = 1_000_000;
  vi.spyOn(Date, 'now').mockImplementation(() => now);
  await writeFile(path.join(dir, 'config.json'), JSON.stringify({ appName: 'First' }), 'utf-8');
  await writeFile(path.join(dir, 'policy.json'), JSON.stringify({ features: { calendarEnabled: true } }), 'utf-8');
  await configManager.load();
});

afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  await rm(dir, { recursive: true, force: true });
});

describe('config manager picks up changes on disk', () => {
  it('reloads config.json changed by another replica after the check interval', async () => {
    expect(configManager.get('appName')).toBe('First');
    await otherReplicaWrites('config.json', { appName: 'Second name' });

    // Within the interval nothing is checked.
    now += 1_000;
    await configManager.ensureLoaded();
    expect(configManager.get('appName')).toBe('First');

    now += 10_000;
    await configManager.ensureLoaded();
    expect(configManager.get('appName')).toBe('Second name');
  });

  it('reloads policy.json changed by another replica', async () => {
    expect(configManager.getPolicy().features.calendarEnabled).toBe(true);
    await otherReplicaWrites('policy.json', { features: { calendarEnabled: false } });

    now += 10_000;
    await configManager.ensureLoaded();
    expect(configManager.getPolicy().features.calendarEnabled).toBe(false);
  });

  it('a synchronous read starts the check and the next read sees the change', async () => {
    await otherReplicaWrites('config.json', { appName: 'Second name' });
    now += 10_000;
    configManager.get('appName');
    await vi.waitFor(() => expect(configManager.get('appName')).toBe('Second name'));
  });

  it('keeps the values in memory while the changed file is broken', async () => {
    await writeFile(path.join(dir, 'config.json'), '{ not json', 'utf-8');
    vi.spyOn(console, 'error').mockImplementation(() => {});
    now += 10_000;
    await configManager.ensureLoaded();
    expect(configManager.get('appName')).toBe('First');
  });

  it("doesn't undo another replica's change when saving", async () => {
    await otherReplicaWrites('config.json', { appName: 'Second name' });
    await configManager.setAdminConfig({ loginShowVersion: false });

    const onDisk = JSON.parse(await readFile(path.join(dir, 'config.json'), 'utf-8'));
    expect(onDisk).toEqual({ appName: 'Second name', loginShowVersion: false });
  });
});
