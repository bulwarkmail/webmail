// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import sharp from 'sharp';
import { NextRequest } from 'next/server';

// A re-upload of the same branding slot with the same file type kept its
// URL. Browsers kept showing the old file for up to an hour, and the PWA
// icon, screenshot and link-preview renders, cached by that URL, kept the
// old logo until the server restarted. The URL now carries the upload's
// version, and the render caches are capped and dropped on a branding or
// config change (also one made on another instance, #1066).

vi.mock('@/lib/admin/session', () => ({
  requireAdminAuth: async () => ({ payload: { role: 'admin' } }),
  getClientIP: () => '127.0.0.1',
}));
vi.mock('@/lib/admin/audit', () => ({ auditLog: async () => {} }));

import { configManager } from '../config-manager';
import { POST as upload } from '@/app/api/admin/branding/route';
import { GET as pwaIcon } from '@/app/api/pwa-icon/[size]/route';
import { GET as serveFile } from '@/app/api/admin/branding/[filename]/route';
import { MAX_ENTRIES, clearRenderCaches, renderCache } from '../render-cache';
import { setStoreForTests } from '@/lib/shared-store';
import { resetLocalStoreForTests } from '@/lib/shared-store/local';
import { INIT_EPOCH, markEpochsSeen, pollChanges, resetChangesForTests } from '@/lib/shared-store/changes';
import { separateFakeStore } from './shared-store-fake';

let dir: string;

const square = (r: number, g: number, b: number) =>
  sharp({ create: { width: 64, height: 64, channels: 4, background: { r, g, b, alpha: 1 } } }).png().toBuffer();

async function uploadIcon(png: Buffer): Promise<string> {
  const form = new FormData();
  form.set('file', new File([new Uint8Array(png)], 'icon.png', { type: 'image/png' }));
  form.set('slot', 'pwaIconUrl');
  const res = await upload(new NextRequest('https://mail.example/api/admin/branding', { method: 'POST', body: form }));
  expect(res.status).toBe(200);
  return (await res.json()).url;
}

async function renderedIconColour(route = pwaIcon): Promise<number[]> {
  const res = await route(new NextRequest('https://mail.example/api/pwa-icon/192'), { params: Promise.resolve({ size: '192' }) });
  const { data } = await sharp(Buffer.from(await res.arrayBuffer())).raw().toBuffer({ resolveWithObject: true });
  // The centre pixel.
  const at = (96 * 192 + 96) * 4;
  return [data[at], data[at + 1], data[at + 2]];
}

beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'bw-branding-reupload-'));
  vi.stubEnv('ADMIN_CONFIG_DIR', path.join(dir, 'config'));
  vi.stubEnv('ADMIN_STATE_DIR', path.join(dir, 'state'));
  resetLocalStoreForTests();
  resetChangesForTests();
  clearRenderCaches();
  await configManager.load();
});

afterEach(async () => {
  setStoreForTests(null);
  resetChangesForTests();
  resetLocalStoreForTests();
  vi.unstubAllEnvs();
  await rm(dir, { recursive: true, force: true });
});

describe('re-uploading a branding image', () => {
  it('gets a new URL, and the rendered PWA icon shows the new image at once', async () => {
    const first = await uploadIcon(await square(255, 0, 0));
    expect(first).toMatch(/^\/api\/admin\/branding\/pwaIconUrl\.png\?v=[\w-]+$/);
    expect(await renderedIconColour()).toEqual([255, 0, 0]);

    const second = await uploadIcon(await square(0, 0, 255));
    expect(second).not.toBe(first);
    expect(second.split('?')[0]).toBe(first.split('?')[0]);
    expect(configManager.get('pwaIconUrl')).toBe(second);
    expect(await renderedIconColour()).toEqual([0, 0, 255]);

    // The file itself is served under its name, whatever the version says.
    const res = await serveFile(new NextRequest(`https://mail.example${second}`), { params: Promise.resolve({ filename: 'pwaIconUrl.png' }) });
    expect(res.status).toBe(200);
  });

  it('renders anew after a branding change even when the URL stayed the same', async () => {
    // The route as loaded at process start, listening for changes.
    vi.resetModules();
    const { GET: route } = await import('@/app/api/pwa-icon/[size]/route');
    await uploadIcon(await square(255, 0, 0));
    expect(await renderedIconColour(route)).toEqual([255, 0, 0]);
    // The file behind the URL changes (as a linked remote logo can) and the
    // branding change is announced.
    const { brandingDocs } = await import('../extension-store');
    await brandingDocs().put('pwaIconUrl.png', await square(0, 255, 0));
    const { announceChange } = await import('@/lib/shared-store/changes');
    await announceChange('branding');
    expect(await renderedIconColour(route)).toEqual([0, 255, 0]);
  });

  it('keeps the same URL for the same bytes', async () => {
    const png = await square(0, 255, 0);
    expect(await uploadIcon(png)).toBe(await uploadIcon(png));
  });
});

describe('render caches', () => {
  it('hold at most a fixed number of images, dropping the least recently used', () => {
    const cache = renderCache('test-cap');
    for (let i = 0; i < MAX_ENTRIES; i++) cache.set(`k${i}`, new Blob([String(i)]));
    expect(cache.get('k0')).toBeDefined(); // k0 used again
    for (let i = MAX_ENTRIES; i < MAX_ENTRIES + 8; i++) cache.set(`k${i}`, new Blob([String(i)]));
    expect(cache.size).toBe(MAX_ENTRIES);
    expect(cache.has('k0')).toBe(true);
    expect(cache.has('k1')).toBe(false);
  });

  it('are dropped when another instance changes the branding', async () => {
    const store = separateFakeStore(path.join(dir, 'store'));
    setStoreForTests(store);
    await store.epochs.bump(INIT_EPOCH);
    await markEpochsSeen();
    // A fresh copy of the module listens, as each route bundle's does.
    vi.resetModules();
    const fresh = await import('../render-cache');
    const cache = fresh.renderCache('og-image');
    cache.set('logo', new Blob(['old render']));

    await store.epochs.bump('branding');
    await pollChanges();
    expect(cache.has('logo')).toBe(false);
  });
});
