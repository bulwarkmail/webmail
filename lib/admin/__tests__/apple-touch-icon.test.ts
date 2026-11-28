// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import sharp from 'sharp';
import { NextRequest } from 'next/server';

// iOS takes the home screen icon from <link rel="apple-touch-icon">, never
// from the manifest. The layout emitted no such link, so Safari fell back to
// the static /apple-touch-icon.png and a branded deployment got the Bulwark
// icon on the home screen. The layout now links /api/pwa-icon/180.

vi.mock('@/lib/admin/session', () => ({
  requireAdminAuth: async () => ({ payload: { role: 'admin' } }),
  getClientIP: () => '127.0.0.1',
}));
vi.mock('@/lib/admin/audit', () => ({ auditLog: async () => {} }));

import { configManager } from '../config-manager';
import { POST as upload } from '@/app/api/admin/branding/route';
import { GET as pwaIcon } from '@/app/api/pwa-icon/[size]/route';
import { clearRenderCaches } from '../render-cache';
import { resetLocalStoreForTests } from '@/lib/shared-store/local';
import { resetChangesForTests } from '@/lib/shared-store/changes';

let dir: string;

/** A wide red bar: rendering it into a square leaves transparent bands above and below. */
const wideRedBar = () =>
  sharp({ create: { width: 64, height: 16, channels: 4, background: { r: 255, g: 0, b: 0, alpha: 1 } } }).png().toBuffer();

async function uploadIcon(png: Buffer): Promise<void> {
  const form = new FormData();
  form.set('file', new File([new Uint8Array(png)], 'icon.png', { type: 'image/png' }));
  form.set('slot', 'pwaIconUrl');
  const res = await upload(new NextRequest('https://mail.example/api/admin/branding', { method: 'POST', body: form }));
  expect(res.status).toBe(200);
}

async function render(size: number, host = 'mail.example') {
  const res = await pwaIcon(new NextRequest(`https://${host}/api/pwa-icon/${size}`, { headers: { host } }), {
    params: Promise.resolve({ size: String(size) }),
  });
  expect(res.status).toBe(200);
  const { data, info } = await sharp(Buffer.from(await res.arrayBuffer())).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const pixel = (x: number, y: number) => Array.from(data.subarray((y * info.width + x) * 4, (y * info.width + x) * 4 + 4));
  return { info, pixel };
}

beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'bw-apple-touch-icon-'));
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

describe('/api/pwa-icon/180 (apple-touch-icon)', () => {
  it('serves the default Bulwark icon at 180x180 when no icon is configured', async () => {
    const { info } = await render(180);
    expect([info.width, info.height]).toEqual([180, 180]);
  });

  it('serves the branded icon, flattened onto white, since iOS draws transparency as black', async () => {
    await uploadIcon(await wideRedBar());
    const { info, pixel } = await render(180);
    expect([info.width, info.height]).toEqual([180, 180]);
    expect(pixel(90, 90)).toEqual([255, 0, 0, 255]);
    expect(pixel(2, 2)).toEqual([255, 255, 255, 255]);
  });

  it('flattens onto the configured PWA background colour', async () => {
    await uploadIcon(await wideRedBar());
    await configManager.updateAdminConfig('pwaBackgroundColor', () => '#0c2f53');
    clearRenderCaches();
    const { pixel } = await render(180);
    expect(pixel(2, 2)).toEqual([0x0c, 0x2f, 0x53, 255]);
  });

  it.each(['not a colour', 'rgb(1,2,3)', '#12345'])('falls back to white for an invalid background colour (%s)', async (colour) => {
    await uploadIcon(await wideRedBar());
    await configManager.updateAdminConfig('pwaBackgroundColor', () => colour);
    clearRenderCaches();
    const { pixel } = await render(180);
    expect(pixel(2, 2)).toEqual([255, 255, 255, 255]);
  });

  it("uses the domain's background colour over the global one for that host only", async () => {
    await uploadIcon(await wideRedBar());
    await configManager.updateAdminConfig('pwaBackgroundColor', () => '#0c2f53');
    await configManager.updateAdminConfig('domainBranding', () => [{ host: 'mail.example', pwaBackgroundColor: '#00ff00' }], []);
    clearRenderCaches();
    expect((await render(180)).pixel(2, 2)).toEqual([0, 255, 0, 255]);
    expect((await render(180, 'other.example')).pixel(2, 2)).toEqual([0x0c, 0x2f, 0x53, 255]);
  });

  it('keeps the transparent padding of the manifest sizes', async () => {
    await uploadIcon(await wideRedBar());
    const { pixel } = await render(192);
    expect(pixel(2, 2)[3]).toBe(0);
  });
});
