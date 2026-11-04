/**
 * @vitest-environment node
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import JSZip from 'jszip';

const appName = vi.hoisted(() => ({ value: 'Webmail' }));

vi.mock('@/lib/admin/session', () => ({
  requireAdminAuth: vi.fn(async () => ({ session: { sub: 'admin' } })),
  getClientIP: () => '127.0.0.1',
}));
vi.mock('@/lib/admin/config-manager', () => ({
  configManager: {
    ensureLoaded: vi.fn(async () => {}),
    get: vi.fn((key: string) => (key === 'extensionDirectoryUrl' ? 'https://extensions.test' : key === 'appName' ? appName.value : undefined)),
  },
}));
vi.mock('@/lib/admin/plugin-registry', () => ({
  getPluginRegistry: vi.fn(async () => ({
    plugins: [{ id: 'pretty-dates', name: 'Pretty Dates', version: '1.1.0', permissions: ['email:read'], enabled: true, source: { kind: 'marketplace', slug: 'pretty-dates', directoryUrl: 'https://extensions.test' } }],
  })),
  getThemeRegistry: vi.fn(async () => ({ themes: [] })),
}));
vi.mock('@/lib/admin/extension-history', () => ({
  listHistory: vi.fn(async () => [{ version: '1.0.0', savedAt: '2026-10-10T00:00:00.000Z', contentHash: 'a'.repeat(64) }]),
}));

import { GET } from '../[slug]/route';

const summary = {
  slug: 'pretty-dates', name: 'Pretty Dates', type: 'plugin', pluginType: 'hook', description: 'd', tags: [], license: 'MIT',
  featured: false, status: 'approved', iconUrl: null, bannerUrl: null,
  author: { login: 'o', name: 'O', avatarUrl: null, verified: true, organization: false, url: 'https://extensions.test/author/o' },
  downloads: 5, rating: { average: 4.5, count: 2 }, deprecated: null, source: { host: 'github.com', repo: 'o/r', subpath: null },
  url: 'https://extensions.test/extension/pretty-dates', createdAt: null, updatedAt: null,
};
const v = (version: string, extra: Record<string, unknown> = {}) => ({
  version, channel: 'stable', publishedAt: null, minAppVersion: null, maxAppVersion: null, permissions: ['email:read'], size: 10,
  sha256: 'b'.repeat(64), yanked: null, downloadUrl: '', changelog: `notes ${version}`, downloads: 1, signature: { keyId: 'k' }, ...extra,
});

async function bundle(version: string) {
  const zip = new JSZip();
  zip.file('manifest.json', JSON.stringify({ id: 'pretty-dates', name: 'Pretty Dates', version, author: 'x', description: 'd', type: 'hook', permissions: ['email:read'], entrypoint: 'index.js' }));
  zip.file('index.js', `// ${version}`);
  const buf = await zip.generateAsync({ type: 'uint8array' });
  return buf.slice().buffer as ArrayBuffer;
}

function directory() {
  const versions = [v('1.2.0'), v('1.1.0'), v('1.0.0', { yanked: { at: '2026-10-01T00:00:00.000Z', reason: 'bad dates' } })];
  const calls: string[] = [];
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    const u = new URL(String(url));
    calls.push(u.pathname + u.search);
    if (u.pathname === '/api/v2/extensions/pretty-dates') {
      return Response.json({ data: { ...summary, latest: versions[0], newest: versions[0], longDescription: 'long', versions: versions.slice(0, 2), screenshots: [], themePreviews: [], advisories: [], permissions: [
        { id: 'http:proxy', title: 'Use accounts you connect', body: "Send requests through {appName}'s server.", highRisk: true },
      ] } });
    }
    if (u.pathname === '/api/v2/extensions/pretty-dates/versions') return Response.json({ data: versions });
    const m = /\/versions\/([^/]+)\/bundle$/.exec(u.pathname);
    if (m) return new Response(await bundle(decodeURIComponent(m[1])));
    return Response.json({ error: { message: 'nope' } }, { status: 404 });
  }));
  return calls;
}

const preview = (query = '') => GET(
  new NextRequest(`http://localhost/api/admin/marketplace/pretty-dates${query}`),
  { params: Promise.resolve({ slug: 'pretty-dates' }) },
);

afterEach(() => vi.unstubAllGlobals());

describe('GET /api/admin/marketplace/[slug]', () => {
  it('previews the newest compatible version and lists every version, withdrawn ones included', async () => {
    const calls = directory();
    const res = await preview();
    expect(res.status).toBe(200);
    const body = await res.json();

    expect(body.preview.version).toBe('1.2.0');
    expect(body.bundle.manifest.version).toBe('1.2.0');
    expect(body.bundle.source.content).toBe('// 1.2.0');
    expect(body.extension.versions.map((x: { version: string }) => x.version)).toEqual(['1.2.0', '1.1.0', '1.0.0']);
    expect(body.extension.versions[2].yanked).toMatchObject({ reason: 'bad dates' });
    expect(body.extension.versions[0]).toMatchObject({ signed: true, changelog: 'notes 1.2.0' });
    expect(body.extension.rating).toEqual({ average: 4.5, count: 2 });
    expect(body).toMatchObject({ installed: true, installedVersion: '1.1.0', installedSource: { kind: 'marketplace' } });
    expect(body.history).toEqual([{ version: '1.0.0', savedAt: '2026-10-10T00:00:00.000Z', contentHash: 'a'.repeat(64) }]);
    expect(calls.some((c) => c.startsWith('/api/v2/extensions/pretty-dates/versions?include=yanked'))).toBe(true);
    expect(body.requestedVersionMissing).toBeNull();
  });

  it('previews the version an install link asked for', async () => {
    directory();
    const body = await (await preview('?version=1.0.0')).json();
    expect(body.preview).toMatchObject({ version: '1.0.0', yanked: { reason: 'bad dates' } });
    expect(body.bundle.source.content).toBe('// 1.0.0');
  });

  it('says when the requested version is gone and falls back to the newest', async () => {
    directory();
    const body = await (await preview('?version=0.9.0')).json();
    expect(body.requestedVersionMissing).toBe('0.9.0');
    expect(body.preview.version).toBe('1.2.0');
  });

  it('fills the app name into the permission texts the directory sends', async () => {
    directory();
    appName.value = 'Acme Mail';
    let body = await (await preview()).json();
    expect(body.extension.permissionDetails).toEqual([
      { id: 'http:proxy', title: 'Use accounts you connect', body: "Send requests through Acme Mail's server.", highRisk: true },
    ]);

    appName.value = 'Webmail';
    body = await (await preview()).json();
    expect(body.extension.permissionDetails[0].body).toBe("Send requests through Bulwark's server.");
  });

  it('refuses a malformed version instead of forwarding it', async () => {
    directory();
    expect((await preview('?version=..%2F..%2Fetc')).status).toBe(400);
  });
});

describe('permissions in the preview', () => {
  async function previewOf(manifest: Record<string, unknown>) {
    const zip = new JSZip();
    zip.file('manifest.json', JSON.stringify({ id: 'pretty-dates', name: 'Pretty Dates', version: '1.2.0', author: 'x', description: 'd', type: 'hook', entrypoint: 'index.js', ...manifest }));
    zip.file('index.js', '// x');
    const bytes = (await zip.generateAsync({ type: 'uint8array' })).slice().buffer as ArrayBuffer;
    const versions = [v('1.2.0')];
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      const u = new URL(String(url));
      if (u.pathname === '/api/v2/extensions/pretty-dates') {
        return Response.json({ data: { ...summary, latest: versions[0], newest: versions[0], longDescription: 'long', versions, permissions: [{ id: 'crypto:full', title: 'Full crypto', body: 'b', highRisk: true }], screenshots: [], themePreviews: [], advisories: [] } });
      }
      if (u.pathname.endsWith('/versions')) return Response.json({ data: versions });
      if (u.pathname.endsWith('/bundle')) return new Response(bytes);
      return Response.json({ data: versions[0] });
    }));
    const res = await GET(new NextRequest('http://localhost/api/admin/marketplace/pretty-dates'), { params: Promise.resolve({ slug: 'pretty-dates' }) });
    return res.json();
  }

  it('names an optional keystore with its own text and as high risk, even if the directory does not', async () => {
    const body = await previewOf({ tier: 'privileged', permissions: ['crypto:full'], optionalPermissions: ['keystore'] });
    const entry = body.extension.permissionDetails.find((p: { id: string }) => p.id === 'keystore');
    expect(entry).toMatchObject({ highRisk: true });
    expect(entry.title).toMatch(/certificates/i);
    expect(body.extension.permissionDetails.filter((p: { id: string }) => p.id === 'crypto:full')).toHaveLength(1);
  });

  it('says what this version adds to the installed one', async () => {
    const body = await previewOf({ tier: 'privileged', permissions: ['crypto:full', 'email:read'], optionalPermissions: ['keystore'] });
    expect(body.bundle.addedPermissions).toEqual(['crypto:full', 'keystore']);
  });

  it('adds nothing for an untrusted plugin, which can not get it', async () => {
    const body = await previewOf({ permissions: ['email:read'], optionalPermissions: ['keystore'] });
    expect(body.extension.permissionDetails.map((p: { id: string }) => p.id)).not.toContain('keystore');
    expect(body.bundle.addedPermissions).toEqual([]);
  });
});
