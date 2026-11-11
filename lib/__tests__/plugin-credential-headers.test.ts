/**
 * @vitest-environment node
 *
 * The request header a credential puts its secret into comes from a short
 * list: `Authorization` and the API-key headers of the services the official
 * plugins talk to, none of which the proxy hands back to a plugin
 * (lib/plugin-secrets/proxy.ts). A package that asks for a name outside the
 * list is refused when it is installed, updated or put back, with the name
 * in the answer.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { NextRequest } from 'next/server';
import JSZip from 'jszip';
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import path from 'node:path';

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
    getPolicy: vi.fn(() => ({ forceEnabledPlugins: [] })),
    updatePolicy: vi.fn(async () => {}),
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
  themeCSSResolver: vi.fn(async () => () => null),
  deletePlugin: vi.fn(async (id: string) => registry.delete(id)),
  updatePluginMeta: vi.fn(async () => null),
}));
vi.mock('@/lib/admin/csp-frame-origins', async (orig) => ({
  ...(await orig<typeof import('@/lib/admin/csp-frame-origins')>()),
  invalidateFrameOriginsCache: vi.fn(),
}));
vi.mock('@/lib/admin/plugin-config', () => ({
  getPluginConfig: vi.fn(async () => ({})),
  deletePluginConfig: vi.fn(async () => {}),
  sealPluginSecrets: vi.fn(async () => {}),
}));
vi.mock('@/lib/admin/plugin-dev', () => ({ getDevPlugin: vi.fn(async () => null), listDevPlugins: vi.fn(async () => []) }));
vi.mock('@/lib/desktop/server-policy', () => ({ devicePolicyPluginRefusal: () => null }));
let kept: Record<string, unknown> = {};
vi.mock('@/lib/admin/extension-history', () => ({
  HistoryError: class HistoryError extends Error { status = 404; },
  readHistoryEntry: vi.fn(async () => ({ kind: 'plugin', entry: { ...kept }, code: 'module.exports = {};' })),
  listHistory: vi.fn(async () => []),
  keptVersions: () => ({}),
}));

import { POST as marketplaceInstall } from '@/app/api/admin/marketplace/route';
import { POST as uploadRoute } from '@/app/api/admin/plugins/route';
import { POST as rollbackRoute } from '@/app/api/admin/extensions/[kind]/[id]/rollback/route';
import { CREDENTIAL_HEADER_NAMES, checkCredentials, checkInject } from '../plugin-secrets/credentials';
import { checkPluginManifest } from '@/lib/extension-package';

/** The names a credential may use: `Authorization` and the API-key headers of the official plugins' services. */
const LISTED = ['Authorization', 'X-API-Key', 'X-Goog-Api-Key', 'DHL-API-Key', '17token', 'secretkey'];

const ID = 'notes';
const MANIFEST = {
  id: ID, name: 'Notes', version: '1.0.0', author: 'x', description: 'd', type: 'hook', entrypoint: 'index.js',
  permissions: ['http:proxy'],
  configSchema: { apiKey: { type: 'secret', label: 'Key' } },
};
const credential = (inject: unknown) => ({ svc: { label: 'Service', scope: 'admin', inject, secretKey: 'apiKey', origin: 'https://api.notes.example' } });
const INSTALLED = { ...MANIFEST, version: '0.9.0', enabled: true, credentials: credential({ type: 'bearer' }) };

async function zipOf(manifest: Record<string, unknown>): Promise<Uint8Array> {
  const zip = new JSZip();
  zip.file('manifest.json', JSON.stringify(manifest));
  zip.file('index.js', 'module.exports = {};');
  return zip.generateAsync({ type: 'uint8array' });
}
async function marketplace(manifest: Record<string, unknown>, accept: Record<string, unknown> = {}) {
  const buf = await zipOf(manifest);
  const bytes = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer;
  const sha256 = createHash('sha256').update(new Uint8Array(bytes)).digest('hex');
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    const u = String(url);
    if (u.includes('/api/v2/extensions/') && u.includes('/versions/') && !u.endsWith('/bundle')) {
      return Response.json({ data: { version: '1.0.0', channel: 'stable', publishedAt: null, minAppVersion: null, maxAppVersion: null, permissions: ['http:proxy'], size: 0, sha256, yanked: null, downloadUrl: '' } });
    }
    return new Response(bytes);
  }));
  const res = await marketplaceInstall(new NextRequest('http://localhost/api/admin/marketplace', {
    method: 'POST', body: JSON.stringify({ slug: ID, version: '1.0.0', type: 'plugin', ...accept }), headers: { 'content-type': 'application/json' },
  }));
  return { status: res.status, body: await res.json() };
}
async function upload(manifest: Record<string, unknown>) {
  const form = new FormData();
  form.append('file', new File([(await zipOf(manifest)) as BlobPart], 'p.zip', { type: 'application/zip' }));
  const res = await uploadRoute(new NextRequest('http://localhost/api/admin/plugins', { method: 'POST', body: form }));
  return { status: res.status, body: await res.json() };
}
async function rollback(version: string, accept: Record<string, unknown> = {}) {
  const res = await rollbackRoute(
    new NextRequest(`http://localhost/api/admin/extensions/plugin/${ID}/rollback`, { method: 'POST', body: JSON.stringify({ version, ...accept }), headers: { 'content-type': 'application/json' } }),
    { params: Promise.resolve({ kind: 'plugin', id: ID }) },
  );
  return { status: res.status, body: await res.json() };
}

beforeEach(() => { registry.clear(); kept = {}; });
afterEach(() => { vi.unstubAllGlobals(); });

describe('a credential that names a header outside the list', () => {
  const echoed = credential({ type: 'header', name: 'X-Request-Id' });

  it('is refused on an update, and the answer names the header', async () => {
    registry.set(ID, INSTALLED);
    const res = await marketplace({ ...MANIFEST, credentials: echoed });
    expect(res.status).toBe(400);
    expect(res.body.error).toContain('"X-Request-Id"');
    expect(res.body.error).toContain('credentials.svc');
    expect(registry.get(ID)!.version).toBe('0.9.0');
  });

  it('is refused on a first install, whatever the request accepts', async () => {
    const res = await marketplace({ ...MANIFEST, credentials: echoed }, { acceptGrants: { credentialOrigins: ['https://api.notes.example'] }, force: true });
    expect(res.status).toBe(400);
    expect(registry.has(ID)).toBe(false);
  });

  it('is refused in an uploaded ZIP', async () => {
    registry.set(ID, INSTALLED);
    const res = await upload({ ...MANIFEST, credentials: echoed });
    expect(res.status).toBe(400);
    expect(res.body.error).toContain('"X-Request-Id"');
    expect(registry.get(ID)!.version).toBe('0.9.0');
  });

  it('is refused when a kept version that has it is put back', async () => {
    registry.set(ID, { ...INSTALLED, version: '1.1.0' });
    kept = { ...INSTALLED, version: '1.0.0', credentials: echoed };
    const res = await rollback('1.0.0');
    expect(res.status).toBe(400);
    expect(res.body.error).toContain('"X-Request-Id"');
    expect(registry.get(ID)!.version).toBe('1.1.0');
  });

  it.each([
    // Every response header the proxy hands back to a plugin, and one name under each prefix it passes.
    'X-Request-Id', 'x-request-id', 'Content-Type', 'Content-Range', 'Content-Disposition', 'Content-Language', 'Accept-Ranges',
    'ETag', 'Last-Modified', 'DAV', 'Retry-After', 'OC-ETag', 'OC-FileId',
    'X-RateLimit-Key', 'RateLimit-Policy', 'Anthropic-RateLimit-Key', 'X-OC-Token', 'OC-Token',
    // Other names a gateway is known to copy into its answer, and headers the proxy owns.
    'X-Correlation-Id', 'Traceparent', 'X-Amzn-Trace-Id', 'X-Custom-Token', 'Cookie', 'Proxy-Authorization', 'Host',
  ])('%s is no header for a credential', (name) => {
    expect(checkInject({ type: 'header', name })).toBeNull();
    const { errors } = checkCredentials({ svc: { label: 'S', scope: 'user', inject: { type: 'header', name } } }, undefined);
    expect(errors.join()).toContain(`"${name}"`);
  });

  it('a user\'s own account is held to the list as well', () => {
    const check = checkPluginManifest({ ...MANIFEST, credentials: { mine: { label: 'Mine', scope: 'user', inject: { type: 'header', name: 'X-Request-Id' } } } });
    expect(check.manifest).toBeNull();
    expect(check.errors.join()).toContain('"X-Request-Id"');
  });
});

describe('a credential that names a header from the list', () => {
  it.each(LISTED)('%s installs, in any case', async (name) => {
    for (const spelled of [name, name.toLowerCase(), name.toUpperCase()]) {
      expect(checkInject({ type: 'header', name: spelled })).toEqual({ type: 'header', name: spelled });
    }
    registry.set(ID, INSTALLED);
    const res = await marketplace({ ...MANIFEST, credentials: credential({ type: 'header', name }) });
    expect(res.status).toBe(200);
  });

  it('the list is short', () => {
    expect(CREDENTIAL_HEADER_NAMES).toEqual(LISTED);
  });

  it('bearer and basic need no name, and a rollback to a version with a listed header goes through', async () => {
    registry.set(ID, { ...INSTALLED, version: '1.1.0', credentials: credential({ type: 'header', name: 'X-API-Key' }) });
    kept = { ...INSTALLED, version: '1.0.0', credentials: credential({ type: 'header', name: 'x-api-key', prefix: 'Key ' }) };
    expect((await rollback('1.0.0')).status).toBe(200);
    expect(checkInject({ type: 'basic' })).toEqual({ type: 'basic' });
  });
});

// The plugins repo inside this checkout, when it is there (it is not in CI).
const PLUGINS = [path.resolve(process.cwd(), 'repos/plugins')].find((p) => existsSync(p));

describe.runIf(!!PLUGINS)('the official plugins', () => {
  it('every credential of every manifest passes', () => {
    const names = new Set<string>();
    let manifests = 0;
    for (const dir of readdirSync(PLUGINS!, { withFileTypes: true })) {
      const file = path.join(PLUGINS!, dir.name, 'manifest.json');
      if (!dir.isDirectory() || !existsSync(file)) continue;
      const manifest = JSON.parse(readFileSync(file, 'utf8'));
      manifests++;
      const check = checkCredentials(manifest.credentials, manifest.configSchema);
      expect(check.errors, `${dir.name}`).toEqual([]);
      for (const spec of Object.values(manifest.credentials ?? {}) as { inject?: { type?: string; name?: string } }[]) {
        if (spec.inject?.type === 'header' && spec.inject.name) names.add(spec.inject.name.toLowerCase());
      }
    }
    expect(manifests).toBeGreaterThan(10);
    expect([...names].filter((n) => !LISTED.map((x) => x.toLowerCase()).includes(n))).toEqual([]);
  });
});
