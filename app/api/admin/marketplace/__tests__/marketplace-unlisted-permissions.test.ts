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

    // The host is part of what the bundle grants beyond the listing, so it is accepted too.
    const res = await install({
      slug: 'pretty-dates', version: '1.0.0', type: 'plugin',
      acceptPermissions: ['email:read', 'http:fetch'], acceptGrants: { httpOrigins: ['https://collector.example'] },
    });

    expect(res.status).toBe(200);
    expect(registry.get('pretty-dates')!.permissions).toEqual(['ui:toolbar', 'email:read', 'http:fetch']);
  });

  it('is still refused when the permissions were accepted but the host was not', async () => {
    directory(await bundle({
      ...BASE, id: 'pretty-dates',
      permissions: ['ui:toolbar'],
      optionalPermissions: ['email:read', 'http:fetch'],
      httpOrigins: ['https://collector.example'],
    }), { permissions: ['ui:toolbar'] });

    const res = await install({ slug: 'pretty-dates', version: '1.0.0', type: 'plugin', acceptPermissions: ['email:read', 'http:fetch'] });

    expect(res.status).toBe(409);
    expect((await res.json()).grantsAdded).toMatchObject({ httpOrigins: ['https://collector.example'] });
    expect(registry.has('pretty-dates')).toBe(false);
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
    const body = await res.json();
    expect(body.permissionsAdded).toContain('crypto:full');
    expect(body.grantsAdded.privileged).toBe(true);
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

describe('an update that widens reach without a new permission is asked about too', () => {
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

  it('names each kind it adds, and installs once all of it was accepted', async () => {
    registry.set('pretty-dates', { ...INSTALLED });
    directory(await bundle({
      ...SAME, tier: 'privileged',
      httpOrigins: ['https://api.dates.example', 'https://collector.example'],
      apiPostPaths: ['/api/dates', '/api/devices'],
      frameOrigins: ['https://frames.example'],
    }));
    const refused = await install({ slug: 'pretty-dates', version: '1.0.0', type: 'plugin' });
    expect(refused.status).toBe(409);
    const { grantsAdded: added, error } = await refused.json();
    expect(added).toEqual({
      permissions: [], httpOrigins: ['https://collector.example'], apiPostPaths: ['/api/devices'],
      frameOrigins: ['https://frames.example'], credentialOrigins: [], privileged: true,
    });
    expect(error).toMatch(/May now contact https:\/\/collector\.example/);
    expect(error).toMatch(/Runs with full access to the app/);

    // Accepting part of it is not enough.
    directory(await bundle({
      ...SAME, tier: 'privileged',
      httpOrigins: ['https://api.dates.example', 'https://collector.example'],
      apiPostPaths: ['/api/dates', '/api/devices'],
      frameOrigins: ['https://frames.example'],
    }));
    expect((await install({ slug: 'pretty-dates', version: '1.0.0', type: 'plugin', acceptGrants: { ...added, privileged: false } })).status).toBe(409);
    expect(registry.get('pretty-dates')!.version).toBe('0.9.0');

    const { auditLog } = await import('@/lib/admin/audit');
    vi.mocked(auditLog).mockClear();
    const ok = await install({ slug: 'pretty-dates', version: '1.0.0', type: 'plugin', acceptGrants: added });
    expect(ok.status).toBe(200);
    expect(registry.get('pretty-dates')).toMatchObject({ version: '1.0.0', tier: 'privileged', httpOrigins: ['https://api.dates.example', 'https://collector.example'] });
    // What was accepted is in the audit entry.
    expect(vi.mocked(auditLog).mock.calls[0][1]).toMatchObject({
      accepted: { httpOrigins: ['https://collector.example'], apiPostPaths: ['/api/devices'], frameOrigins: ['https://frames.example'], privileged: true },
    });
  });
});

describe('what counts as more', () => {
  const INSTALLED = {
    id: 'pretty-dates', name: 'Pretty Dates', version: '0.9.0', enabled: true,
    permissions: ['http:fetch', 'http:post', 'http:proxy'],
  };
  const MANIFEST = { ...BASE, id: 'pretty-dates', permissions: INSTALLED.permissions };

  async function update(installed: Record<string, unknown>, manifest: Record<string, unknown>) {
    registry.set('pretty-dates', { ...INSTALLED, ...installed });
    directory(await bundle({ ...MANIFEST, ...manifest }));
    const res = await install({ slug: 'pretty-dates', version: '1.0.0', type: 'plugin' });
    return { status: res.status, added: res.status === 409 ? (await res.json()).grantsAdded : null };
  }

  it('not an origin that differs only in case or a trailing slash', async () => {
    expect((await update({ httpOrigins: ['https://API.Dates.example/'] }, { httpOrigins: ['https://api.dates.example'] })).status).toBe(200);
    expect((await update({ frameOrigins: ['https://Frames.Example'] }, { frameOrigins: ['https://frames.example'] })).status).toBe(200);
  });

  it('a wildcard or a broader path in place of a narrower one', async () => {
    const wider = await update({ httpOrigins: ['https://api.dates.example'] }, { httpOrigins: ['https://*.dates.example'] });
    expect(wider.status).toBe(409);
    expect(wider.added.httpOrigins).toEqual(['https://*.dates.example']);

    const prefix = await update({ apiPostPaths: ['/api/dates/save'] }, { apiPostPaths: ['/api/dates/'] });
    expect(prefix.status).toBe(409);
    expect(prefix.added.apiPostPaths).toEqual(['/api/dates/']);

    // The other way round is narrower, and asks nothing.
    expect((await update({ httpOrigins: ['https://*.dates.example'] }, { httpOrigins: ['https://api.dates.example'] })).status).toBe(200);
    expect((await update({ apiPostPaths: ['/api/dates/'] }, { apiPostPaths: ['/api/dates/save'] })).status).toBe(200);
  });

  it('a new secret setting whose credential goes to another server', async () => {
    const res = await update({}, {
      configSchema: { apiKey: { type: 'secret', label: 'API key' } },
      credentials: { service: { label: 'Service', scope: 'admin', inject: { type: 'bearer' }, secretKey: 'apiKey', origin: 'https://collector.example' } },
    });
    expect(res.status).toBe(409);
    expect(res.added.credentialOrigins).toEqual(['https://collector.example']);
  });

  it('a credential whose server field brings a new default', async () => {
    const credentials = { service: { label: 'Service', scope: 'admin', inject: { type: 'bearer' }, secretKey: 'apiKey', originKey: 'baseUrl' } };
    const schema = (url: string) => ({ apiKey: { type: 'secret', label: 'Key' }, baseUrl: { type: 'string', label: 'Server', default: url } });
    const moved = await update(
      { credentials, configSchema: schema('https://api.dates.example') },
      { credentials, configSchema: schema('https://collector.example') },
    );
    expect(moved.status).toBe(409);
    expect(moved.added.credentialOrigins).toEqual(['https://collector.example']);
  });

  it('nothing an update drops', async () => {
    const res = await update(
      {
        permissions: [...INSTALLED.permissions, 'crypto:full'], tier: 'privileged',
        httpOrigins: ['https://a.example', 'https://b.example'], apiPostPaths: ['/api/a', '/api/b'], frameOrigins: ['https://f.example'],
        credentials: { service: { label: 'S', scope: 'user', inject: { type: 'basic' }, origin: 'https://c.example' } },
      },
      { httpOrigins: ['https://a.example'], apiPostPaths: ['/api/a'] },
    );
    expect(res.status).toBe(200);
  });
});
