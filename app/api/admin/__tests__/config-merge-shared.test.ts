// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { NextRequest } from 'next/server';

// Some admin saves change one entry of a list: the per-domain branding, the
// client secrets of the JMAP servers. Built on this instance's copy of the
// list, they dropped what another instance (or a parallel upload here) had
// saved a moment before (#1066).

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
  dir = await mkdtemp(path.join(tmpdir(), 'bw-config-merge-'));
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

describe('list saves with a shared store', () => {
  it('keeps another instance\'s domain branding when uploading for another domain', async () => {
    await savedElsewhere({ setupComplete: true, domainBranding: [{ host: 'a.example', faviconUrl: '/api/admin/branding/a.png' }] });
    expect((await upload('b.example')).status).toBe(200);
    const hosts = (await stored()).domainBranding.map((e: { host: string }) => e.host).sort();
    expect(hosts).toEqual(['a.example', 'b.example']);

    await savedElsewhere({ ...(await stored()), domainBranding: [...(await stored()).domainBranding, { host: 'c.example', faviconUrl: '/x.png' }] });
    const res = await deleteBranding(new NextRequest('https://mail.example/api/admin/branding', {
      method: 'DELETE',
      body: JSON.stringify({ slot: 'faviconUrl', host: 'b.example' }),
    }));
    expect(res.status).toBe(200);
    expect((await stored()).domainBranding.map((e: { host: string }) => e.host)).toContain('c.example');
  });

  it('keeps both of two uploads for different domains at once', async () => {
    const results = await Promise.all([upload('a.example'), upload('b.example')]);
    expect(results.map((r) => r.status)).toEqual([200, 200]);
    expect((await stored()).domainBranding.map((e: { host: string }) => e.host).sort()).toEqual(['a.example', 'b.example']);
  });

  it('keeps a JMAP server\'s client secret another instance just saved', async () => {
    const server = { id: 'corp', label: 'Corp', url: 'https://mail.corp.example', oauth: { clientId: 'webmail' } };
    await savedElsewhere({ setupComplete: true, jmapServers: [{ ...server, oauth: { clientId: 'webmail', clientSecret: 'secret-saved-elsewhere' } }] });
    // The dashboard never has the secret, so it sends the entry without it.
    const res = await patchConfig(new NextRequest('https://mail.example/api/admin/config', {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jmapServers: [{ ...server, label: 'Corp mail' }], appName: 'Renamed' }),
    }));
    expect(res.status).toBe(200);
    const config = await stored();
    expect(config.appName).toBe('Renamed');
    expect(config.jmapServers[0]).toMatchObject({ label: 'Corp mail', oauth: { clientId: 'webmail', clientSecret: 'secret-saved-elsewhere' } });
  });
});
