// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { NextRequest } from 'next/server';

// Several replicas share one store (#1066). An admin change saved on one
// has to reach the others within seconds, two admins saving different keys
// at once both have to win, and a policy page opened before someone else's
// save must not put the old policy back.

vi.mock('@/lib/auth/instance-details', () => ({
  canSeeInstanceDetails: async () => true,
  signedInIdentity: async () => ({ admin: true }),
}));
vi.mock('@/lib/admin/session', () => ({
  requireAdminAuth: async () => ({ payload: { role: 'admin' } }),
  getClientIP: () => '127.0.0.1',
}));
vi.mock('@/lib/admin/audit', () => ({ auditLog: async () => {} }));
vi.mock('@/lib/admin/csp-frame-origins', () => ({ getEnabledPluginFrameOrigins: vi.fn(async () => []) }));
vi.mock('@/lib/wopi/discovery', () => ({ getWopiEditorOrigins: vi.fn(async () => []) }));
vi.mock('next-intl/middleware', async () => {
  const { NextResponse } = await import('next/server');
  return { default: () => () => NextResponse.next() };
});

import { configManager } from '../config-manager';
import { adminConfigDocs } from '../admin-store';
import { forgetExtensionInPolicy } from '../extension-cleanup';
import { setBootState, setStoreForTests } from '@/lib/shared-store';
import { resetLocalStoreForTests } from '@/lib/shared-store/local';
import { INIT_EPOCH, markEpochsSeen, pollChanges, resetChangesForTests } from '@/lib/shared-store/changes';
import { GET, PUT } from '@/app/api/admin/policy/route';
import { proxy } from '@/proxy';
import { separateFakeStore } from './shared-store-fake';

let dir: string;
let store: ReturnType<typeof separateFakeStore>;
/** Runs inside the store's document calls, to land another replica's change mid-request. */
const hooks: { onGet?: (id: string) => Promise<void>; afterUpdate?: (id: string) => Promise<void> } = {};

const stored = async (id: string) => {
  const doc = await adminConfigDocs().get(id);
  return doc ? JSON.parse(doc.data.toString('utf-8')) : null;
};

/** What another replica's save does: write the stored document, then announce it. */
async function otherReplicaSaves(id: 'config.json' | 'policy.json', data: Record<string, unknown>, announce = true) {
  await adminConfigDocs().put(id, JSON.stringify(data, null, 2));
  if (announce) await store.epochs.bump(id === 'config.json' ? 'config' : 'policy');
}

/** A second replica's config manager: a fresh module copy with its own instance. */
async function otherReplicaManager() {
  const KEY = Symbol.for('bulwark.admin.configManager');
  const g = globalThis as Record<symbol, unknown>;
  const mine = g[KEY];
  delete g[KEY];
  vi.resetModules();
  const { configManager: other } = await import('../config-manager');
  g[KEY] = mine;
  await other.load();
  return other;
}

beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'bw-config-shared-'));
  vi.stubEnv('ADMIN_CONFIG_DIR', path.join(dir, 'config'));
  vi.stubEnv('ADMIN_STATE_DIR', path.join(dir, 'state'));
  resetLocalStoreForTests();
  resetChangesForTests();
  store = separateFakeStore(path.join(dir, 'store'));
  const collection = store.collection.bind(store);
  store.collection = (name, options) => {
    const docs = collection(name, options);
    return {
      ...docs,
      get: async (id) => {
        await hooks.onGet?.(id);
        return docs.get(id);
      },
      update: async (id, fn, updateOptions) => {
        const result = await docs.update(id, fn, updateOptions);
        const hook = hooks.afterUpdate;
        hooks.afterUpdate = undefined;
        await hook?.(id);
        return result;
      },
    };
  };
  setStoreForTests(store);
  await store.epochs.bump(INIT_EPOCH);
  await adminConfigDocs().put('config.json', JSON.stringify({ appName: 'First', setupComplete: true }));
  await adminConfigDocs().put('policy.json', JSON.stringify({ features: { pluginsEnabled: false } }));
  await markEpochsSeen();
  await configManager.load();
  setBootState('ready');
});

afterEach(async () => {
  hooks.onGet = undefined;
  hooks.afterUpdate = undefined;
  setStoreForTests(null);
  resetChangesForTests();
  resetLocalStoreForTests();
  vi.unstubAllEnvs();
  await rm(dir, { recursive: true, force: true });
});

describe('config manager with a shared store', () => {
  it('loads from the store and writes nothing to the local config dir', async () => {
    expect(configManager.get('appName')).toBe('First');
    await configManager.setAdminConfig({ loginShowVersion: false });
    expect(await stored('config.json')).toEqual({ appName: 'First', setupComplete: true, loginShowVersion: false });
    expect(existsSync(path.join(dir, 'config', 'config.json'))).toBe(false);
  });

  it('picks up a config change from another replica on the next poll', async () => {
    await otherReplicaSaves('config.json', { appName: 'Second name', setupComplete: true });
    await pollChanges();
    expect(configManager.get('appName')).toBe('Second name');
  });

  it('gives the proxy a policy change from another replica', async () => {
    const sandbox = () => proxy(new NextRequest('http://localhost:3000/plugin-sandbox/frame', { headers: { 'sec-fetch-dest': 'iframe' } }));
    expect((await sandbox()).status).toBe(403);

    await otherReplicaSaves('policy.json', { features: { pluginsEnabled: true } });
    await pollChanges();
    expect(configManager.getPolicy().features.pluginsEnabled).toBe(true);
    expect((await sandbox()).status).not.toBe(403);
  });

  it('keeps both of two admins\' saves of different keys on two replicas', async () => {
    const other = await otherReplicaManager();
    await Promise.all([
      configManager.setAdminConfig({ appName: 'From A' }),
      other.setAdminConfig({ loginShowVersion: false }),
    ]);
    expect(await stored('config.json')).toEqual({ appName: 'From A', setupComplete: true, loginShowVersion: false });

    // A replica that starts now reads both.
    const third = await otherReplicaManager();
    expect(third.get('appName')).toBe('From A');
    expect(third.get('loginShowVersion')).toBe(false);
  });

  it('merges a save into the stored config, not into this replica\'s older copy', async () => {
    // Another replica saved, and its notice hasn't arrived yet.
    await otherReplicaSaves('config.json', { appName: 'Second name', setupComplete: true }, false);
    await configManager.removeAdminOverride('loginShowVersion');
    await configManager.setAdminConfig({ loginShowVersion: true });
    expect(await stored('config.json')).toEqual({ appName: 'Second name', setupComplete: true, loginShowVersion: true });
    expect(configManager.get('appName')).toBe('Second name');
  });

  it('marks setup complete in the store, so every replica leaves the wizard', async () => {
    await otherReplicaSaves('config.json', { appName: 'First' });
    await pollChanges();
    expect(configManager.isSetupComplete()).toBe(false);
    await configManager.markSetupComplete();
    const other = await otherReplicaManager();
    expect(other.isSetupComplete()).toBe(true);
  });

  it('keeps serving the last loaded config while the store is down', async () => {
    store.down = true;
    await otherReplicaSaves('config.json', { appName: 'Unreachable' }).catch(() => {});
    await store.epochs.bump('config');
    await pollChanges();
    await configManager.ensureLoaded();
    expect(configManager.get('appName')).toBe('First');
    await expect(configManager.setAdminConfig({ appName: 'Nope' })).rejects.toThrow(/down/);

    store.down = false;
    await otherReplicaSaves('config.json', { appName: 'Back', setupComplete: true });
    await pollChanges();
    expect(configManager.get('appName')).toBe('Back');
  });
});

describe('change notices racing writes', () => {
  it('fails a reload when writes of this replica kept landing while it read, so the poller tries again', async () => {
    let reads = 0;
    let n = 0;
    hooks.onGet = async (id) => {
      if (id !== 'config.json') return;
      reads++;
      await configManager.setAdminConfig({ loginShowVersion: ++n % 2 === 0 });
    };
    // The listener the change poller runs for a remote change.
    const reload = (configManager as unknown as { reloadShared(area: string): Promise<void> }).reloadShared('config');
    await expect(reload).rejects.toThrow(/kept changing/);
    expect(reads).toBe(3);
  });

  it('keeps another replica\'s change that was reloaded while a save of this one was in flight', async () => {
    hooks.afterUpdate = async () => {
      const current = await stored('config.json');
      await otherReplicaSaves('config.json', { ...current, appName: 'Saved elsewhere' });
      await pollChanges();
    };
    await configManager.setAdminConfig({ loginShowVersion: false });
    expect(configManager.get('appName')).toBe('Saved elsewhere');
    expect(configManager.get('loginShowVersion')).toBe(false);
  });
});

describe('updateAdminConfig with a shared store', () => {
  it('builds each of two saves on two replicas on the other\'s result', async () => {
    const other = await otherReplicaManager();
    const add = (host: string) => (list: Array<{ host: string }>) => [...list, { host }];
    await Promise.all([
      configManager.updateAdminConfig('domainBranding', add('a.example'), []),
      other.updateAdminConfig('domainBranding', add('b.example'), []),
    ]);
    const hosts = (await stored('config.json')).domainBranding.map((e: { host: string }) => e.host).sort();
    expect(hosts).toEqual(['a.example', 'b.example']);
  });

  it('starts from the value get() would give and leaves the config alone on undefined', async () => {
    vi.stubEnv('APP_NAME', 'From env');
    expect(await configManager.updateAdminConfig<string>('appName', (current) => `${current}!`)).toBe('First!');
    await configManager.removeAdminOverride('appName');
    expect(await configManager.updateAdminConfig<string>('appName', (current) => `${current}!`)).toBe('From env!');
    const before = await adminConfigDocs().get('config.json');
    expect(await configManager.updateAdminConfig('appName', () => undefined)).toBeUndefined();
    expect((await adminConfigDocs().get('config.json'))!.version).toBe(before!.version);
  });
});

describe('policy saves with a shared store', () => {
  it('lets a save replace a stored policy that doesn\'t parse', async () => {
    await adminConfigDocs().put('policy.json', '{ not json');
    await store.epochs.bump('policy');
    await pollChanges();
    const page = await load();
    expect(page.etag).toBe(`"${(await adminConfigDocs().get('policy.json'))!.version}"`);
    expect((await save(page.policy, page.etag)).status).toBe(200);
    expect(await stored('policy.json')).toMatchObject({ features: page.policy.features });

    // The same after a restart.
    await adminConfigDocs().put('policy.json', '{ not json');
    await configManager.reload();
    const again = await load();
    expect((await save(again.policy, again.etag)).status).toBe(200);
  });

  it('answers a save with the stored policy and its version', async () => {
    const page = await load();
    const res = await save({ ...page.policy, features: { ...page.policy.features, calendarEnabled: false } }, page.etag);
    const body = await res.json();
    expect(body.policy.features.calendarEnabled).toBe(false);
    expect(body.policy.scopes).toEqual([]);
    expect(res.headers.get('ETag')).toBe(`"${(await adminConfigDocs().get('policy.json'))!.version}"`);
  });

  async function load() {
    const res = await GET(new NextRequest('https://mail.example/api/admin/policy'));
    return { policy: await res.json(), etag: res.headers.get('ETag')! };
  }
  const save = (policy: Record<string, unknown>, etag?: string) => PUT(new NextRequest('https://mail.example/api/admin/policy', {
    method: 'PUT',
    headers: { 'content-type': 'application/json', ...(etag ? { 'if-match': etag } : {}) },
    body: JSON.stringify(policy),
  }));

  it('refuses a save from a page opened before another replica saved, and keeps that save', async () => {
    const page = await load();
    // Saved on another replica; this one hasn't heard of it yet.
    await otherReplicaSaves('policy.json', { features: { pluginsEnabled: true, calendarEnabled: false } }, false);

    const res = await save({ ...page.policy, features: { ...page.policy.features, filesEnabled: false } }, page.etag);
    expect(res.status).toBe(409);
    expect((await res.json()).error).toMatch(/^Someone else changed the policy after you opened this page/);
    expect(await stored('policy.json')).toEqual({ features: { pluginsEnabled: true, calendarEnabled: false } });
    // The refusal brought this replica up to date.
    expect(configManager.getPolicy().features.pluginsEnabled).toBe(true);

    const fresh = await load();
    const ok = await save({ ...fresh.policy, features: { ...fresh.policy.features, filesEnabled: false } }, fresh.etag);
    expect(ok.status).toBe(200);
    expect((await stored('policy.json')).features).toMatchObject({ pluginsEnabled: true, calendarEnabled: false, filesEnabled: false });
  });

  it('drops a deleted plugin from the stored policy without undoing another replica\'s save', async () => {
    await otherReplicaSaves('policy.json', { features: { calendarEnabled: false }, forceEnabledPlugins: ['demo', 'other'] }, false);
    await forgetExtensionInPolicy('plugin', 'demo');
    const policy = await stored('policy.json');
    expect(policy.forceEnabledPlugins).toEqual(['other']);
    expect(policy.features.calendarEnabled).toBe(false);
  });

  it('answers a page that loaded before any policy was saved with 409 once one is', async () => {
    await adminConfigDocs().delete('policy.json');
    await configManager.reload();
    const page = await load();
    expect(page.etag).toBe('"default"');
    await otherReplicaSaves('policy.json', { features: { calendarEnabled: false } }, false);
    expect((await save(page.policy, page.etag)).status).toBe(409);
  });

  it('leaves the local policy file alone', async () => {
    const page = await load();
    expect((await save(page.policy, page.etag)).status).toBe(200);
    await expect(readFile(path.join(dir, 'config', 'policy.json'))).rejects.toThrow();
  });
});
