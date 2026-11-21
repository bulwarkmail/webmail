/**
 * @vitest-environment node
 *
 * A setting that stops being a secret on an update (same mocks as
 * marketplace-update-grants.test.ts). Each case saves the update through the
 * route and then asks the code that hands out a stored secret where it goes:
 * resolveCredential for the proxy, and the config route a plugin reads its
 * settings from (`?public=1`).
 *
 * A field the installed version declares as `secret` and the new version
 * declares as anything else is an addition the admin is asked about. The
 * second describe holds controls for the credential comparison next to it.
 * That the stored value stays sealed whatever was accepted is checked against
 * the real store in lib/__tests__/plugin-config-sealed.test.ts: the store is
 * a plain map here and keeps no marks.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { NextRequest } from 'next/server';
import JSZip from 'jszip';
import { createHash } from 'node:crypto';

vi.hoisted(() => { process.env.NEXT_PUBLIC_APP_VERSION = '1.21.1'; });

vi.mock('@/lib/admin/session', () => ({
  // The admin for the install route; the config route is called with ?public=1,
  // which never takes the admin branch.
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
  setPluginConfig: vi.fn(async () => {}),
  deletePluginConfigKey: vi.fn(async () => {}),
  sealPluginSecrets: vi.fn(async () => {}),
}));
vi.mock('@/lib/plugin-secrets/vault', () => ({ getUserCredential: vi.fn(async () => null) }));
// The config route: any signed-in mailbox user, no dev plugins.
vi.mock('@/lib/stalwart/credentials', () => ({
  getStalwartCredentials: vi.fn(async () => ({ accountName: 'alice@example.org', serverUrl: 'https://mail.example.org' })),
}));
vi.mock('@/lib/admin/plugin-dev', () => ({ getDevPlugin: vi.fn(async () => null) }));

import { POST } from '../route';
import { GET as readConfig } from '../../plugins/[id]/config/route';
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

/** What a plugin gets when it reads its settings (lib/plugin-sandbox/host-api.ts asks exactly this). */
async function pluginReadsItsSettings(id: string): Promise<Record<string, unknown>> {
  const res = await readConfig(
    new NextRequest(`http://localhost/api/admin/plugins/${id}/config?public=1`),
    { params: Promise.resolve({ id }) },
  );
  return res.json();
}

const BASE = { name: 'Pretty Dates', version: '1.0.0', author: 'x', description: 'd', type: 'hook', entrypoint: 'index.js' };
const INSTALLED = {
  id: 'pretty-dates', name: 'Pretty Dates', version: '0.9.0', enabled: true,
  permissions: ['email:read', 'http:fetch', 'http:post', 'http:proxy'],
};
const MANIFEST = { ...BASE, id: 'pretty-dates', permissions: INSTALLED.permissions };
const user = { username: 'alice@example.org', serverUrl: 'https://mail.example.org' };
const bearer = { type: 'bearer' };
const FAKE = 'fake-key-for-the-test';

async function update(installed: Record<string, unknown>, manifest: Record<string, unknown>, accept: Record<string, unknown> = {}) {
  registry.set('pretty-dates', { ...INSTALLED, ...installed });
  directory(await bundle({ ...MANIFEST, ...manifest }));
  const res = await install({ slug: 'pretty-dates', version: '1.0.0', type: 'plugin', ...accept });
  return { status: res.status, body: await res.json() };
}

beforeEach(() => { registry.clear(); savedConfig.clear(); });
afterEach(() => { vi.unstubAllGlobals(); });

describe('a stored secret whose field stops being a secret', () => {
  // The admin stored a key in a `secret` field. A version that declares the
  // same field as plain text is asked about before it is saved.
  const v1 = {
    configSchema: { apiKey: { type: 'secret', label: 'Key' } },
    credentials: { svc: { label: 'Service', scope: 'admin', inject: bearer, secretKey: 'apiKey', origin: 'https://api.dates.example' } },
  };

  it('control: with the installed version a plugin never gets the stored key', async () => {
    savedConfig.set('pretty-dates', { apiKey: FAKE });
    registry.set('pretty-dates', { ...INSTALLED, ...v1 });
    expect(await pluginReadsItsSettings('pretty-dates')).toEqual({});
  });

  it('an update that drops the credential and declares the field as plain text is asked about', async () => {
    savedConfig.set('pretty-dates', { apiKey: FAKE });
    const res = await update(v1, { configSchema: { apiKey: { type: 'string', label: 'Key' } } });
    const got = await pluginReadsItsSettings('pretty-dates');
    expect({ status: res.status, pluginReads: got.apiKey }).toEqual({ status: 409, pluginReads: undefined });
  });

  it('an update that keeps the credential on a new secret field and frees the old one says so', async () => {
    savedConfig.set('pretty-dates', { apiKey: FAKE });
    const v2 = {
      configSchema: { apiKey: { type: 'string', label: 'Key' }, token: { type: 'secret', label: 'Token' } },
      credentials: { svc: { ...v1.credentials.svc, secretKey: 'token' } },
    };
    // The credential line changes, so a question comes; accepting what it lists
    // (one line about the setting "token") is all it takes.
    const asked = await update(v1, v2);
    expect(asked.status).toBe(409);
    const accepted = await update(v1, v2, { acceptGrants: asked.body.grantsAdded });
    const got = await pluginReadsItsSettings('pretty-dates');
    // Either the question names the stored key becoming readable, or it does not become readable.
    const named = JSON.stringify(asked.body).includes('apiKey');
    expect({ accepted: accepted.status, questionNamesTheOldField: named || got.apiKey === undefined }).toEqual({ accepted: 200, questionNamesTheOldField: true });
  });

  it.each(['string', 'select', 'number', 'boolean'])('the same with the field declared as %s', async (type) => {
    savedConfig.set('pretty-dates', { apiKey: FAKE });
    const res = await update(v1, { configSchema: { apiKey: { type, label: 'Key', ...(type === 'select' ? { options: [{ label: 'a', value: 'a' }] } : {}) } } });
    const got = await pluginReadsItsSettings('pretty-dates');
    expect({ status: res.status, pluginReads: got.apiKey }).toEqual({ status: 409, pluginReads: undefined });
  });

  it('a secret field no credential used is released the same way', async () => {
    savedConfig.set('pretty-dates', { webhookSecret: FAKE });
    const res = await update(
      { configSchema: { webhookSecret: { type: 'secret', label: 'Secret' } } },
      { configSchema: { webhookSecret: { type: 'string', label: 'Secret' } } },
    );
    const got = await pluginReadsItsSettings('pretty-dates');
    expect({ status: res.status, pluginReads: got.webhookSecret }).toEqual({ status: 409, pluginReads: undefined });
  });
});

describe('the credential comparison next to it (controls)', () => {
  const one = {
    configSchema: { apiKey: { type: 'secret', label: 'Key' }, baseUrl: { type: 'string', label: 'Server' } },
    credentials: { svc: { label: 'Service', scope: 'admin', inject: bearer, secretKey: 'apiKey', origin: 'https://api.dates.example' } },
  };

  it('a credential renamed reads as a new one and is asked about', async () => {
    const res = await update(one, { ...one, credentials: { service: one.credentials.svc } });
    expect(res.status).toBe(409);
    expect(res.body.grantsAdded.credentials).toHaveLength(1);
  });

  it('two credentials that swap their names are asked about', async () => {
    const two = {
      configSchema: { k1: { type: 'secret', label: 'One' }, k2: { type: 'secret', label: 'Two' } },
      credentials: {
        a: { label: 'A', scope: 'admin', inject: bearer, secretKey: 'k1', origin: 'https://a.example' },
        b: { label: 'B', scope: 'admin', inject: bearer, secretKey: 'k2', origin: 'https://b.example' },
      },
    };
    const res = await update(two, { ...two, credentials: { a: two.credentials.b, b: two.credentials.a } });
    expect(res.status).toBe(409);
    expect(res.body.grantsAdded.credentials).toHaveLength(2);
  });

  it('the same lines with other httpOrigins: the key still goes to the credential\'s server only', async () => {
    savedConfig.set('pretty-dates', { apiKey: FAKE });
    const res = await update({ ...one, httpOrigins: ['https://api.dates.example'] }, { ...one, httpOrigins: ['https://api.dates.example', 'https://collector.example'] });
    expect(res.status).toBe(409);
    expect(res.body.grantsAdded.httpOrigins).toEqual(['https://collector.example']);
    expect(res.body.grantsAdded.credentials).toEqual([]);
    const accepted = await update({ ...one, httpOrigins: ['https://api.dates.example'] }, { ...one, httpOrigins: ['https://api.dates.example', 'https://collector.example'] }, { acceptGrants: res.body.grantsAdded });
    expect(accepted.status).toBe(200);
    expect((await resolveCredential(user, 'pretty-dates', 'svc'))!.origin).toBe('https://api.dates.example');
  });

  it.each([
    ['upper case', 'https://API.Dates.Example', 200],
    ['the default port', 'https://api.dates.example:443', 200],
    ['a trailing slash and a path', 'https://api.dates.example/v1/', 200],
    ['a trailing dot', 'https://api.dates.example.', 409],
    ['another port', 'https://api.dates.example:8443', 409],
    ['a look-alike host', 'https://api.dates.example.collector.example', 409],
  ])('the same server written with %s', async (_name, origin, status) => {
    const res = await update(one, { ...one, credentials: { svc: { ...one.credentials.svc, origin } } });
    expect(res.status).toBe(status);
  });

  it('a manifest that writes the credential twice is compared as it is saved (the last one)', async () => {
    registry.set('pretty-dates', { ...INSTALLED, ...one });
    const text = JSON.stringify({ ...MANIFEST, ...one }).replace(
      '"credentials":{"svc":{',
      '"credentials":{"svc":{"label":"Service","scope":"admin","inject":{"type":"bearer"},"secretKey":"apiKey","origin":"https://api.dates.example"},"svc":{',
    ).replace('"origin":"https://api.dates.example"}}', '"origin":"https://collector.example"}}');
    expect(text.match(/"svc"/g)).toHaveLength(2);
    directory(await bundleOf(text));
    const res = await install({ slug: 'pretty-dates', version: '1.0.0', type: 'plugin' });
    expect(res.status).toBe(409);
    expect((await res.json()).grantsAdded.credentialOrigins).toEqual(['https://collector.example']);
  });

  it('a credential that starts sending a secret (none to bearer) is asked about', async () => {
    const open = { ...one, credentials: { svc: { ...one.credentials.svc, inject: { type: 'none' } } } };
    const res = await update(open, one);
    expect(res.status).toBe(409);
    expect(res.body.grantsAdded.credentials).toHaveLength(1);
  });

  it('a credential that moves from the admin\'s key to each user\'s own account, or back, is asked about', async () => {
    const mine = { ...one, credentials: { svc: { label: 'Service', scope: 'user', inject: bearer, origin: 'https://api.dates.example' } } };
    expect((await update(one, mine)).status).toBe(409);
    expect((await update(mine, one)).status).toBe(409);
  });

  it('the default of the setting a credential reads its server from changes: asked, and the saved server stays', async () => {
    const v1 = {
      configSchema: { apiKey: { type: 'secret', label: 'Key' }, baseUrl: { type: 'string', label: 'Server', default: 'https://api.dates.example' } },
      credentials: { svc: { label: 'Service', scope: 'admin', inject: bearer, secretKey: 'apiKey', originKey: 'baseUrl' } },
    };
    savedConfig.set('pretty-dates', { apiKey: FAKE, baseUrl: 'https://api.dates.example' });
    const v2 = { ...v1, configSchema: { ...v1.configSchema, baseUrl: { type: 'string', label: 'Server', default: 'https://collector.example' } } };
    const res = await update(v1, v2);
    expect(res.status).toBe(409);
    expect(res.body.grantsAdded.credentialOrigins).toEqual(['https://collector.example']);
    expect((await resolveCredential(user, 'pretty-dates', 'svc'))!.origin).toBe('https://api.dates.example');
  });

  it('a setting with no saved value is not filled from the new default at request time', async () => {
    const v1 = {
      configSchema: { apiKey: { type: 'secret', label: 'Key' }, baseUrl: { type: 'string', label: 'Server' } },
      credentials: { svc: { label: 'Service', scope: 'admin', inject: bearer, secretKey: 'apiKey', originKey: 'baseUrl' } },
    };
    savedConfig.set('pretty-dates', { apiKey: FAKE });
    const v2 = { ...v1, configSchema: { ...v1.configSchema, baseUrl: { type: 'string', label: 'Server', default: 'https://collector.example' } } };
    const asked = await update(v1, v2);
    expect(asked.status).toBe(409);
    await update(v1, v2, { acceptGrants: asked.body.grantsAdded });
    expect(await resolveCredential(user, 'pretty-dates', 'svc')).toBeNull();
  });
});
