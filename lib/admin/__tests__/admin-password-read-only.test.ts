// @vitest-environment node
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';
import { existsSync, rmSync } from 'node:fs';
import path from 'node:path';

// A config dir mounted read-only (Kubernetes ConfigMap, a :ro volume) without
// an admin.json, and ADMIN_PASSWORD in the environment: the admin password
// works from memory on every replica instead of failing the start, which
// kept every replica of a shared-store deployment from ever becoming ready.

// Hoisted: isConfigReadOnly() reads the env once.
const dir = await vi.hoisted(async () => {
  const { mkdtempSync, mkdirSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const root = mkdtempSync(join(tmpdir(), 'bw-admin-pw-ro-'));
  mkdirSync(join(root, 'config'));
  process.env.ADMIN_CONFIG_DIR = join(root, 'config');
  process.env.ADMIN_STATE_DIR = join(root, 'state');
  process.env.ADMIN_CONFIG_READONLY = 'true';
  process.env.ADMIN_PASSWORD = 'from-the-environment';
  return root;
});

import { initAdminPassword, isAdminEnabled, resetAdminCacheForTests, verifyAdminPassword } from '../password';
import { setStoreForTests } from '@/lib/shared-store';
import { resetLocalStoreForTests } from '@/lib/shared-store/local';
import { separateFakeStore } from './shared-store-fake';

afterEach(() => {
  resetAdminCacheForTests();
  setStoreForTests(null);
  resetLocalStoreForTests();
});

afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('ADMIN_PASSWORD with a read-only config and no admin.json', () => {
  it('works from memory on a single instance and writes nothing to the config dir', async () => {
    await expect(initAdminPassword()).resolves.toBe(true);
    expect(isAdminEnabled()).toBe(true);
    expect(await verifyAdminPassword('from-the-environment')).toBe(true);
    expect(await verifyAdminPassword('wrong')).toBe(false);
    expect(existsSync(path.join(dir, 'config', 'admin.json'))).toBe(false);
  });

  it('lets every replica of a shared store start and sign in', async () => {
    setStoreForTests(separateFakeStore(path.join(dir, 'store')));
    for (let replica = 0; replica < 3; replica++) {
      resetAdminCacheForTests();
      await expect(initAdminPassword()).resolves.toBe(true);
      expect(await verifyAdminPassword('from-the-environment')).toBe(true);
      expect(await verifyAdminPassword('wrong')).toBe(false);
    }
    expect(existsSync(path.join(dir, 'config', 'admin.json'))).toBe(false);
  });
});
