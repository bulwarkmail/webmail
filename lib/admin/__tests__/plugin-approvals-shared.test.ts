// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { setStoreForTests } from '@/lib/shared-store';
import { resetLocalStoreForTests } from '@/lib/shared-store/local';
import { INIT_EPOCH, markEpochsSeen, pollChanges, resetChangesForTests } from '@/lib/shared-store/changes';
import { separateFakeStore } from './shared-store-fake';

// Several replicas share one store (#1066): a user's approval request
// reaches whichever replica the admin's decision goes to, and the decision
// made there reaches every replica on its next change poll, including the
// plugin-secrets gate, which lets a user store a credential only for an
// approved plugin. Plugin config changes on two replicas at once both stay.

const HASH = 'a'.repeat(64);
const CLOUD = { scope: 'user' as const, label: 'Cloud', inject: { type: 'basic' as const } };

let dir: string;
let store: ReturnType<typeof separateFakeStore>;

// This process's memory, including which store epochs it has seen.
const KEYS = ['bulwark.admin.pluginApprovals', 'bulwark.admin.pluginRegistry', 'bulwark.admin.pluginConfig.lastGood', 'bulwark.sharedStore.changes'].map((k) => Symbol.for(k));

/**
 * Run `fn` as another replica would: with module copies of its own and
 * none of this process's memory. This process's memory is put back after.
 */
async function onOtherReplica<T>(fn: (mods: {
  approvals: typeof import('../plugin-approvals');
  config: typeof import('../plugin-config');
}) => Promise<T>): Promise<T> {
  const g = globalThis as Record<symbol, unknown>;
  const mine = KEYS.map((k) => g[k]);
  KEYS.forEach((k) => delete g[k]);
  vi.resetModules();
  try {
    return await fn({ approvals: await import('../plugin-approvals'), config: await import('../plugin-config') });
  } finally {
    KEYS.forEach((k, i) => (mine[i] === undefined ? delete g[k] : (g[k] = mine[i])));
  }
}

beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'bw-approvals-shared-'));
  vi.stubEnv('ADMIN_CONFIG_DIR', path.join(dir, 'config'));
  vi.stubEnv('ADMIN_STATE_DIR', path.join(dir, 'state'));
  resetLocalStoreForTests();
  resetChangesForTests();
  const g = globalThis as Record<symbol, unknown>;
  KEYS.forEach((k) => delete g[k]);
  store = separateFakeStore(path.join(dir, 'store'));
  setStoreForTests(store);
  await store.epochs.bump(INIT_EPOCH);
  await markEpochsSeen();
  vi.resetModules();
});

afterEach(async () => {
  setStoreForTests(null);
  resetLocalStoreForTests();
  resetChangesForTests();
  vi.unstubAllEnvs();
  await rm(dir, { recursive: true, force: true });
});

describe('plugin approvals in the shared store', () => {
  it('shows a decision made on another replica here and to the credential gate after one poll', async () => {
    const approvals = await import('../plugin-approvals');
    const { declaredUserCredential } = await import('@/lib/plugin-secrets/known-plugins');
    await approvals.requestApproval('cloud-sync', HASH, { name: 'Cloud', credentials: { cloud: CLOUD } }, 'alice@example.org');
    await approvals.saveApprovalBundle('cloud-sync', HASH, new Uint8Array([1, 2, 3]));
    expect(await approvals.getApprovalStatus('cloud-sync', HASH)).toMatchObject({ status: 'pending' });
    expect(await declaredUserCredential('cloud-sync', 'cloud')).toBeNull();

    await onOtherReplica(async (other) => {
      // The request and its package reached the other replica.
      expect((await other.approvals.listApprovals()).map((e) => e.status)).toEqual(['pending']);
      expect(await other.approvals.readApprovalBundle('cloud-sync', HASH)).toEqual(new Uint8Array([1, 2, 3]));
      await other.approvals.decideApproval('cloud-sync', HASH, 'approved', 'admin');
    });

    await pollChanges();
    expect(await approvals.getApprovalStatus('cloud-sync', HASH)).toMatchObject({ status: 'approved' });
    expect(await declaredUserCredential('cloud-sync', 'cloud')).toEqual(CLOUD);
    expect(existsSync(path.join(dir, 'config', 'plugin-approvals.json'))).toBe(false);
    expect(existsSync(path.join(dir, 'config', 'plugin-approvals'))).toBe(false);
  });

  it('keeps requests from users on two replicas that arrive at once', async () => {
    const approvals = await import('../plugin-approvals');
    await Promise.all([
      approvals.requestApproval('first-one', HASH, {}, 'alice@example.org'),
      onOtherReplica((other) => other.approvals.requestApproval('second-one', HASH, {}, 'bob@example.org')),
    ]);
    await onOtherReplica(async (other) => {
      expect((await other.approvals.listApprovals()).map((e) => e.pluginId).sort()).toEqual(['first-one', 'second-one']);
    });
  });

  it('keeps serving its copy while the store is down, and refuses decisions', async () => {
    const approvals = await import('../plugin-approvals');
    await approvals.requestApproval('cloud-sync', HASH, {}, 'alice@example.org');
    await onOtherReplica((other) => other.approvals.decideApproval('cloud-sync', HASH, 'denied', 'admin'));
    await pollChanges();

    store.down = true;
    // Marked stale by the poll but not read yet: the copy it has is served.
    expect((await approvals.listApprovals()).map((e) => e.pluginId)).toEqual(['cloud-sync']);
    await expect(approvals.decideApproval('cloud-sync', HASH, 'approved', 'admin')).rejects.toMatchObject({ name: 'StoreUnavailableError' });
    store.down = false;
    expect(await approvals.getApprovalStatus('cloud-sync', HASH)).toMatchObject({ status: 'denied' });
  });
});

describe('plugin config in the shared store', () => {
  it('keeps both keys when two replicas set different ones at once', async () => {
    const config = await import('../plugin-config');
    await Promise.all([
      config.setPluginConfig('cloud-sync', 'url', 'https://cloud.example.org'),
      onOtherReplica((other) => other.config.setPluginConfig('cloud-sync', 'apiKey', 'secret')),
    ]);
    await onOtherReplica(async (other) => {
      expect(await other.config.getPluginConfig('cloud-sync')).toEqual({ url: 'https://cloud.example.org', apiKey: 'secret' });
    });
    expect(existsSync(path.join(dir, 'config', 'plugin-config'))).toBe(false);
  });

  it('serves the last config it read while the store is down', async () => {
    const config = await import('../plugin-config');
    await config.setPluginConfig('cloud-sync', 'url', 'https://cloud.example.org');
    await config.getPluginConfig('cloud-sync');
    store.down = true;
    expect(await config.getPluginConfig('cloud-sync')).toEqual({ url: 'https://cloud.example.org' });
    await expect(config.setPluginConfig('cloud-sync', 'url', 'x')).rejects.toMatchObject({ name: 'StoreUnavailableError' });
  });
});
