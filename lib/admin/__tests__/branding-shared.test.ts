// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { NextRequest } from 'next/server';

// Several replicas share one store (#1066): a logo uploaded through one
// replica is stored in the shared store and served, and rendered into the
// link preview and app icons, by every other one. Before, it was a file in
// the uploading replica's config dir and every other replica answered 404.

vi.mock('@/lib/admin/session', () => ({
  requireAdminAuth: async () => ({ payload: { role: 'admin' } }),
  getClientIP: () => '127.0.0.1',
}));
vi.mock('@/lib/admin/audit', () => ({ auditLog: async () => {} }));
vi.mock('@/lib/setup/state', () => ({ detectSetupState: () => 'bootstrap' }));
vi.mock('@/lib/setup/session', () => ({ authenticateWizardRequest: async () => true, wizardSessionRefusal: async () => null }));

import { configManager } from '../config-manager';
import { adminConfigDocs } from '../admin-store';
import { setStoreForTests } from '@/lib/shared-store';
import { resetLocalStoreForTests } from '@/lib/shared-store/local';
import { INIT_EPOCH, markEpochsSeen, resetChangesForTests } from '@/lib/shared-store/changes';
import { separateFakeStore } from './shared-store-fake';

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]);

let dir: string;
let store: ReturnType<typeof separateFakeStore>;

async function upload(bytes: Uint8Array, slot = 'faviconUrl') {
  const { POST } = await import('@/app/api/admin/branding/route');
  const form = new FormData();
  form.set('file', new File([bytes as BlobPart], 'logo.png', { type: 'image/png' }));
  form.set('slot', slot);
  return POST(new NextRequest('https://mail.example/api/admin/branding', { method: 'POST', body: form }));
}

/** The serving route as another replica has it: fresh module copies. */
async function serveOnOtherReplica(filename: string) {
  vi.resetModules();
  const { GET } = await import('@/app/api/admin/branding/[filename]/route');
  return GET(new NextRequest(`https://mail.example/api/admin/branding/${filename}`), { params: Promise.resolve({ filename }) });
}

beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'bw-branding-shared-'));
  vi.stubEnv('ADMIN_CONFIG_DIR', path.join(dir, 'config'));
  vi.stubEnv('ADMIN_STATE_DIR', path.join(dir, 'state'));
  resetLocalStoreForTests();
  resetChangesForTests();
  store = separateFakeStore(path.join(dir, 'store'));
  setStoreForTests(store);
  await store.epochs.bump(INIT_EPOCH);
  await adminConfigDocs().put('config.json', JSON.stringify({ setupComplete: true }));
  await markEpochsSeen();
  await configManager.load();
});

afterEach(async () => {
  setStoreForTests(null);
  resetChangesForTests();
  resetLocalStoreForTests();
  vi.unstubAllEnvs();
  await rm(dir, { recursive: true, force: true });
});

describe('branding uploads in the shared store', () => {
  it('serves on another replica a logo uploaded through one', async () => {
    const res = await upload(PNG);
    expect(res.status).toBe(200);
    expect((await store.epochs.all()).branding).toBeGreaterThan(0);

    const served = await serveOnOtherReplica('faviconUrl.png');
    expect(served.status).toBe(200);
    expect(served.headers.get('content-type')).toBe('image/png');
    expect(new Uint8Array(await served.arrayBuffer())).toEqual(PNG);
    expect(existsSync(path.join(dir, 'config', 'branding'))).toBe(false);
  });

  it('reads the upload from the store for the rendered images', async () => {
    const { url } = await (await upload(PNG)).json();
    vi.resetModules();
    const { fetchBrandingAsset } = await import('../branding-asset');
    expect(new Uint8Array(await fetchBrandingAsset(url))).toEqual(PNG);
  });

  it('removes it for every replica', async () => {
    await upload(PNG);
    const { DELETE } = await import('@/app/api/admin/branding/route');
    const res = await DELETE(new NextRequest('https://mail.example/api/admin/branding', {
      method: 'DELETE', body: JSON.stringify({ slot: 'faviconUrl' }),
    }));
    expect(res.status).toBe(200);
    expect((await serveOnOtherReplica('faviconUrl.png')).status).toBe(404);
  });

  it('serves on another replica a logo uploaded in the setup wizard', async () => {
    const { POST } = await import('@/app/api/setup/branding/route');
    const form = new FormData();
    form.set('file', new File([PNG as BlobPart], 'logo.png', { type: 'image/png' }));
    form.set('slot', 'loginLogoLightUrl');
    expect((await POST(new NextRequest('https://mail.example/api/setup/branding', { method: 'POST', body: form }))).status).toBe(200);

    const served = await serveOnOtherReplica('loginLogoLightUrl.png');
    expect(new Uint8Array(await served.arrayBuffer())).toEqual(PNG);
    expect(existsSync(path.join(dir, 'config', 'branding'))).toBe(false);
  });

  it('answers 503 while the store is down', async () => {
    await upload(PNG);
    store.down = true;
    expect((await serveOnOtherReplica('faviconUrl.png')).status).toBe(503);
    expect((await upload(PNG)).status).toBe(503);
  });
});
