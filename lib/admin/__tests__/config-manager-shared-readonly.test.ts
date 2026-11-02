// @vitest-environment node
import { afterAll, describe, expect, it, vi } from 'vitest';
import { rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';

// With ADMIN_CONFIG_READONLY (a Kubernetes ConfigMap) every replica reads
// config.json and policy.json from the mounted files, also with a shared
// store, and a changed ConfigMap reaches them without a restart.

// Hoisted: isConfigReadOnly() reads the env once.
const dir = await vi.hoisted(async () => {
  const { mkdtempSync, writeFileSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const config = mkdtempSync(join(tmpdir(), 'bw-config-shared-ro-'));
  writeFileSync(join(config, 'config.json'), JSON.stringify({ appName: 'Mounted' }));
  process.env.ADMIN_CONFIG_DIR = config;
  process.env.ADMIN_CONFIG_READONLY = 'true';
  return config;
});

import { configManager } from '../config-manager';
import { setStoreForTests } from '@/lib/shared-store';
import { separateFakeStore } from './shared-store-fake';

afterAll(async () => {
  setStoreForTests(null);
  vi.restoreAllMocks();
  await rm(dir, { recursive: true, force: true });
});

describe('read-only config with a shared store', () => {
  it('reads the mounted files and follows a change to them', async () => {
    setStoreForTests(separateFakeStore(path.join(dir, 'store')));
    let now = 1_000_000;
    vi.spyOn(Date, 'now').mockImplementation(() => now);
    await configManager.load();
    expect(configManager.get('appName')).toBe('Mounted');

    await writeFile(path.join(dir, 'config.json.new'), JSON.stringify({ appName: 'Updated ConfigMap' }));
    await rename(path.join(dir, 'config.json.new'), path.join(dir, 'config.json'));
    now += 10_000;
    await configManager.ensureLoaded();
    expect(configManager.get('appName')).toBe('Updated ConfigMap');

    await expect(configManager.setAdminConfig({ appName: 'x' })).rejects.toThrow(/read-only/);
  });
});
