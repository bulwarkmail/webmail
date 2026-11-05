// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { NextRequest } from 'next/server';

// The palette of a DOMAIN_BRANDING entry has no field of its own in the admin
// console. Every admin save that rewrites the list must keep it.

vi.mock('@/lib/admin/session', () => ({
  requireAdminAuth: async () => ({ payload: { role: 'admin' } }),
  getClientIP: () => '127.0.0.1',
}));
vi.mock('@/lib/admin/audit', () => ({ auditLog: async () => {} }));

import { POST as uploadBranding, DELETE as deleteBranding } from '../branding/route';
import { PATCH as patchConfig } from '../config/route';
import { configManager } from '@/lib/admin/config-manager';
import { adminConfigDocs } from '@/lib/admin/admin-store';
import { setStoreForTests } from '@/lib/shared-store';
import { resetLocalStoreForTests } from '@/lib/shared-store/local';
import { INIT_EPOCH, markEpochsSeen, resetChangesForTests } from '@/lib/shared-store/changes';
import { separateFakeStore } from '@/lib/admin/__tests__/shared-store-fake';

let dir: string;
const stored = async () => JSON.parse((await adminConfigDocs().get('config.json'))!.data.toString('utf-8'));
/** Another instance saved this; its notice hasn't arrived here yet. */
const savedElsewhere = (config: Record<string, unknown>) => adminConfigDocs().put('config.json', JSON.stringify(config));

function upload(host: string) {
  const form = new FormData();
  form.set('file', new File([new Uint8Array([0x89, 0x50, 0x4e, 0x47])], 'logo.png', { type: 'image/png' }));
  form.set('slot', 'faviconUrl');
  form.set('host', host);
  return uploadBranding(new NextRequest('https://mail.example/api/admin/branding', { method: 'POST', body: form }));
}

beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'bw-branding-palette-'));
  vi.stubEnv('ADMIN_CONFIG_DIR', path.join(dir, 'config'));
  vi.stubEnv('ADMIN_STATE_DIR', path.join(dir, 'state'));
  resetLocalStoreForTests();
  resetChangesForTests();
  const store = separateFakeStore(path.join(dir, 'store'));
  setStoreForTests(store);
  await store.epochs.bump(INIT_EPOCH);
  await savedElsewhere({ setupComplete: true });
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

const palette = { light: { primary: '#0b3d91' }, dark: { primary: '#7cc4ff' } };

function patch(body: unknown) {
  return patchConfig(new NextRequest('https://mail.example/api/admin/config', {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  }));
}

describe('admin saves keep a domain palette', () => {
  it('stores the palette sent with the list, without invalid values', async () => {
    const res = await patch({
      domainBranding: [{ host: 'a.example', palette: { ...palette, light: { primary: '#0b3d91', accent: 'url(x)' } } }],
    });
    expect(res.status).toBe(200);
    expect((await stored()).domainBranding).toEqual([{ host: 'a.example', palette }]);
  });

  it('keeps it when a file is uploaded for the domain and when the file is removed', async () => {
    expect((await patch({ domainBranding: [{ host: 'a.example', palette }] })).status).toBe(200);

    expect((await upload('a.example')).status).toBe(200);
    expect((await stored()).domainBranding[0]).toMatchObject({ host: 'a.example', palette });
    expect((await stored()).domainBranding[0].faviconUrl).toBeTruthy();

    const res = await deleteBranding(new NextRequest('https://mail.example/api/admin/branding', {
      method: 'DELETE',
      body: JSON.stringify({ slot: 'faviconUrl', host: 'a.example' }),
    }));
    expect(res.status).toBe(200);
    expect((await stored()).domainBranding).toEqual([{ host: 'a.example', palette }]);
  });
});
