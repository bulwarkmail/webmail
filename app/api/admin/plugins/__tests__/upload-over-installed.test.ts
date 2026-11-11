/**
 * @vitest-environment node
 *
 * An admin who uploads a plugin ZIP chose that file, so an upload over an
 * installed plugin is not asked about what the new manifest adds, unlike a
 * marketplace update (app/api/admin/marketplace/route.ts).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';
import JSZip from 'jszip';

vi.mock('@/lib/admin/session', () => ({
  requireAdminAuth: vi.fn(async () => ({ session: { sub: 'admin' } })),
  getClientIP: () => '127.0.0.1',
}));
vi.mock('@/lib/admin/audit', () => ({ auditLog: vi.fn(async () => {}) }));
vi.mock('@/lib/admin/config-manager', () => ({
  configManager: {
    ensureLoaded: vi.fn(async () => {}),
    get: vi.fn(),
    getPolicy: vi.fn(() => ({ forceEnabledPlugins: [] })),
    setPolicy: vi.fn(async () => {}),
    updatePolicy: vi.fn(async () => {}),
  },
}));

const registry = new Map<string, Record<string, unknown>>();
vi.mock('@/lib/admin/plugin-registry', () => ({
  savePlugin: vi.fn(async (p: Record<string, unknown>) => { registry.set(p.id as string, p); }),
  getPlugin: vi.fn(async (id: string) => registry.get(id) ?? null),
  getPluginRegistry: vi.fn(async () => ({ plugins: [...registry.values()] })),
  deletePlugin: vi.fn(async (id: string) => registry.delete(id)),
  updatePluginMeta: vi.fn(async () => null),
}));
vi.mock('@/lib/admin/plugin-config', () => ({ deletePluginConfig: vi.fn(async () => {}) }));
vi.mock('@/lib/admin/plugin-dev', () => ({ listDevPlugins: vi.fn(async () => []) }));
vi.mock('@/lib/admin/csp-frame-origins', async (orig) => ({
  ...(await orig<typeof import('@/lib/admin/csp-frame-origins')>()),
  invalidateFrameOriginsCache: vi.fn(),
}));

import { POST } from '../route';

async function upload(manifest: Record<string, unknown>) {
  const zip = new JSZip();
  zip.file('manifest.json', JSON.stringify(manifest));
  zip.file('index.js', 'module.exports = {}');
  const bytes = await zip.generateAsync({ type: 'uint8array', compression: 'DEFLATE' });
  const form = new FormData();
  form.append('file', new File([bytes as BlobPart], 'p.zip', { type: 'application/zip' }));
  return POST(new NextRequest('http://localhost/api/admin/plugins', { method: 'POST', body: form }));
}

beforeEach(() => { registry.clear(); });

describe('an admin upload over an installed plugin', () => {
  it('asks nothing about what the new manifest adds', async () => {
    registry.set('demo-plugin', { id: 'demo-plugin', version: '1.0.0', enabled: true, permissions: ['email:read'] });

    const res = await upload({
      id: 'demo-plugin', name: 'Demo', version: '1.1.0', author: 'me', description: 'd', type: 'hook', entrypoint: 'index.js',
      permissions: ['email:read', 'email:send', 'http:fetch'], httpOrigins: ['https://api.example'],
    });

    expect(res.status).toBe(200);
    expect(registry.get('demo-plugin')).toMatchObject({ version: '1.1.0', permissions: ['email:read', 'email:send', 'http:fetch'], httpOrigins: ['https://api.example'] });
  });
});
