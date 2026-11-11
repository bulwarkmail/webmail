/**
 * @vitest-environment node
 *
 * What the admin was shown decides what a marketplace install grants.
 *
 * The quick-install dialog shows the permission list the directory sends with
 * the listing. A bundle can grant more (optional permissions, which the
 * directory leaves out, or a listing that is simply wrong); a first install
 * asks about that before anything is saved. An update is compared with what
 * is installed, and asked about whatever it adds.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { NextRequest } from 'next/server';
import JSZip from 'jszip';
import { createHash } from 'node:crypto';

vi.hoisted(() => { process.env.NEXT_PUBLIC_APP_VERSION = '1.21.1'; });

vi.mock('@/lib/admin/session', () => ({
  requireAdminAuth: vi.fn(async () => ({ session: { sub: 'admin' } })),
  getClientIP: () => '127.0.0.1',
}));
vi.mock('@/lib/admin/audit', () => ({ auditLog: vi.fn(async () => {}) }));
vi.mock('@/lib/admin/config-manager', () => ({
  configManager: {
    ensureLoaded: vi.fn(async () => {}),
    get: vi.fn(() => 'https://extensions.test'),
  },
}));

const registry = new Map<string, Record<string, unknown>>();
vi.mock('@/lib/admin/plugin-registry', () => ({
  savePlugin: vi.fn(async (p: Record<string, unknown>) => { registry.set(p.id as string, p); }),
  saveTheme: vi.fn(async () => {}),
  getPlugin: vi.fn(async (id: string) => registry.get(id) ?? null),
  getTheme: vi.fn(async () => null),
  getPluginRegistry: vi.fn(async () => ({ plugins: [...registry.values()] })),
  getThemeRegistry: vi.fn(async () => ({ themes: [] })),
}));
vi.mock('@/lib/admin/csp-frame-origins', async (orig) => ({
  ...(await orig<typeof import('@/lib/admin/csp-frame-origins')>()),
  invalidateFrameOriginsCache: vi.fn(),
}));

import { POST } from '../route';

async function bundle(manifest: Record<string, unknown>, code = 'module.exports = {};'): Promise<ArrayBuffer> {
  const zip = new JSZip();
  zip.file('manifest.json', JSON.stringify(manifest));
  zip.file('index.js', code);
  const buf = await zip.generateAsync({ type: 'uint8array' });
  return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer;
}

/** A directory that lists one version with `meta` and serves `bytes` for it. */
function directory(bytes: ArrayBuffer, meta: Record<string, unknown> = {}) {
  const sha256 = createHash('sha256').update(new Uint8Array(bytes)).digest('hex');
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    const u = String(url);
    if (u.includes('/api/v2/extensions/') && u.includes('/versions/') && !u.endsWith('/bundle')) {
      return Response.json({ data: { version: '1.0.0', channel: 'stable', publishedAt: null, minAppVersion: null, maxAppVersion: null, permissions: [], size: 0, sha256, yanked: null, downloadUrl: '', ...meta } });
    }
    return new Response(bytes);
  }));
}

function install(body: Record<string, unknown>) {
  return POST(new NextRequest('http://localhost/api/admin/marketplace', {
    method: 'POST',
    body: JSON.stringify(body),
    headers: { 'content-type': 'application/json' },
  }));
}

const BASE = { name: 'Pretty Dates', version: '1.0.0', author: 'x', description: 'd', type: 'hook', entrypoint: 'index.js' };

beforeEach(() => { registry.clear(); });
afterEach(() => { vi.unstubAllGlobals(); });

describe('a first install grants only what the admin was shown', () => {
  it('refuses a bundle that asks for more than the directory listed, until that was accepted', async () => {
    // The listing (what the quick-install dialog shows) names one permission.
    // The bundle adds mail access and a host, as optional permissions.
    directory(await bundle({
      ...BASE, id: 'pretty-dates',
      permissions: ['ui:toolbar'],
      optionalPermissions: ['email:read', 'http:fetch'],
      httpOrigins: ['https://collector.example'],
    }), { permissions: ['ui:toolbar'] });

    const res = await install({ slug: 'pretty-dates', version: '1.0.0', type: 'plugin' });

    expect(res.status).toBe(409);
    expect(registry.has('pretty-dates')).toBe(false);
  });

  it('installs it once the unlisted permissions were accepted', async () => {
    directory(await bundle({
      ...BASE, id: 'pretty-dates',
      permissions: ['ui:toolbar'],
      optionalPermissions: ['email:read', 'http:fetch'],
      httpOrigins: ['https://collector.example'],
    }), { permissions: ['ui:toolbar'] });

    const res = await install({ slug: 'pretty-dates', version: '1.0.0', type: 'plugin', acceptPermissions: ['email:read', 'http:fetch'] });

    expect(res.status).toBe(200);
    expect(registry.get('pretty-dates')!.permissions).toEqual(['ui:toolbar', 'email:read', 'http:fetch']);
  });

  it('asks nothing when the listing and the bundle agree', async () => {
    directory(await bundle({ ...BASE, id: 'pretty-dates', permissions: ['email:read'] }), { permissions: ['email:read'] });
    expect((await install({ slug: 'pretty-dates', version: '1.0.0', type: 'plugin' })).status).toBe(200);
  });
});

describe('a first install: what the answer names', () => {
  it('names the permissions the listing left out, and says it compared with the listing', async () => {
    directory(await bundle({
      ...BASE, id: 'pretty-dates', permissions: ['ui:toolbar'], optionalPermissions: ['email:read', 'http:fetch'], httpOrigins: ['https://collector.example'],
    }), { permissions: ['ui:toolbar'] });
    const body = await (await install({ slug: 'pretty-dates', version: '1.0.0', type: 'plugin' })).json();
    expect(body.permissionsAdded).toEqual(['email:read', 'http:fetch']);
    expect(body.compared).toBe('listing');
  });

  it('counts everything as not shown when the listing has no permission list (an older directory)', async () => {
    directory(await bundle({ ...BASE, id: 'pretty-dates', permissions: ['email:read'] }), { permissions: undefined });
    const res = await install({ slug: 'pretty-dates', version: '1.0.0', type: 'plugin' });
    expect(res.status).toBe(409);
    expect((await res.json()).permissionsAdded).toEqual(['email:read']);
    expect(registry.size).toBe(0);
  });

  it('asks about full access that only an optional permission names', async () => {
    directory(await bundle({
      ...BASE, id: 'pretty-dates', tier: 'privileged', permissions: ['ui:toolbar'], optionalPermissions: ['crypto:full'],
    }), { permissions: ['ui:toolbar'] });
    const res = await install({ slug: 'pretty-dates', version: '1.0.0', type: 'plugin' });
    expect(res.status).toBe(409);
    expect((await res.json()).permissionsAdded).toContain('crypto:full');
    expect(registry.size).toBe(0);
  });

  it('is still refused when what was accepted covers only part of it', async () => {
    directory(await bundle({
      ...BASE, id: 'pretty-dates', permissions: ['ui:toolbar'], optionalPermissions: ['email:read', 'email:send'],
    }), { permissions: ['ui:toolbar'] });
    expect((await install({ slug: 'pretty-dates', version: '1.0.0', type: 'plugin', acceptPermissions: ['email:read'] })).status).toBe(409);
    expect(registry.size).toBe(0);
  });
});

describe.skip('an update that widens reach without a new permission is asked about too', () => {
  const INSTALLED = {
    id: 'pretty-dates', name: 'Pretty Dates', version: '0.9.0', enabled: true,
    permissions: ['email:read', 'http:fetch', 'http:post', 'crypto:full'],
    httpOrigins: ['https://api.dates.example'],
    apiPostPaths: ['/api/dates'],
  };
  const SAME = { ...BASE, id: 'pretty-dates', permissions: INSTALLED.permissions, httpOrigins: INSTALLED.httpOrigins, apiPostPaths: INSTALLED.apiPostPaths };

  it('a new httpOrigins entry', async () => {
    registry.set('pretty-dates', { ...INSTALLED });
    directory(await bundle({ ...SAME, httpOrigins: ['https://api.dates.example', 'https://collector.example'] }));
    const res = await install({ slug: 'pretty-dates', version: '1.0.0', type: 'plugin' });
    expect(res.status).toBe(409);
    expect(registry.get('pretty-dates')!.version).toBe('0.9.0');
  });

  it('a new apiPostPaths entry', async () => {
    registry.set('pretty-dates', { ...INSTALLED });
    directory(await bundle({ ...SAME, apiPostPaths: ['/api/dates', '/api/devices'] }));
    const res = await install({ slug: 'pretty-dates', version: '1.0.0', type: 'plugin' });
    expect(res.status).toBe(409);
    expect(registry.get('pretty-dates')!.version).toBe('0.9.0');
  });

  it('a new frameOrigins entry', async () => {
    registry.set('pretty-dates', { ...INSTALLED });
    directory(await bundle({ ...SAME, frameOrigins: ['https://collector.example'] }));
    const res = await install({ slug: 'pretty-dates', version: '1.0.0', type: 'plugin' });
    expect(res.status).toBe(409);
    expect(registry.get('pretty-dates')!.version).toBe('0.9.0');
  });

  it('the privileged tier (same-origin with the app) for a plugin that ran sandboxed', async () => {
    registry.set('pretty-dates', { ...INSTALLED });
    directory(await bundle({ ...SAME, tier: 'privileged' }));
    const res = await install({ slug: 'pretty-dates', version: '1.0.0', type: 'plugin' });
    expect(res.status).toBe(409);
    expect(registry.get('pretty-dates')).not.toHaveProperty('tier');
  });

  it('still asks nothing when none of it changed', async () => {
    registry.set('pretty-dates', { ...INSTALLED });
    directory(await bundle({ ...SAME }));
    expect((await install({ slug: 'pretty-dates', version: '1.0.0', type: 'plugin' })).status).toBe(200);
  });
});
