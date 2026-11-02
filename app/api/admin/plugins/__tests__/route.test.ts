/**
 * @vitest-environment node
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';
import JSZip from 'jszip';

vi.mock('@/lib/admin/session', () => ({
  requireAdminAuth: vi.fn(async () => ({ session: { sub: 'admin' } })),
  getClientIP: () => '127.0.0.1',
}));
vi.mock('@/lib/admin/audit', () => ({ auditLog: vi.fn(async () => {}) }));

let policy: Record<string, unknown>;
vi.mock('@/lib/admin/config-manager', () => ({
  configManager: {
    ensureLoaded: vi.fn(async () => {}),
    get: vi.fn(),
    getPolicy: vi.fn(() => policy),
    setPolicy: vi.fn(async (p: Record<string, unknown>) => { policy = p; }),
    updatePolicy: vi.fn(async (change: (p: Record<string, unknown>) => Record<string, unknown> | undefined) => { policy = change(policy) ?? policy; }),
  },
}));

const registry = new Map<string, Record<string, unknown>>();
const removedConfig: string[] = [];
vi.mock('@/lib/admin/plugin-registry', () => ({
  savePlugin: vi.fn(async (p: Record<string, unknown>) => { registry.set(p.id as string, p); }),
  getPlugin: vi.fn(async (id: string) => registry.get(id) ?? null),
  getPluginRegistry: vi.fn(async () => ({ plugins: [...registry.values()] })),
  deletePlugin: vi.fn(async (id: string) => registry.delete(id)),
}));
vi.mock('@/lib/admin/plugin-config', () => ({
  deletePluginConfig: vi.fn(async (id: string) => { removedConfig.push(id); }),
}));
vi.mock('@/lib/admin/plugin-dev', () => ({ listDevPlugins: vi.fn(async () => []) }));
vi.mock('@/lib/admin/csp-frame-origins', async (orig) => ({
  ...(await orig<typeof import('@/lib/admin/csp-frame-origins')>()),
  invalidateFrameOriginsCache: vi.fn(),
}));

import { DELETE, POST } from '../route';

const MANIFEST = {
  id: 'demo-plugin', name: 'Demo', version: '1.0.0', author: 'me', description: 'd',
  type: 'hook', permissions: ['email:read'], entrypoint: 'index.js',
};

async function upload(files: Record<string, string | Uint8Array>) {
  const zip = new JSZip();
  for (const [n, d] of Object.entries(files)) zip.file(n, d);
  const bytes = await zip.generateAsync({ type: 'uint8array', compression: 'DEFLATE' });
  const form = new FormData();
  form.append('file', new File([bytes as BlobPart], 'p.zip', { type: 'application/zip' }));
  return POST(new NextRequest('http://localhost/api/admin/plugins', { method: 'POST', body: form }));
}

beforeEach(() => {
  registry.clear();
  removedConfig.length = 0;
  policy = { forceEnabledPlugins: [] };
});

describe('POST /api/admin/plugins', () => {
  it('installs a valid plugin with its locales', async () => {
    const res = await upload({
      'manifest.json': JSON.stringify({ ...MANIFEST, locales: { de: { hi: 'Hallo' } } }),
      'index.js': 'module.exports = {}',
    });

    expect(res.status).toBe(200);
    expect(registry.get('demo-plugin')?.locales).toEqual({ de: { hi: 'Hallo' } });
  });

  it('refuses permissions given as a string', async () => {
    const res = await upload({
      'manifest.json': JSON.stringify({ ...MANIFEST, permissions: 'crypto:full email:send', tier: 'privileged' }),
      'index.js': '',
    });

    expect(res.status).toBe(400);
    expect(registry.size).toBe(0);
  });

  it('refuses a ZIP bomb instead of inflating it', async () => {
    const res = await upload({
      'manifest.json': JSON.stringify(MANIFEST),
      'index.js': new Uint8Array(30 * 1024 * 1024),
    });

    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/once unpacked/);
  });

  it('refuses an invalid settings schema', async () => {
    const res = await upload({
      'manifest.json': JSON.stringify({ ...MANIFEST, settingsSchema: { m: { type: 'select', label: 'M', default: 'a', options: 'a,b' } } }),
      'index.js': '',
    });

    expect(res.status).toBe(400);
  });
});

describe('re-uploading and deleting', () => {
  it('keeps a plugin the admin disabled disabled when a new version is uploaded', async () => {
    registry.set('demo-plugin', { id: 'demo-plugin', enabled: false, forceEnabled: true });

    await upload({ 'manifest.json': JSON.stringify({ ...MANIFEST, version: '1.1.0' }), 'index.js': '' });

    expect(registry.get('demo-plugin')).toMatchObject({ version: '1.1.0', enabled: false, forceEnabled: true });
  });

  it('drops the config and the forced flag when a plugin is deleted', async () => {
    registry.set('demo-plugin', { id: 'demo-plugin' });
    policy = { forceEnabledPlugins: ['demo-plugin', 'other'] };

    const res = await DELETE(new NextRequest('http://localhost/api/admin/plugins', {
      method: 'DELETE',
      body: JSON.stringify({ id: 'demo-plugin' }),
      headers: { 'content-type': 'application/json' },
    }));

    expect(res.status).toBe(200);
    expect(removedConfig).toEqual(['demo-plugin']);
    expect(policy.forceEnabledPlugins).toEqual(['other']);
  });
});
