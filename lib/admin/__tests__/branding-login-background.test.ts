// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { NextRequest } from 'next/server';

// The login page's background has upload slots of its own, with room for a
// photo (5 MB); the logos keep their 2 MB limit.

vi.mock('@/lib/admin/session', () => ({
  requireAdminAuth: async () => ({ payload: { role: 'admin' } }),
  getClientIP: () => '127.0.0.1',
}));
vi.mock('@/lib/admin/audit', () => ({ auditLog: async () => {} }));

import { configManager } from '../config-manager';
import { POST as upload } from '@/app/api/admin/branding/route';
import { resetLocalStoreForTests } from '@/lib/shared-store/local';
import { resetChangesForTests } from '@/lib/shared-store/changes';

let dir: string;

function post(slot: string, bytes: number, host?: string) {
  const form = new FormData();
  form.set('file', new File([new Uint8Array(bytes)], 'photo.jpg', { type: 'image/jpeg' }));
  form.set('slot', slot);
  if (host) form.set('host', host);
  return upload(new NextRequest('https://mail.example/api/admin/branding', { method: 'POST', body: form }));
}

beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'bw-branding-login-bg-'));
  vi.stubEnv('ADMIN_CONFIG_DIR', path.join(dir, 'config'));
  vi.stubEnv('ADMIN_STATE_DIR', path.join(dir, 'state'));
  resetLocalStoreForTests();
  resetChangesForTests();
  await configManager.load();
});

afterEach(async () => {
  resetChangesForTests();
  resetLocalStoreForTests();
  vi.unstubAllEnvs();
  await rm(dir, { recursive: true, force: true });
});

describe('login background upload', () => {
  it('takes a 4 MB photo for either colour mode and points the setting at it', async () => {
    for (const slot of ['loginBackgroundLightUrl', 'loginBackgroundDarkUrl']) {
      const res = await post(slot, 4 * 1024 * 1024);
      expect(res.status).toBe(200);
      const { url } = await res.json();
      expect(url).toMatch(new RegExp(`^/api/admin/branding/${slot}\\.jpg\\?v=`));
      expect(configManager.get(slot, '')).toBe(url);
    }
  });

  it('stores a domain upload in that domain\'s branding', async () => {
    const res = await post('loginBackgroundLightUrl', 1024, 'brand.example.com');
    expect(res.status).toBe(200);
    const { url } = await res.json();
    expect(configManager.get('domainBranding', [])).toEqual([{ host: 'brand.example.com', loginBackgroundLightUrl: url }]);
  });

  it('refuses a background over 5 MB', async () => {
    const res = await post('loginBackgroundLightUrl', 5 * 1024 * 1024 + 1);
    expect(res.status).toBe(400);
    expect((await res.json()).error).toContain('5 MB');
  });

  it('keeps 2 MB for the logos', async () => {
    const res = await post('loginLogoLightUrl', 4 * 1024 * 1024);
    expect(res.status).toBe(400);
    expect((await res.json()).error).toContain('2 MB');
  });
});
