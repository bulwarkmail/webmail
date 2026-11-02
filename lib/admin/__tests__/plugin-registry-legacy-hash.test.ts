// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { setStoreForTests, StoreUnavailableError, type CollectionOptions } from '@/lib/shared-store';
import { resetLocalStoreForTests } from '@/lib/shared-store/local';
import { separateFakeStore } from './shared-store-fake';

// Registry entries from old builds carry a 16-character bundle hash, which
// is replaced by the full hash of the stored bundle (or cleared when the
// bundle is gone). A shared-store hiccup while reading the bundle (#1066)
// is not "the bundle is gone": clearing the hash then made clients skip the
// integrity check and dropped the hash from the stored registry for good.

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'bw-legacy-hash-'));
  vi.stubEnv('ADMIN_CONFIG_DIR', path.join(dir, 'config'));
  resetLocalStoreForTests();
  vi.resetModules();
  delete (globalThis as Record<symbol, unknown>)[Symbol.for('bulwark.admin.pluginRegistry')];
});

afterEach(() => {
  setStoreForTests(null);
  resetLocalStoreForTests();
  vi.unstubAllEnvs();
  rmSync(dir, { recursive: true, force: true });
});

describe('legacy short bundle hashes', () => {
  it('keeps the hash when the bundle read hits a store outage', async () => {
    const store = separateFakeStore(path.join(dir, 'store'));
    const collection = store.collection.bind(store);
    let blip = true;
    store.collection = (name: string, options: CollectionOptions) => {
      const docs = collection(name, options);
      return { ...docs, get: (id: string) => (blip && id === 'demo.js' ? Promise.reject(new StoreUnavailableError('blip')) : docs.get(id)) };
    };
    setStoreForTests(store);
    const { pluginDocs } = await import('../extension-store');
    const { getPluginRegistry } = await import('../plugin-registry');
    await pluginDocs().put('registry.json', JSON.stringify({ plugins: [{ id: 'demo', bundleHash: 'abcdef0123456789', enabled: true }] }));
    await pluginDocs().put('demo.js', 'code()');

    const registry = await getPluginRegistry();
    expect(registry.plugins[0].bundleHash).toBe('abcdef0123456789');
    blip = false;
    expect(JSON.parse((await pluginDocs().get('registry.json'))!.data.toString()).plugins[0].bundleHash).toBe('abcdef0123456789');

    // Once the store answers, the hash is fixed.
    expect((await getPluginRegistry()).plugins[0].bundleHash).toMatch(/^[0-9a-f]{64}$/);
  });
});
