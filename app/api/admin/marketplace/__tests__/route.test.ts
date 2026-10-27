/**
 * @vitest-environment node
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { NextRequest } from 'next/server';
import JSZip from 'jszip';
import { createHash } from 'node:crypto';

// Read when the route module loads, so it has to be set before the import.
vi.hoisted(() => { process.env.NEXT_PUBLIC_APP_VERSION = '1.15.0'; });

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

/**
 * A directory that lists one version (1.0.0 unless `meta` says otherwise) and
 * serves `bytes` for it. The route asks about the version first, then
 * downloads the bundle; both answers come from here, routed by URL.
 */
function directory(bytes: ArrayBuffer | Uint8Array, meta: Record<string, unknown> = {}, opts: { missing?: boolean } = {}) {
  const sha256 = createHash('sha256').update(new Uint8Array(bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes))).digest('hex');
  const calls: string[] = [];
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    const u = String(url);
    calls.push(u);
    if (u.includes('/api/v2/extensions/') && u.includes('/versions/') && !u.endsWith('/bundle')) {
      if (opts.missing) return Response.json({ error: { message: 'Version not found', code: 'not_found' } }, { status: 404 });
      return Response.json({ data: { version: '1.0.0', channel: 'stable', publishedAt: null, minAppVersion: null, maxAppVersion: null, permissions: [], size: 0, sha256, yanked: null, downloadUrl: '', ...meta } });
    }
    return new Response(bytes instanceof Uint8Array ? (bytes.slice().buffer as ArrayBuffer) : bytes);
  }));
  return calls;
}

function install(body: Record<string, unknown>) {
  return POST(new NextRequest('http://localhost/api/admin/marketplace', {
    method: 'POST',
    body: JSON.stringify(body),
    headers: { 'content-type': 'application/json' },
  }));
}

const MANIFEST = {
  name: 'Pretty Dates', version: '1.0.0', author: 'x', description: 'd',
  type: 'hook', permissions: ['email:read'], entrypoint: 'index.js',
};

beforeEach(() => {
  registry.clear();
});
afterEach(() => {
  vi.unstubAllGlobals();
});

describe('POST /api/admin/marketplace', () => {
  it('installs a plugin under its directory slug and records where it came from', async () => {
    const calls = directory(await bundle({ ...MANIFEST, id: 'pretty-dates' }));

    const res = await install({ slug: 'pretty-dates', version: '1.0.0', type: 'plugin' });

    expect(res.status).toBe(200);
    expect(registry.get('pretty-dates')).toMatchObject({
      version: '1.0.0',
      source: { kind: 'marketplace', slug: 'pretty-dates', directoryUrl: 'https://extensions.test' },
    });
    // v2 only: the version is looked up, then its bundle fetched from the same directory.
    expect(calls).toEqual([
      'https://extensions.test/api/v2/extensions/pretty-dates/versions/1.0.0',
      'https://extensions.test/api/v2/extensions/pretty-dates/versions/1.0.0/bundle',
    ]);
  });

  it('answers 404 for a version the directory does not have', async () => {
    directory(await bundle({ ...MANIFEST, id: 'pretty-dates' }), {}, { missing: true });
    const res = await install({ slug: 'pretty-dates', version: '9.9.9', type: 'plugin' });
    expect(res.status).toBe(404);
    expect(registry.size).toBe(0);
  });

  it('refuses a withdrawn version unless the admin insists', async () => {
    const bytes = await bundle({ ...MANIFEST, id: 'pretty-dates' });
    directory(bytes, { yanked: { at: '2026-10-01T00:00:00.000Z', reason: 'breaks replies' } });

    const refused = await install({ slug: 'pretty-dates', version: '1.0.0', type: 'plugin' });
    expect(refused.status).toBe(409);
    const body = await refused.json();
    expect(body.error).toMatch(/withdrawn.*breaks replies/);
    expect(body.yanked).toMatchObject({ reason: 'breaks replies' });
    expect(registry.size).toBe(0);

    directory(bytes, { yanked: { at: '2026-10-01T00:00:00.000Z', reason: 'breaks replies' } });
    const forced = await install({ slug: 'pretty-dates', version: '1.0.0', type: 'plugin', force: true });
    expect(forced.status).toBe(200);
    expect((await forced.json()).yanked).toMatchObject({ reason: 'breaks replies' });
    expect(registry.has('pretty-dates')).toBe(true);
  });

  it('refuses a version this Bulwark is too new or too old for', async () => {
    const bytes = await bundle({ ...MANIFEST, id: 'pretty-dates' });
    directory(bytes, { maxAppVersion: '1.14.0' });
    const tooNew = await install({ slug: 'pretty-dates', version: '1.0.0', type: 'plugin' });
    expect(tooNew.status).toBe(400);
    expect((await tooNew.json()).error).toMatch(/up to 1\.14\.0/);

    directory(bytes, { minAppVersion: '2.0.0' });
    const tooOld = await install({ slug: 'pretty-dates', version: '1.0.0', type: 'plugin' });
    expect(tooOld.status).toBe(400);
    expect((await tooOld.json()).error).toMatch(/Needs Bulwark 2\.0\.0/);
    expect(registry.size).toBe(0);
  });

  it('refuses a bundle whose bytes differ from what the directory lists', async () => {
    directory(await bundle({ ...MANIFEST, id: 'pretty-dates' }), { sha256: 'f'.repeat(64) });
    const res = await install({ slug: 'pretty-dates', version: '1.0.0', type: 'plugin' });
    expect(res.status).toBe(502);
    expect(registry.size).toBe(0);
  });

  it('refuses a version that is not a release version', async () => {
    directory(await bundle({ ...MANIFEST, id: 'pretty-dates' }));
    const res = await install({ slug: 'pretty-dates', version: '../../x', type: 'plugin' });
    expect(res.status).toBe(400);
  });

  it('refuses a ZIP bomb from the directory', async () => {
    const zip = new JSZip();
    zip.file('manifest.json', JSON.stringify({ ...MANIFEST, id: 'pretty-dates' }));
    zip.file('index.js', new Uint8Array(30 * 1024 * 1024));
    const bytes = await zip.generateAsync({ type: 'uint8array', compression: 'DEFLATE' });
    directory(bytes);

    const res = await install({ slug: 'pretty-dates', version: '1.0.0', type: 'plugin' });

    expect(res.status).toBe(400);
    expect(registry.size).toBe(0);
  });

  it('stops downloading a bundle once it is larger than a package may be', async () => {
    const meta = { version: '1.0.0', channel: 'stable', minAppVersion: null, maxAppVersion: null, permissions: [], sha256: '', yanked: null };
    let sent = 0;
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      if (!String(url).endsWith('/bundle')) return Response.json({ data: meta });
      // A directory that never stops sending.
      return new Response(new ReadableStream({
        pull(controller) {
          if (sent >= 200 * 1024 * 1024) { controller.close(); return; }
          sent += 1024 * 1024;
          controller.enqueue(new Uint8Array(1024 * 1024));
        },
      }));
    }));

    const res = await install({ slug: 'pretty-dates', version: '1.0.0', type: 'plugin' });

    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(sent).toBeLessThan(10 * 1024 * 1024);
    expect(registry.size).toBe(0);
  });

  it('refuses a bundle whose manifest id differs from the slug', async () => {
    // Otherwise a directory entry can overwrite another installed plugin,
    // inheriting its enabled and force-enabled state, while the admin UI
    // (which keys install status by slug) still shows "not installed".
    registry.set('pgp-plugin', { id: 'pgp-plugin', forceEnabled: true, version: '2.0.0' });
    directory(await bundle({ ...MANIFEST, id: 'pgp-plugin' }));

    const res = await install({ slug: 'pretty-dates', version: '1.0.0', type: 'plugin' });

    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/does not match/);
    expect(registry.get('pgp-plugin')?.version).toBe('2.0.0');
  });
});
