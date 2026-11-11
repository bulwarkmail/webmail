/**
 * @vitest-environment node
 *
 * A first install from the marketplace, in more shapes (same mocks as
 * marketplace-unlisted-permissions.test.ts): a bundle that changes between
 * the question and the answer, listings in shapes the route doesn't expect,
 * and what an answer may accept. An answer names each addition as the 409
 * listed it; a wider entry does not stand for a narrower one.
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
const themes = new Map<string, Record<string, unknown>>();
vi.mock('@/lib/admin/plugin-registry', () => ({
  savePlugin: vi.fn(async (p: Record<string, unknown>) => { registry.set(p.id as string, p); }),
  saveTheme: vi.fn(async (t: Record<string, unknown>, _css: string, skin: string | null) => { themes.set(t.id as string, { ...t, hasSkin: !!skin }); }),
  getPlugin: vi.fn(async (id: string) => registry.get(id) ?? null),
  getTheme: vi.fn(async (id: string) => themes.get(id) ?? null),
  getPluginRegistry: vi.fn(async () => ({ plugins: [...registry.values()] })),
  getThemeRegistry: vi.fn(async () => ({ themes: [...themes.values()] })),
  themeCSSResolver: vi.fn(async () => () => null),
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
const first = { slug: 'pretty-dates', version: '1.0.0', type: 'plugin' };

beforeEach(() => { registry.clear(); themes.clear(); });
afterEach(() => { vi.unstubAllGlobals(); });

describe('the bundle changes between the question and the answer', () => {
  it('a second download with another host is asked about again', async () => {
    const manifest = { ...BASE, id: 'pretty-dates', permissions: ['http:fetch'], httpOrigins: ['https://api.dates.example'] };
    directory(await bundle(manifest), { permissions: ['http:fetch'] });
    const asked = await install(first);
    expect(asked.status).toBe(409);
    const { grantsAdded, permissionsAdded } = await asked.json();

    directory(await bundle({ ...manifest, httpOrigins: ['https://collector.example'] }), { permissions: ['http:fetch'] });
    const again = await install({ ...first, acceptPermissions: permissionsAdded, acceptGrants: grantsAdded });
    expect(again.status).toBe(409);
    expect((await again.json()).grantsAdded.httpOrigins).toEqual(['https://collector.example']);
    expect(registry.size).toBe(0);
  });

  it('a second download with another optional permission, the tier or a credential server is asked about again', async () => {
    const manifest = { ...BASE, id: 'pretty-dates', permissions: ['ui:toolbar'], optionalPermissions: ['email:read'] };
    directory(await bundle(manifest), { permissions: ['ui:toolbar'] });
    const { grantsAdded, permissionsAdded } = await (await install(first)).json();
    expect(permissionsAdded).toEqual(['email:read']);

    for (const changed of [
      { optionalPermissions: ['email:read', 'email:send'] },
      { optionalPermissions: ['email:read', 'crypto:full'], tier: 'privileged' },
      { optionalPermissions: ['email:read', 'http:proxy'], credentials: { svc: { label: 'S', scope: 'user', inject: { type: 'bearer' }, origin: 'https://collector.example' } } },
      { optionalPermissions: ['email:read'], frameOrigins: ['https://collector.example'] },
      { optionalPermissions: ['email:read'], apiPostPaths: ['/api/devices'] },
    ]) {
      directory(await bundle({ ...manifest, ...changed }), { permissions: ['ui:toolbar'] });
      expect((await install({ ...first, acceptPermissions: permissionsAdded, acceptGrants: grantsAdded })).status).toBe(409);
    }
    expect(registry.size).toBe(0);
  });
});

describe('what the listing claims', () => {
  const manifest = { ...BASE, id: 'pretty-dates', permissions: ['email:read', 'http:fetch'], httpOrigins: ['https://collector.example'] };

  it.each([
    ['one string', 'email:read http:fetch'],
    ['a nested list', [['email:read', 'http:fetch']]],
    ['an object', { 'email:read': true, 'http:fetch': true }],
    ['null', null],
    ['a wildcard', ['*']],
    ['other case', ['EMAIL:READ', 'HTTP:FETCH']],
  ])('a permission list given as %s shows nothing', async (_name, permissions) => {
    directory(await bundle(manifest), { permissions });
    const res = await install(first);
    expect(res.status).toBe(409);
    expect((await res.json()).permissionsAdded).toEqual(['email:read', 'http:fetch']);
  });

  it('hosts, paths, the tier or grants in the listing count for nothing', async () => {
    directory(await bundle({ ...manifest, permissions: ['email:read', 'http:fetch', 'crypto:full'], tier: 'privileged', apiPostPaths: ['/api/devices'] }), {
      permissions: ['email:read', 'http:fetch', 'crypto:full'],
      httpOrigins: ['https://collector.example'], apiPostPaths: ['/api/devices'], tier: 'privileged', privileged: true,
      grants: { httpOrigins: ['https://collector.example'], privileged: true },
    });
    const res = await install(first);
    expect(res.status).toBe(409);
    expect((await res.json()).grantsAdded).toMatchObject({ httpOrigins: ['https://collector.example'], apiPostPaths: ['/api/devices'], privileged: true });
  });

  it('force (for a withdrawn or an older version) does not answer the question', async () => {
    directory(await bundle(manifest), { permissions: [] });
    expect((await install({ ...first, force: true })).status).toBe(409);
    expect(registry.size).toBe(0);
  });
});

describe('what may be accepted', () => {
  const manifest = {
    ...BASE, id: 'pretty-dates', tier: 'privileged', permissions: ['email:read', 'http:fetch', 'http:post', 'crypto:full'],
    httpOrigins: ['https://collector.example'], apiPostPaths: ['/api/devices'], frameOrigins: ['https://frames.example'],
  };
  const listing = { permissions: [] };
  const allPermissions = ['email:read', 'http:fetch', 'http:post', 'crypto:full'];
  const all = {
    httpOrigins: ['https://collector.example'], apiPostPaths: ['/api/devices'], frameOrigins: ['https://frames.example'], privileged: true,
  };

  it('control: everything named exactly installs', async () => {
    directory(await bundle(manifest), listing);
    expect((await install({ ...first, acceptPermissions: allPermissions, acceptGrants: all })).status).toBe(200);
  });

  it.each([
    ['true for the whole of acceptGrants', { acceptPermissions: allPermissions, acceptGrants: true }],
    ['a string for acceptGrants', { acceptPermissions: allPermissions, acceptGrants: '*' }],
    ['a list for acceptGrants', { acceptPermissions: allPermissions, acceptGrants: ['*'] }],
    ['a star for the permissions', { acceptPermissions: ['*'], acceptGrants: all }],
    ['a string for the permissions', { acceptPermissions: allPermissions.join(' '), acceptGrants: all }],
    ['true for the permissions', { acceptPermissions: true, acceptGrants: all }],
    ['true for a list of hosts', { acceptPermissions: allPermissions, acceptGrants: { ...all, httpOrigins: true } }],
    ['a star for the hosts', { acceptPermissions: allPermissions, acceptGrants: { ...all, httpOrigins: ['*'] } }],
    ['https://* for the hosts', { acceptPermissions: allPermissions, acceptGrants: { ...all, httpOrigins: ['https://*'] } }],
    ['"true" for the tier', { acceptPermissions: allPermissions, acceptGrants: { ...all, privileged: 'true' } }],
    ['1 for the tier', { acceptPermissions: allPermissions, acceptGrants: { ...all, privileged: 1 } }],
    ['the hosts under frameOrigins only', { acceptPermissions: allPermissions, acceptGrants: { ...all, httpOrigins: [], frameOrigins: ['https://frames.example', 'https://collector.example'] } }],
    ['the paths missing', { acceptPermissions: allPermissions, acceptGrants: { ...all, apiPostPaths: [] } }],
  ])('%s accepts nothing', async (_name, accept) => {
    directory(await bundle(manifest), listing);
    expect((await install({ ...first, ...accept })).status).toBe(409);
    expect(registry.size).toBe(0);
  });

  // The answer to a 409 is matched by cover, not by equality: a wider entry than
  // any the 409 listed (and than a manifest may hold at all) accepts what it covers.
  it('a path the 409 never listed and no manifest may hold ("/") does not accept every path', async () => {
    directory(await bundle(manifest), listing);
    const res = await install({ ...first, acceptPermissions: allPermissions, acceptGrants: { ...all, apiPostPaths: ['/'] } });
    expect(res.status).toBe(409);
  });

  it('a wildcard the 409 never listed does not accept the host it named', async () => {
    directory(await bundle(manifest), listing);
    const res = await install({ ...first, acceptPermissions: allPermissions, acceptGrants: { ...all, httpOrigins: ['https://*.example'], frameOrigins: ['https://*.example'] } });
    expect(res.status).toBe(409);
  });

  it('an answer naming more than was listed is refused and says what, even when it also names everything listed', async () => {
    directory(await bundle(manifest), listing);
    const res = await install({ ...first, acceptPermissions: allPermissions, acceptGrants: { ...all, httpOrigins: [...all.httpOrigins, 'https://other.example'] } });
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.unexpected).toMatchObject({ httpOrigins: ['https://other.example'] });
    expect(body.error).toMatch(/not asked about: https:\/\/other\.example/);
    expect(body.grantsAdded).toMatchObject({ httpOrigins: ['https://collector.example'] });
    expect(registry.size).toBe(0);
  });

  it('an answer may repeat what the listing already showed (a page sends everything it showed)', async () => {
    directory(await bundle(manifest), { permissions: ['email:read', 'http:fetch'] });
    const res = await install({ ...first, acceptPermissions: allPermissions, acceptGrants: all });
    expect(res.status).toBe(200);
  });
});
