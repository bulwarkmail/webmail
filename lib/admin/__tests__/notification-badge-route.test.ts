// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import sharp from 'sharp';
import { NextRequest } from 'next/server';

// Android draws a notification's status-bar badge from its transparency only.
// The badge used to be the PWA icon, so a branded icon that is opaque edge to
// edge showed as a solid blob (#915). /api/notification-badge serves a
// cut-out instead: the admin's own badge when the branding sets one, else the
// bundled Bulwark mark, never the PWA icon.

vi.mock('@/lib/admin/session', () => ({
  requireAdminAuth: async () => ({ payload: { role: 'admin' } }),
  getClientIP: () => '127.0.0.1',
}));
vi.mock('@/lib/admin/audit', () => ({ auditLog: async () => {} }));

import { configManager } from '../config-manager';
import { POST as upload } from '@/app/api/admin/branding/route';
import { GET as badge } from '@/app/api/notification-badge/route';
import { clearRenderCaches } from '../render-cache';
import { resetLocalStoreForTests } from '@/lib/shared-store/local';
import { resetChangesForTests } from '@/lib/shared-store/changes';

let dir: string;

const opaqueSquare = (r: number, g: number, b: number) =>
  sharp({ create: { width: 64, height: 64, channels: 4, background: { r, g, b, alpha: 1 } } }).png().toBuffer();

async function uploadTo(slot: string, png: Buffer, host?: string): Promise<void> {
  const form = new FormData();
  form.set('file', new File([new Uint8Array(png)], 'image.png', { type: 'image/png' }));
  form.set('slot', slot);
  if (host) form.set('host', host);
  const res = await upload(new NextRequest('https://mail.example/api/admin/branding', { method: 'POST', body: form }));
  expect(res.status).toBe(200);
}

async function render(host = 'mail.example') {
  const res = await badge(new NextRequest(`https://${host}/api/notification-badge`, { headers: { host } }));
  expect(res.status).toBe(200);
  expect(res.headers.get('content-type')).toBe('image/png');
  const { data, info } = await sharp(Buffer.from(await res.arrayBuffer())).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const px = (x: number, y: number) => Array.from(data.subarray((y * info.width + x) * 4, (y * info.width + x) * 4 + 4));
  let transparent = 0;
  for (let i = 3; i < data.length; i += 4) if (data[i] === 0) transparent++;
  return { width: info.width, height: info.height, px, transparentShare: transparent / (info.width * info.height) };
}

beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'bw-notification-badge-'));
  vi.stubEnv('ADMIN_CONFIG_DIR', path.join(dir, 'config'));
  vi.stubEnv('ADMIN_STATE_DIR', path.join(dir, 'state'));
  resetLocalStoreForTests();
  resetChangesForTests();
  clearRenderCaches();
  await configManager.load();
});

afterEach(async () => {
  resetChangesForTests();
  resetLocalStoreForTests();
  vi.unstubAllEnvs();
  await rm(dir, { recursive: true, force: true });
});

describe('GET /api/notification-badge', () => {
  it('serves a 96 px cut-out by default, with a shape left in its transparency', async () => {
    const img = await render();
    expect([img.width, img.height]).toEqual([96, 96]);
    expect(img.transparentShare).toBeGreaterThan(0.3);
    expect(img.transparentShare).toBeLessThan(0.9);
    expect(img.px(0, 0)[3]).toBe(0);
  });

  it('stays a cut-out when the PWA icon is opaque', async () => {
    await uploadTo('pwaIconUrl', await opaqueSquare(255, 0, 0));
    const img = await render();
    expect(img.transparentShare).toBeGreaterThan(0.3);
    expect(img.px(0, 0)[3]).toBe(0);
  });

  it('serves the badge the branding sets', async () => {
    await uploadTo('notificationBadgeUrl', await opaqueSquare(0, 0, 255));
    const img = await render();
    expect(img.px(48, 48)).toEqual([0, 0, 255, 255]);
  });

  it('serves a host its own badge and other hosts the global one', async () => {
    await uploadTo('notificationBadgeUrl', await opaqueSquare(0, 255, 0), 'tenant.example');
    expect((await render('tenant.example')).px(48, 48)).toEqual([0, 255, 0, 255]);
    expect((await render('mail.example')).px(0, 0)[3]).toBe(0);
  });

  it('falls back to the default mark when the configured badge cannot be read', async () => {
    await configManager.setAdminConfig({ notificationBadgeUrl: '/api/admin/branding/missing.png' });
    const img = await render();
    expect(img.px(0, 0)[3]).toBe(0);
    expect(img.transparentShare).toBeGreaterThan(0.3);
  });
});
