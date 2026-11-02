/**
 * @vitest-environment node
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// The approvals live in the admin config dir itself. Importing them listed
// the whole dir, so any folder in it the server can't read (left there by
// an operator, a backup tool) failed the boot import (#1066). Only
// plugin-approvals.json and plugin-approvals/ are read now.

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  const readdir = (async (p: Parameters<typeof actual.readdir>[0], ...rest: unknown[]) => {
    if (String(p).includes('locked-by-someone')) {
      throw Object.assign(new Error(`EACCES: permission denied, scandir '${String(p)}'`), { code: 'EACCES' });
    }
    return (actual.readdir as (...args: unknown[]) => Promise<unknown>)(p, ...rest);
  }) as typeof actual.readdir;
  return { ...actual, readdir, default: { ...actual, readdir } };
});

import { steps } from '../import/ext';
import { importLocalData } from '../import';
import { setStoreForTests } from '../index';
import { resetLocalStoreForTests } from '../local';
import { separateFakeStore } from '@/lib/admin/__tests__/shared-store-fake';
import { pluginApprovalDocs } from '@/lib/admin/extension-store';

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'bw-import-ext-locked-'));
  vi.stubEnv('ADMIN_CONFIG_DIR', path.join(dir, 'config'));
  vi.stubEnv('ADMIN_STATE_DIR', path.join(dir, 'state'));
  mkdirSync(path.join(dir, 'config', 'locked-by-someone'), { recursive: true });
  mkdirSync(path.join(dir, 'config', 'plugin-approvals'), { recursive: true });
  writeFileSync(path.join(dir, 'config', 'plugin-approvals.json'), JSON.stringify({ entries: [] }));
  writeFileSync(path.join(dir, 'config', 'plugin-approvals', `p-${'a'.repeat(64)}.zip`), 'zip');
  resetLocalStoreForTests();
  setStoreForTests(separateFakeStore(path.join(dir, 'store')));
});

afterEach(() => {
  setStoreForTests(null);
  resetLocalStoreForTests();
  vi.unstubAllEnvs();
  rmSync(dir, { recursive: true, force: true });
});

describe('importing approvals next to a folder that cannot be read', () => {
  it('imports them and does not fail', async () => {
    const approvals = steps.find((s) => s.name === 'plugin-approvals')!;
    expect(await approvals.run()).toBe(2);
    expect(await pluginApprovalDocs().get(`plugin-approvals/p-${'a'.repeat(64)}.zip`)).not.toBeNull();
    await expect(importLocalData(steps)).resolves.toBeTruthy();
  });
});
