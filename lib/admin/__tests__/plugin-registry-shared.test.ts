// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { NextRequest } from 'next/server';
import JSZip from 'jszip';

// Several replicas share one store (#1066): a plugin or theme installed
// through one replica must be listed and served by every other one, two
// installs at once on different replicas must both stay in the registry,
// and an install while the store is down must answer 503 and leave nothing
// half-written behind.

vi.mock('@/lib/admin/session', () => ({
  requireAdminAuth: vi.fn(async () => ({ session: { sub: 'admin' } })),
  getClientIP: () => '127.0.0.1',
}));
vi.mock('@/lib/admin/audit', () => ({ auditLog: vi.fn(async () => {}) }));
vi.mock('@/lib/admin/config-manager', () => ({
  configManager: {
    ensureLoaded: vi.fn(async () => {}),
    get: vi.fn(() => undefined),
    getPolicy: vi.fn(() => ({ forceEnabledPlugins: [] })),
    updatePolicy: vi.fn(async () => {}),
  },
}));
vi.mock('@/lib/admin/plugin-dev', () => ({
  listDevPlugins: vi.fn(async () => []),
  getDevPlugin: vi.fn(async () => null),
  readDevBundle: vi.fn(),
}));
vi.mock('@/lib/auth/instance-details', () => ({ canSeeInstanceDetails: vi.fn(async () => true) }));

import { setStoreForTests } from '@/lib/shared-store';
import { resetLocalStoreForTests } from '@/lib/shared-store/local';
import { INIT_EPOCH, resetChangesForTests } from '@/lib/shared-store/changes';
import { separateFakeStore } from './shared-store-fake';

const MANIFEST = {
  id: 'demo-plugin', name: 'Demo', version: '1.0.0', author: 'me', description: 'd',
  type: 'hook', permissions: ['email:read'], entrypoint: 'index.js',
};
const PLUGIN = {
  id: 'pp', name: 'P', version: '1.0.0', author: 'a', description: '', type: 'hook',
  permissions: [], entrypoint: 'index.js', enabled: true, installedAt: 'x', updatedAt: 'x',
};

let dir: string;
let store: ReturnType<typeof separateFakeStore>;

/**
 * Another replica: fresh module copies and nothing of this process's
 * memory (registry copy, bundle cache, write queue, signing key). Only the
 * shared store is common.
 */
async function otherReplica() {
  const g = globalThis as Record<symbol, unknown>;
  for (const name of ['bulwark.admin.pluginRegistry', 'bulwark.admin.bundleCache', 'bulwark.admin.pluginSigning']) {
    delete g[Symbol.for(name)];
  }
  vi.resetModules();
  return {
    registry: await import('../plugin-registry'),
    plugins: await import('@/app/api/admin/plugins/route'),
    themes: await import('@/app/api/admin/themes/route'),
    bundle: await import('@/app/api/admin/plugins/[id]/bundle/route'),
    themeCss: await import('@/app/api/admin/themes/[id]/css/route'),
  };
}

async function zipOf(files: Record<string, string>) {
  const zip = new JSZip();
  for (const [n, d] of Object.entries(files)) zip.file(n, d);
  return zip.generateAsync({ type: 'uint8array', compression: 'DEFLATE' });
}

async function install(replica: Awaited<ReturnType<typeof otherReplica>>, code: string) {
  const form = new FormData();
  const bytes = await zipOf({ 'manifest.json': JSON.stringify(MANIFEST), 'index.js': code });
  form.append('file', new File([bytes as BlobPart], 'p.zip', { type: 'application/zip' }));
  return replica.plugins.POST(new NextRequest('http://localhost/api/admin/plugins', { method: 'POST', body: form }));
}

function getBundle(replica: Awaited<ReturnType<typeof otherReplica>>, id = MANIFEST.id) {
  return replica.bundle.GET(new NextRequest(`http://localhost/api/admin/plugins/${id}/bundle`), { params: Promise.resolve({ id }) });
}

const localPluginsDir = () => path.join(dir, 'config', 'plugins');

beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'bw-registry-shared-'));
  vi.stubEnv('ADMIN_CONFIG_DIR', path.join(dir, 'config'));
  vi.stubEnv('ADMIN_STATE_DIR', path.join(dir, 'state'));
  vi.stubEnv('PLUGIN_SIGNING_KEY_FILE', '');
  resetLocalStoreForTests();
  resetChangesForTests();
  store = separateFakeStore(path.join(dir, 'store'));
  setStoreForTests(store);
  await store.epochs.bump(INIT_EPOCH);
});

afterEach(async () => {
  setStoreForTests(null);
  resetLocalStoreForTests();
  resetChangesForTests();
  vi.unstubAllEnvs();
  await rm(dir, { recursive: true, force: true });
});

describe('plugins in the shared store', () => {
  it('lists and serves on another replica a plugin installed through one', async () => {
    const a = await otherReplica();
    const code = 'module.exports = { hello: 1 }';
    expect((await install(a, code)).status).toBe(200);
    expect((await store.epochs.all()).plugins).toBeGreaterThan(0);

    const b = await otherReplica();
    const list = await (await b.plugins.GET(new NextRequest('http://localhost/api/admin/plugins'))).json();
    expect(list.map((p: { id: string }) => p.id)).toEqual([MANIFEST.id]);

    const res = await getBundle(b);
    expect(res.status).toBe(200);
    expect(await res.text()).toBe(code);
    expect(res.headers.get('etag')).toBe(`"${createHash('sha256').update(code).digest('hex')}"`);
    expect(res.headers.get('x-bundle-signature')).toBeTruthy();

    // Nothing went to this replica's own config dir.
    expect(existsSync(localPluginsDir())).toBe(false);
  });

  it('keeps serving a bundle it already served while the store is down', async () => {
    const a = await otherReplica();
    await install(a, 'module.exports = { cached: true }');
    const b = await otherReplica();
    expect((await getBundle(b)).status).toBe(200);

    store.down = true;
    const res = await getBundle(b);
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('module.exports = { cached: true }');

    // A replica that never read it can't: 503, not "not found".
    const c = await otherReplica();
    expect((await getBundle(c)).status).toBe(503);
  });

  it('serves the new bundle on another replica after an update', async () => {
    const a = await otherReplica();
    const b = await otherReplica();
    await install(a, 'v1()');
    expect(await (await getBundle(b)).text()).toBe('v1()');
    await install(a, 'v2()');
    expect(await (await getBundle(b)).text()).toBe('v2()');
    expect(existsSync(localPluginsDir())).toBe(false);
  });

  it('keeps both plugins when two replicas install different ones at once', async () => {
    const replicas = await Promise.all([otherReplica(), otherReplica()]);
    // Each starts its install with nothing shared in memory.
    const runs = replicas.map((r, i) => {
      delete (globalThis as Record<symbol, unknown>)[Symbol.for('bulwark.admin.pluginRegistry')];
      return r.registry.savePlugin({ ...PLUGIN, id: `plugin-${i}a` }, `code${i}()`);
    });
    await Promise.all(runs);

    const c = await otherReplica();
    expect((await c.registry.getPluginRegistry()).plugins.map((p) => p.id).sort()).toEqual(['plugin-0a', 'plugin-1a']);
    const docs = (await import('../extension-store')).pluginDocs();
    expect(JSON.parse((await docs.get('registry.json'))!.data.toString()).plugins).toHaveLength(2);
  });

  it('answers 503 for an install while the store is down and writes nothing', async () => {
    const a = await otherReplica();
    store.down = true;
    const res = await install(a, 'module.exports = {}');
    expect(res.status).toBe(503);

    store.down = false;
    const docs = (await import('../extension-store')).pluginDocs();
    expect(await docs.list('')).toEqual([]);
    expect(existsSync(localPluginsDir())).toBe(false);
  });

  it('answers 503 and writes nothing when the store goes down after the registry was read', async () => {
    const a = await otherReplica();
    await a.registry.getPluginRegistry();
    store.down = true;
    expect((await install(a, 'module.exports = {}')).status).toBe(503);

    store.down = false;
    const docs = (await import('../extension-store')).pluginDocs();
    expect(await docs.list('')).toEqual([]);
  });

  it('fixes an old short bundle hash without losing an install that lands at the same time', async () => {
    const docs = (await import('../extension-store')).pluginDocs();
    await docs.put('old-one.js', 'old()');
    await docs.put('registry.json', JSON.stringify({ plugins: [{ ...PLUGIN, id: 'old-one', bundleHash: 'abcdef0123456789' }] }));

    const [a, b] = await Promise.all([otherReplica(), otherReplica()]);
    await Promise.all([a.registry.getPluginRegistry(), b.registry.savePlugin({ ...PLUGIN, id: 'new-one' }, 'new()')]);

    const stored = JSON.parse((await docs.get('registry.json'))!.data.toString());
    expect(stored.plugins.map((p: { id: string }) => p.id).sort()).toEqual(['new-one', 'old-one']);
    expect(stored.plugins.find((p: { id: string }) => p.id === 'old-one').bundleHash)
      .toBe(createHash('sha256').update('old()').digest('hex'));
  });

  it('keeps the history in the store and rolls back on another replica', async () => {
    const a = await otherReplica();
    await a.registry.savePlugin(PLUGIN, 'v1()');
    await a.registry.savePlugin({ ...PLUGIN, version: '1.1.0' }, 'v2()');

    const b = await otherReplica();
    const history = await import('../extension-history');
    expect((await history.listHistory('plugin', 'pp')).map((h) => h.version)).toEqual(['1.0.0']);
    const kept = await history.readHistoryEntry('plugin', 'pp', '1.0.0');
    expect(kept.code).toBe('v1()');
    await b.registry.deletePlugin('pp');
    expect(await history.listHistory('plugin', 'pp')).toEqual([]);
    expect(existsSync(localPluginsDir())).toBe(false);
  });
});

describe('lists while the store is down', () => {
  it('answer 503 on a replica that has no copy yet, not 500', async () => {
    store.down = true;
    const r = await otherReplica();
    const history = await import('@/app/api/admin/extensions/[kind]/[id]/history/route');
    const publicList = await import('@/app/api/plugins/route');
    const responses = await Promise.all([
      r.plugins.GET(new NextRequest('http://localhost/api/admin/plugins')),
      r.themes.GET(new NextRequest('http://localhost/api/admin/themes')),
      history.GET(new NextRequest('http://localhost/api/admin/extensions/plugin/demo-plugin/history'), { params: Promise.resolve({ kind: 'plugin', id: 'demo-plugin' }) }),
      publicList.GET(new NextRequest('http://localhost/api/plugins')),
    ]);
    expect(responses.map((res) => res.status)).toEqual([503, 503, 503, 503]);
  });
});

describe('one change of the registry at a time across replicas', () => {
  const LEASE = 'extension-registry-plugins';

  it('refuses an install with 503 while another replica holds the registry, and writes nothing', async () => {
    const a = await otherReplica();
    a.registry.setRegistryLeaseTimingForTests({ waitMs: 200 });
    expect(await store.leases.acquire(LEASE, 'replica-b-install', 60_000)).toBe(true);

    expect((await install(a, 'module.exports = {}')).status).toBe(503);
    const docs = (await import('../extension-store')).pluginDocs();
    expect(await docs.list('')).toEqual([]);

    await store.leases.release(LEASE, 'replica-b-install');
    expect((await install(a, 'module.exports = {}')).status).toBe(200);
  });

  it('keeps the lease while a slow install runs', async () => {
    const a = await otherReplica();
    a.registry.setRegistryLeaseTimingForTests({ ttlMs: 90, waitMs: 50 });
    // Writing the bundle takes longer than the lease lasts.
    const collection = store.collection.bind(store);
    store.collection = (name, options) => {
      const docs = collection(name, options);
      return { ...docs, put: async (...args: Parameters<typeof docs.put>) => {
        if (args[0] === `${PLUGIN.id}.js`) await new Promise((r) => setTimeout(r, 300));
        return docs.put(...args);
      } };
    };
    const saving = a.registry.savePlugin(PLUGIN, 'slow()');
    await new Promise((r) => setTimeout(r, 200));
    // Another replica tries to take over the registry meanwhile.
    expect(await store.leases.acquire(LEASE, 'replica-b', 1_000)).toBe(false);
    await expect(saving).resolves.toBeUndefined();
    store.collection = collection;
    expect((await a.registry.getPlugin(PLUGIN.id))?.bundleHash).toBe(createHash('sha256').update('slow()').digest('hex'));
  });

  it('leaves the registry alone when the lease was lost, and every replica refuses the torn bundle', async () => {
    const a = await otherReplica();
    await a.registry.savePlugin(PLUGIN, 'v1()');
    // The lease runs out mid-install (a stall) and another replica takes it.
    const holder = store.leases.holder.bind(store.leases);
    store.leases.holder = async () => 'replica-b';
    await expect(a.registry.savePlugin({ ...PLUGIN, version: '2.0.0' }, 'v2()')).rejects.toMatchObject({ name: 'StoreUnavailableError' });
    store.leases.holder = holder;

    const registry = JSON.parse((await (await import('../extension-store')).pluginDocs().get('registry.json'))!.data.toString());
    expect(registry.plugins[0]).toMatchObject({ version: '1.0.0', bundleHash: createHash('sha256').update('v1()').digest('hex') });

    for (let i = 0; i < 2; i++) {
      const replica = await otherReplica();
      const res = await getBundle(replica, PLUGIN.id);
      expect(res.status).toBe(409);
      expect((await res.json()).error).toContain('Install it again');
    }
  });
});

describe('themes in the shared store', () => {
  it('serves on another replica a theme installed through one', async () => {
    const a = await otherReplica();
    await a.registry.saveTheme(
      { id: 'dark-blue', name: 'Dark blue', version: '1.0.0', author: 'a', description: '', variants: ['dark'], enabled: true, installedAt: 'x', updatedAt: 'x' },
      ':root { --x: 1 }',
      '.skin {}',
    );
    expect((await store.epochs.all()).themes).toBeGreaterThan(0);

    const b = await otherReplica();
    const res = await b.themeCss.GET(new NextRequest('http://localhost/api/admin/themes/dark-blue/css'), { params: Promise.resolve({ id: 'dark-blue' }) });
    expect(res.status).toBe(200);
    expect(await res.text()).toBe(':root { --x: 1 }');
    expect(await b.registry.getThemeSkin('dark-blue')).toBe('.skin {}');
    expect(existsSync(path.join(dir, 'config', 'themes'))).toBe(false);

    store.down = true;
    const c = await otherReplica();
    const down = await c.themeCss.GET(new NextRequest('http://localhost/api/admin/themes/dark-blue/css'), { params: Promise.resolve({ id: 'dark-blue' }) });
    expect(down.status).toBe(503);
  });
});
