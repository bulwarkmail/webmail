/**
 * @vitest-environment node
 *
 * What a marketplace update is asked about, in more shapes (same mocks as
 * marketplace-unlisted-permissions.test.ts): a grant that moves between
 * kinds, wider hosts and paths, manifests in shapes the reader doesn't
 * expect, and credentials that send a stored secret somewhere else. The
 * credential cases save the update through the route and then ask the real
 * resolveCredential where the secret goes.
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

// What the admin saved on the plugin's settings page.
const savedConfig = new Map<string, Record<string, unknown>>();
vi.mock('@/lib/admin/plugin-config', () => ({
  getPluginConfig: vi.fn(async (id: string) => savedConfig.get(id) ?? {}),
}));
vi.mock('@/lib/plugin-secrets/vault', () => ({ getUserCredential: vi.fn(async () => null) }));

import { POST } from '../route';
import { resolveCredential } from '@/lib/plugin-secrets/proxy';

async function bundleOf(text: string, code = 'module.exports = {};'): Promise<ArrayBuffer> {
  const zip = new JSZip();
  zip.file('manifest.json', text);
  zip.file('index.js', code);
  const buf = await zip.generateAsync({ type: 'uint8array' });
  return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer;
}
const bundle = (manifest: Record<string, unknown>) => bundleOf(JSON.stringify(manifest));

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
const INSTALLED = {
  id: 'pretty-dates', name: 'Pretty Dates', version: '0.9.0', enabled: true,
  permissions: ['email:read', 'http:fetch', 'http:post', 'http:proxy'],
};
const MANIFEST = { ...BASE, id: 'pretty-dates', permissions: INSTALLED.permissions };

async function update(installed: Record<string, unknown>, manifest: Record<string, unknown>, accept: Record<string, unknown> = {}) {
  registry.set('pretty-dates', { ...INSTALLED, ...installed });
  directory(await bundle({ ...MANIFEST, ...manifest }));
  const res = await install({ slug: 'pretty-dates', version: '1.0.0', type: 'plugin', ...accept });
  return { status: res.status, body: await res.json() };
}

beforeEach(() => { registry.clear(); themes.clear(); savedConfig.clear(); });
afterEach(() => { vi.unstubAllGlobals(); });

describe('a grant that moves from one field to another is new where it lands', () => {
  const HOST = 'https://api.dates.example';
  it('a host the plugin may fetch, now also embedded', async () => {
    const res = await update({ httpOrigins: [HOST] }, { httpOrigins: [HOST], frameOrigins: [HOST] });
    expect(res.status).toBe(409);
    expect(res.body.grantsAdded.frameOrigins).toEqual([HOST]);
  });
  it('a host the plugin may embed, now also fetched', async () => {
    const res = await update({ frameOrigins: [HOST] }, { httpOrigins: [HOST] });
    expect(res.status).toBe(409);
    expect(res.body.grantsAdded.httpOrigins).toEqual([HOST]);
  });
  it('a host the plugin may fetch, now a credential server', async () => {
    const res = await update({ httpOrigins: [HOST] }, {
      httpOrigins: [HOST],
      configSchema: { apiKey: { type: 'secret', label: 'Key' } },
      credentials: { svc: { label: 'S', scope: 'admin', inject: { type: 'bearer' }, secretKey: 'apiKey', origin: HOST } },
    });
    expect(res.status).toBe(409);
    expect(res.body.grantsAdded.credentialOrigins).toEqual([HOST]);
  });
  it('accepting it as one kind does not accept it as another', async () => {
    const res = await update({ httpOrigins: [HOST] }, { httpOrigins: [HOST], frameOrigins: [HOST] }, { acceptGrants: { httpOrigins: [HOST], credentialOrigins: [HOST] } });
    expect(res.status).toBe(409);
  });
});

describe('wider entries', () => {
  it.each([
    ['a wildcard over a host', ['https://api.example.com'], ['https://*.example.com']],
    ['a wildcard one level up', ['https://*.api.example.com'], ['https://*.example.com']],
    ['a wildcard one level down', ['https://*.example.com'], ['https://*.api.example.com']],
    ['another port', ['https://api.example.com'], ['https://api.example.com:8443']],
    ['a wildcard with another port', ['https://*.example.com'], ['https://a.example.com:8443']],
    ['two labels under a wildcard', ['https://*.example.com'], ['https://a.b.example.com']],
    ['the parent of a wildcard', ['https://*.example.com'], ['https://example.com']],
    ['a look-alike suffix', ['https://*.example.com'], ['https://a.notexample.com']],
  ])('%s is asked about', async (_name, before, after) => {
    const res = await update({ httpOrigins: before }, { httpOrigins: after });
    expect(res.status).toBe(409);
    expect(res.body.grantsAdded.httpOrigins).toEqual(after);
  });

  it.each([
    ['upper case', ['https://api.example.com'], ['https://API.EXAMPLE.COM']],
    ['the https port spelled out', ['https://api.example.com'], ['https://api.example.com:443']],
    ['a host under a held wildcard', ['https://*.example.com'], ['https://Api.example.com']],
  ])('%s is not', async (_name, before, after) => {
    expect((await update({ httpOrigins: before }, { httpOrigins: after })).status).toBe(200);
  });

  it.each([
    ['a prefix over a path', ['/api/dates/save'], ['/api/dates/']],
    ['a shorter prefix', ['/api/dates/v1/'], ['/api/dates/']],
    ['the path a prefix does not include', ['/api/dates/'], ['/api/dates']],
    ['another case', ['/api/dates'], ['/api/Dates']],
    ['a sibling that shares the start', ['/api/dates'], ['/api/dates-admin']],
  ])('%s is asked about', async (_name, before, after) => {
    const res = await update({ apiPostPaths: before }, { apiPostPaths: after });
    expect(res.status).toBe(409);
    expect(res.body.grantsAdded.apiPostPaths).toEqual(after);
  });
});

describe('a manifest in a shape the reader does not expect grants nothing unseen', () => {
  async function raw(text: string) {
    registry.set('pretty-dates', { ...INSTALLED });
    directory(await bundleOf(text));
    const res = await install({ slug: 'pretty-dates', version: '1.0.0', type: 'plugin' });
    return { status: res.status, body: await res.json(), saved: registry.get('pretty-dates')! };
  }
  const head = JSON.stringify(MANIFEST).slice(0, -1);

  it.each([
    ['a string for httpOrigins', '"httpOrigins":"https://collector.example"'],
    ['an object for httpOrigins', '"httpOrigins":{"0":"https://collector.example","length":1}'],
    ['a string for permissions', '"permissions":"email:read email:send"'],
    ['a nested list for optionalPermissions', '"optionalPermissions":[["email:send"]]'],
    ['a string for optionalPermissions', '"optionalPermissions":"email:send"'],
    ['a list for credentials', '"credentials":[{"label":"S","scope":"user","inject":{"type":"bearer"},"origin":"https://collector.example"}]'],
    ['another case for the tier', '"tier":"Privileged"'],
    ['a list for the tier', '"tier":["privileged"]'],
  ])('%s is refused, and the installed version stays', async (_name, extra) => {
    const res = await raw(`${head},${extra}}`);
    expect(res.status).toBe(400);
    expect(res.saved.version).toBe('0.9.0');
  });

  it.each([
    ['a nested list for httpOrigins', '"httpOrigins":[["https://collector.example"]]'],
    ['a trailing dot', '"httpOrigins":["https://collector.example."]'],
    ['a trailing slash', '"httpOrigins":["https://collector.example/"]'],
    ['a path', '"apiPostPaths":["/api/"]'],
    ['user info', '"httpOrigins":["https://api.dates.example@collector.example"]'],
  ])('%s is left out, so nothing is saved for it', async (_name, extra) => {
    const res = await raw(`${head},${extra}}`);
    expect(res.status).toBe(200);
    expect(res.saved.httpOrigins).toBeUndefined();
    expect(res.saved.apiPostPaths).toBeUndefined();
  });

  it('a key written twice counts the way it is saved (the last one)', async () => {
    const res = await raw(`${head},"httpOrigins":[],"httpOrigins":["https://collector.example"]}`);
    expect(res.status).toBe(409);
    expect(res.body.grantsAdded.httpOrigins).toEqual(['https://collector.example']);
    const other = await raw(`${head},"tier":"untrusted","permissions":["email:read","http:fetch","http:post","http:proxy","crypto:full"],"tier":"privileged"}`);
    expect(other.status).toBe(409);
    expect(other.body.grantsAdded).toMatchObject({ permissions: ['crypto:full'], privileged: true });
  });

  it('a __proto__ key grants nothing', async () => {
    const res = await raw(`${head},"__proto__":{"tier":"privileged","httpOrigins":["https://collector.example"]}}`);
    expect(res.status).toBe(200);
    expect(res.saved).not.toHaveProperty('tier');
    expect(res.saved.httpOrigins).toBeUndefined();
  });
});

describe('credentials: which secret goes to which server', () => {
  const user = { username: 'u', serverUrl: 'https://mail.example' };
  const bearer = { type: 'bearer' };

  // Installed: the admin typed their own server into `baseUrl` and a key into `apiKey`;
  // `docsUrl` is a plain setting whose value came from the plugin's manifest default.
  const v1 = {
    configSchema: {
      apiKey: { type: 'secret', label: 'Key' },
      baseUrl: { type: 'string', label: 'Server' },
      docsUrl: { type: 'string', label: 'Help page', default: 'https://collector.example/help' },
    },
    credentials: { svc: { label: 'Service', scope: 'admin', inject: bearer, secretKey: 'apiKey', originKey: 'baseUrl' } },
  };

  it('an update that reads the credential server from another setting is asked about', async () => {
    savedConfig.set('pretty-dates', { apiKey: 'fake-key-for-the-test', baseUrl: 'https://intranet.example', docsUrl: 'https://collector.example/help' });
    registry.set('pretty-dates', { ...INSTALLED, ...v1 });
    expect((await resolveCredential(user, 'pretty-dates', 'svc'))!.origin).toBe('https://intranet.example');

    // 1.0.0 drops the default (so the manifest names no server) and points the credential at `docsUrl`.
    const v2 = {
      configSchema: { ...v1.configSchema, docsUrl: { type: 'string', label: 'Help page' } },
      credentials: { svc: { ...v1.credentials.svc, originKey: 'docsUrl' } },
    };
    directory(await bundle({ ...MANIFEST, ...v2 }));
    const res = await install({ slug: 'pretty-dates', version: '1.0.0', type: 'plugin' });

    // Without a question, the key the admin entered for their own server now goes here:
    const now = await resolveCredential(user, 'pretty-dates', 'svc');
    expect({ status: res.status, keyGoesTo: now!.origin }).toEqual({ status: 409, keyGoesTo: 'https://intranet.example' });
  });

  it('an update that sends one credential\'s secret to another credential\'s server is asked about', async () => {
    const two = {
      configSchema: { licence: { type: 'secret', label: 'Licence' }, apiKey: { type: 'secret', label: 'Mail service key' } },
      credentials: {
        vendor: { label: 'Vendor', scope: 'admin', inject: bearer, secretKey: 'licence', origin: 'https://vendor.example' },
        mailsvc: { label: 'Mail service', scope: 'admin', inject: bearer, secretKey: 'apiKey', origin: 'https://api.mailservice.example' },
      },
    };
    savedConfig.set('pretty-dates', { licence: 'fake-licence', apiKey: 'fake-mail-service-key' });
    registry.set('pretty-dates', { ...INSTALLED, ...two });
    expect((await resolveCredential(user, 'pretty-dates', 'vendor'))!.secret).toBe('fake-licence');

    directory(await bundle({
      ...MANIFEST, ...two,
      credentials: { ...two.credentials, vendor: { ...two.credentials.vendor, secretKey: 'apiKey' } },
    }));
    const res = await install({ slug: 'pretty-dates', version: '1.0.0', type: 'plugin' });

    const now = await resolveCredential(user, 'pretty-dates', 'vendor');
    expect({ status: res.status, vendorGets: now!.secret }).toEqual({ status: 409, vendorGets: 'fake-licence' });
  });

  it('an update that sends a secret along as the user name of another credential is asked about', async () => {
    const two = {
      configSchema: { licence: { type: 'secret', label: 'Licence' }, apiKey: { type: 'secret', label: 'Mail service key' } },
      credentials: {
        vendor: { label: 'Vendor', scope: 'admin', inject: { type: 'basic' }, secretKey: 'licence', origin: 'https://vendor.example' },
        mailsvc: { label: 'Mail service', scope: 'admin', inject: bearer, secretKey: 'apiKey', origin: 'https://api.mailservice.example' },
      },
    };
    savedConfig.set('pretty-dates', { licence: 'fake-licence', apiKey: 'fake-mail-service-key' });
    registry.set('pretty-dates', { ...INSTALLED, ...two });

    directory(await bundle({
      ...MANIFEST, ...two,
      credentials: { ...two.credentials, vendor: { ...two.credentials.vendor, usernameKey: 'apiKey' } },
    }));
    const res = await install({ slug: 'pretty-dates', version: '1.0.0', type: 'plugin' });

    const now = await resolveCredential(user, 'pretty-dates', 'vendor');
    expect({ status: res.status, vendorGetsAsUserName: now!.username }).toEqual({ status: 409, vendorGetsAsUserName: undefined });
  });

  it('an update that adds a credential using a secret the admin already stored is asked about, and names it', async () => {
    const one = {
      configSchema: { apiKey: { type: 'secret', label: 'Key' } },
      credentials: { svc: { label: 'Service', scope: 'admin', inject: bearer, secretKey: 'apiKey', origin: 'https://api.dates.example' } },
    };
    const res = await update(one, {
      ...one,
      configSchema: { ...one.configSchema, docsUrl: { type: 'string', label: 'Help page' } },
      credentials: { ...one.credentials, docs: { label: 'Docs', scope: 'admin', inject: bearer, secretKey: 'apiKey', originKey: 'docsUrl' } },
    });
    expect(res.status).toBe(409);
    expect(res.body.grantsAdded.credentials).toEqual(['docs: the secret in setting "apiKey", sent to the server in setting "docsUrl"']);
    expect(res.body.error).toMatch(/Changes where stored credentials go: docs: the secret in setting "apiKey"/);
  });

  it('switching to basic auth sends the user name setting along, and is asked about', async () => {
    const one = {
      configSchema: { apiKey: { type: 'secret', label: 'Key' }, user: { type: 'string', label: 'User' } },
      credentials: { svc: { label: 'Service', scope: 'admin', inject: bearer, secretKey: 'apiKey', usernameKey: 'user', origin: 'https://api.dates.example' } },
    };
    const res = await update(one, { ...one, credentials: { svc: { ...one.credentials.svc, inject: { type: 'basic' } } } });
    expect(res.status).toBe(409);
    expect(res.body.grantsAdded.credentials).toEqual(['svc: the secret in setting "apiKey" with the user name in setting "user", sent to https://api.dates.example']);
  });

  it('a first install with credentials whose server the admin or the user enters asks nothing about them', async () => {
    directory(await bundle({
      ...MANIFEST,
      configSchema: { apiKey: { type: 'secret', label: 'Key' }, baseUrl: { type: 'string', label: 'Server' } },
      credentials: {
        svc: { label: 'Service', scope: 'admin', inject: bearer, secretKey: 'apiKey', originKey: 'baseUrl' },
        own: { label: 'Own account', scope: 'user', inject: { type: 'basic' } },
      },
    }), { permissions: INSTALLED.permissions });
    expect((await install({ slug: 'pretty-dates', version: '1.0.0', type: 'plugin' })).status).toBe(200);
  });

  it('control: a credential that only changes how the same secret is sent to the same server asks nothing', async () => {
    const one = {
      configSchema: { apiKey: { type: 'secret', label: 'Key' } },
      credentials: { svc: { label: 'Service', scope: 'admin', inject: bearer, secretKey: 'apiKey', origin: 'https://api.dates.example' } },
    };
    const res = await update(one, { ...one, credentials: { svc: { ...one.credentials.svc, label: 'Dates service', inject: { type: 'header', name: 'X-Api-Key' } } } });
    expect(res.status).toBe(200);
  });
});
