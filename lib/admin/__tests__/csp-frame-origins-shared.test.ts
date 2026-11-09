// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { NextRequest } from 'next/server';

// Several replicas share one store (#1066): after a plugin with frame
// origins is installed through another replica, this replica's proxy must
// put them into frame-src on the next change poll, not only after its
// 5-second cache runs out.

vi.mock('@/lib/auth/instance-details', () => ({
  canSeeInstanceDetails: async () => true,
  signedInIdentity: async () => ({ admin: true }),
}));
vi.mock('@/lib/admin/session', () => ({
  requireAdminAuth: async () => ({ payload: { role: 'admin' } }),
  getClientIP: () => '127.0.0.1',
}));
vi.mock('@/lib/admin/audit', () => ({ auditLog: async () => {} }));
vi.mock('@/lib/admin/plugin-dev', () => ({ listDevPlugins: vi.fn(async () => []) }));
vi.mock('@/lib/wopi/discovery', () => ({ getWopiEditorOrigins: vi.fn(async () => []) }));
vi.mock('next-intl/middleware', async () => {
  const { NextResponse } = await import('next/server');
  return { default: () => () => NextResponse.next() };
});

import { configManager } from '../config-manager';
import { adminConfigDocs } from '../admin-store';
import { pluginDocs } from '../extension-store';
import { setBootState, setStoreForTests } from '@/lib/shared-store';
import { resetLocalStoreForTests } from '@/lib/shared-store/local';
import { INIT_EPOCH, markEpochsSeen, pollChanges, resetChangesForTests } from '@/lib/shared-store/changes';
import { separateFakeStore } from './shared-store-fake';

const PLUGIN = {
  id: 'video-embed', name: 'Video', version: '1.0.0', author: 'a', description: '', type: 'hook',
  permissions: [], entrypoint: 'index.js', enabled: true, installedAt: 'x', updatedAt: 'x',
};

let dir: string;
let store: ReturnType<typeof separateFakeStore>;

const registryWith = (frameOrigins: string[]) => JSON.stringify({ plugins: [{ ...PLUGIN, frameOrigins }] });

beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'bw-csp-shared-'));
  vi.stubEnv('ADMIN_CONFIG_DIR', path.join(dir, 'config'));
  vi.stubEnv('ADMIN_STATE_DIR', path.join(dir, 'state'));
  resetLocalStoreForTests();
  resetChangesForTests();
  delete (globalThis as Record<symbol, unknown>)[Symbol.for('bulwark.admin.cspFrameOrigins')];
  store = separateFakeStore(path.join(dir, 'store'));
  setStoreForTests(store);
  await store.epochs.bump(INIT_EPOCH);
  await adminConfigDocs().put('config.json', JSON.stringify({ setupComplete: true }));
  await adminConfigDocs().put('policy.json', JSON.stringify({ features: { pluginsEnabled: true } }));
  await pluginDocs().put('registry.json', registryWith(['https://first.example.com']));
  await markEpochsSeen();
  await configManager.load();
  setBootState('ready');
});

afterEach(async () => {
  setStoreForTests(null);
  resetChangesForTests();
  resetLocalStoreForTests();
  vi.unstubAllEnvs();
  await rm(dir, { recursive: true, force: true });
});

describe('plugin frame origins with a shared store', () => {
  it('reach the proxy within one poll after an install on another replica', async () => {
    // The proxy's own module copies, loaded now (as at process start).
    vi.resetModules();
    const { proxy } = await import('@/proxy');
    const frameSrc = async () => {
      const res = await proxy(new NextRequest('http://localhost:3000/'));
      return /frame-src [^;]*/.exec(res.headers.get('content-security-policy') ?? '')?.[0] ?? '';
    };
    expect(await frameSrc()).toContain('https://first.example.com');

    // Another replica installs: the store changes and the epoch moves.
    await pluginDocs().put('registry.json', registryWith(['https://second.example.com']));
    await store.epochs.bump('plugins');
    await pollChanges();

    const after = await frameSrc();
    expect(after).toContain('https://second.example.com');
    expect(after).not.toContain('https://first.example.com');
  });
});
