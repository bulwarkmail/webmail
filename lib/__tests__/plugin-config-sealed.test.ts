/**
 * @vitest-environment node
 *
 * A value an admin stored in a `secret` field of a plugin's settings stays a
 * secret whatever a later version of the plugin declares for that key.
 *
 * The plugin config store is the real one, on a scratch folder: the mark
 * that says "stored as a secret" lives there, with the value. The registry is
 * a map the cases set directly, so most of them swap the installed version
 * with no install route and no question in between: the store has to hold on
 * its own. The last describes go through the update, rollback and upload
 * routes, for values stored before marks existed and for what the question
 * says.
 */
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { NextRequest } from 'next/server';
import JSZip from 'jszip';

// The scratch folder has to be in place before the routes are imported.
const dir = await vi.hoisted(async () => {
  const { mkdtempSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const made = mkdtempSync(join(tmpdir(), 'bw-sealed-config-'));
  process.env.ADMIN_CONFIG_DIR = made;
  process.env.NEXT_PUBLIC_APP_VERSION = '1.21.1';
  return made;
});

let admin = true;
vi.mock('@/lib/admin/session', async () => {
  const { NextResponse } = await import('next/server');
  return {
    requireAdminAuth: vi.fn(async () => (admin ? { session: { sub: 'admin' } } : { error: NextResponse.json({}, { status: 401 }) })),
    getClientIP: () => '127.0.0.1',
  };
});
const audit = vi.fn(async (..._args: unknown[]) => {});
vi.mock('@/lib/admin/audit', () => ({ auditLog: (...args: unknown[]) => audit(...args) }));
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
vi.mock('@/lib/desktop/server-policy', () => ({ devicePolicyPluginRefusal: () => null }));
// A plugin loaded from PLUGIN_DEV_DIR, when a case sets one.
let devPlugin: { plugin: Record<string, unknown> } | null = null;
vi.mock('@/lib/admin/plugin-dev', () => ({ getDevPlugin: vi.fn(async () => devPlugin), listDevPlugins: vi.fn(async () => []) }));
vi.mock('@/lib/admin/plugin-approvals', () => ({ listApprovals: vi.fn(async () => []) }));
vi.mock('@/lib/stalwart/credentials', () => ({
  getStalwartCredentials: vi.fn(async () => ({ accountName: 'alice@example.org', serverUrl: 'https://mail.example.org' })),
}));

// What a user connected themselves, per credential id.
const vault = new Map<string, Record<string, unknown>>();
vi.mock('@/lib/plugin-secrets/vault', () => ({
  getUserCredential: vi.fn(async (_user: unknown, _plugin: string, credentialId: string) => vault.get(credentialId) ?? null),
  setUserCredentialSecret: vi.fn(async () => {}),
  userKey: () => 'k',
}));

let kept: Record<string, unknown> = {};
vi.mock('@/lib/admin/extension-history', () => ({
  HistoryError: class HistoryError extends Error { status = 404; },
  readHistoryEntry: vi.fn(async () => ({ kind: 'plugin', entry: { ...kept }, code: 'module.exports = {};' })),
  listHistory: vi.fn(async () => []),
  keptVersions: () => ({}),
}));

import { GET as readConfig, PUT as writeConfig, DELETE as removeConfig } from '@/app/api/admin/plugins/[id]/config/route';
import { POST as marketplaceInstall } from '@/app/api/admin/marketplace/route';
import { POST as rollbackRoute } from '@/app/api/admin/extensions/[kind]/[id]/rollback/route';
import { POST as uploadRoute } from '@/app/api/admin/plugins/route';
import { resolveCredential, adminEnteredOrigins } from '@/lib/plugin-secrets/proxy';
import { deletePluginConfig, getPluginConfig, sealPluginSecrets, setPluginConfig } from '@/lib/admin/plugin-config';
import { isSealed } from '@/lib/plugin-secrets/sealed';
import { describeReachAdded, grantsAdded, grantsOf } from '@/lib/admin/extension-grants';

const ID = 'pretty-dates';
const FAKE = 'fake-key-for-the-test';
const user = { username: 'alice@example.org', serverUrl: 'https://mail.example.org' };
const bearer = { type: 'bearer' };
const BASE = {
  id: ID, name: 'Pretty Dates', author: 'x', description: 'd', type: 'hook', entrypoint: 'index.js',
  enabled: true, installedAt: '2026-10-01T00:00:00.000Z', updatedAt: '2026-10-01T00:00:00.000Z',
  permissions: ['email:read', 'http:proxy'],
};
const secretField = { type: 'secret', label: 'Key' };
const plainField = { type: 'string', label: 'Key' };
const svc = { label: 'Service', scope: 'admin', inject: bearer, secretKey: 'apiKey', origin: 'https://api.dates.example' };
/** 1.0.0: the key is a secret, sent only through a credential. */
const V1 = { ...BASE, version: '1.0.0', configSchema: { apiKey: secretField }, credentials: { svc } };

const params = { params: Promise.resolve({ id: ID }) };
const json = (method: string, body: unknown) => new NextRequest(`http://localhost/api/admin/plugins/${ID}/config`, {
  method, body: JSON.stringify(body), headers: { 'content-type': 'application/json' },
});
/** The admin types a value into the settings page and saves. */
async function adminEnters(key: string, value: unknown): Promise<number> {
  return (await writeConfig(json('PUT', { key, value }), params)).status;
}
/** What the plugin, and any signed-in user, gets. */
async function pluginReads(): Promise<Record<string, unknown>> {
  return (await readConfig(new NextRequest(`http://localhost/api/admin/plugins/${ID}/config?public=1`), params)).json();
}
/** What the admin's settings page gets. */
async function adminReads(): Promise<Record<string, unknown>> {
  return (await readConfig(new NextRequest(`http://localhost/api/admin/plugins/${ID}/config`), params)).json();
}
const storedFile = () => path.join(dir, 'plugin-config', `${ID}.json`);
const onDisk = (): Record<string, unknown> => JSON.parse(readFileSync(storedFile(), 'utf-8'));
/** A config file as a webmail before the marks wrote it. */
function storedBeforeMarks(config: Record<string, unknown>): void {
  mkdirSync(path.dirname(storedFile()), { recursive: true });
  writeFileSync(storedFile(), JSON.stringify(config, null, 2));
}
const installed = (entry: Record<string, unknown>) => { registry.set(ID, entry); };

beforeEach(async () => {
  admin = true;
  registry.clear();
  vault.clear();
  audit.mockClear();
  kept = {};
  devPlugin = null;
  await deletePluginConfig(ID);
});
afterEach(() => { vi.unstubAllGlobals(); });
afterAll(() => { rmSync(dir, { recursive: true, force: true }); });

describe('a value stored as a secret, when the installed version declares its key differently (no route, no question)', () => {
  beforeEach(async () => {
    installed(V1);
    expect(await adminEnters('apiKey', FAKE)).toBe(200);
  });

  it('control: under the version it was entered for, the proxy sends it and nobody reads it', async () => {
    expect(await pluginReads()).toEqual({});
    expect(await resolveCredential(user, ID, 'svc')).toMatchObject({ secret: FAKE, origin: 'https://api.dates.example' });
    // The admin's own page still gets it while the field is a secret.
    expect(await adminReads()).toEqual({ apiKey: FAKE });
  });

  it.each([
    ['string', { type: 'string', label: 'Key' }],
    ['select', { type: 'select', label: 'Key', options: [{ label: 'a', value: 'a' }] }],
    ['number', { type: 'number', label: 'Key' }],
    ['boolean', { type: 'boolean', label: 'Key' }],
  ])('declared as %s: reads as unset for the plugin, for users and on the admin page', async (_kind, field) => {
    installed({ ...BASE, version: '1.1.0', configSchema: { apiKey: field } });
    expect(await pluginReads()).toEqual({});
    expect(await adminReads()).toEqual({});
    admin = false;
    expect(await (await readConfig(new NextRequest(`http://localhost/api/admin/plugins/${ID}/config`), params)).json()).toEqual({});
  });

  it('is kept, sealed: the kind changes and changes back, and the proxy sends it again', async () => {
    installed({ ...BASE, version: '1.1.0', configSchema: { apiKey: plainField } });
    expect(await pluginReads()).toEqual({});
    expect(onDisk().apiKey).toBe(FAKE);

    installed({ ...V1, version: '1.2.0' });
    expect(await pluginReads()).toEqual({});
    expect(await resolveCredential(user, ID, 'svc')).toMatchObject({ secret: FAKE });
  });

  it('a version that drops the key and a later one that brings it back as plain text', async () => {
    installed({ ...BASE, version: '1.1.0' });
    expect(await pluginReads()).toEqual({});
    expect(await adminReads()).toEqual({});
    installed({ ...BASE, version: '1.2.0', configSchema: { apiKey: plainField } });
    expect(await pluginReads()).toEqual({});
  });

  it('the secret moves to a new key and a plain setting takes the old key\'s name', async () => {
    installed({
      ...BASE, version: '1.1.0',
      configSchema: { apiKey: plainField, token: { type: 'secret', label: 'Token' } },
      credentials: { svc: { ...svc, secretKey: 'token' } },
    });
    expect(await pluginReads()).toEqual({});
    // The old value is not taken for the new field either.
    expect(await resolveCredential(user, ID, 'svc')).toBeNull();
  });

  it('is not sent along as a user name or read as a server address once its field is plain', async () => {
    installed({
      ...BASE, version: '1.1.0',
      configSchema: { apiKey: plainField, token: { type: 'secret', label: 'Token' }, server: { type: 'string', label: 'Server' } },
      credentials: { svc: { label: 'Service', scope: 'admin', inject: { type: 'basic' }, secretKey: 'token', usernameKey: 'apiKey', originKey: 'server' } },
    });
    expect(await adminEnters('server', 'https://api.dates.example')).toBe(200);
    expect(await adminEnters('token', 'another-fake-token')).toBe(200);
    const resolved = await resolveCredential(user, ID, 'svc');
    expect(resolved).toMatchObject({ secret: 'another-fake-token', origin: 'https://api.dates.example' });
    expect(resolved!.username).toBeUndefined();
    expect(await adminEnteredOrigins(ID)).toEqual(['https://api.dates.example']);

    // The same key as the setting the server is read from.
    installed({
      ...BASE, version: '1.2.0',
      configSchema: { apiKey: plainField, token: { type: 'secret', label: 'Token' } },
      credentials: { svc: { label: 'Service', scope: 'admin', inject: bearer, secretKey: 'token', originKey: 'apiKey' } },
    });
    expect(await resolveCredential(user, ID, 'svc')).toBeNull();
    expect(await adminEnteredOrigins(ID)).toEqual([]);
  });

  it('a new value entered under the plain declaration replaces it and is an ordinary setting', async () => {
    installed({ ...BASE, version: '1.1.0', configSchema: { apiKey: plainField } });
    expect(await adminEnters('apiKey', 'a public site key')).toBe(200);
    expect(await pluginReads()).toEqual({ apiKey: 'a public site key' });
    expect(JSON.stringify(onDisk())).not.toContain(FAKE);
    // An empty list: every value in the file is known to be plain.
    expect(onDisk()).toEqual({ apiKey: 'a public site key', $secret: [] });
  });

  it('removing the setting removes its mark, and the file with the last key', async () => {
    expect(onDisk()).toEqual({ apiKey: FAKE, $secret: ['apiKey'] });
    expect((await removeConfig(json('DELETE', { key: 'apiKey' }), params)).status).toBe(200);
    expect(existsSync(storedFile())).toBe(false);
  });

  it('does not serialise: a reader that passes the settings on hands out nothing', async () => {
    const config = await getPluginConfig(ID);
    expect(isSealed(config.apiKey)).toBe(true);
    expect(JSON.stringify(config)).toBe('{}');
    expect(`${String(config.apiKey)}${JSON.stringify({ ...config })}`).not.toContain(FAKE);
    expect(typeof config.apiKey).not.toBe('string');
  });

  it('the list of secret keys is no setting: nobody reads it and it cannot be written', async () => {
    installed({ ...V1, configSchema: undefined });
    expect(await adminReads()).toEqual({});
    expect(await adminEnters('$secret', [])).toBe(400);
    await expect(setPluginConfig(ID, '$secret', [])).rejects.toThrow();
    expect(onDisk().$secret).toEqual(['apiKey']);
  });
});

describe('a value stored as plain text whose field becomes a secret', () => {
  const V0 = { ...BASE, version: '0.9.0', configSchema: { apiKey: plainField } };

  it('stops being returned once the field is a secret, and stays sealed when the next version makes it plain again', async () => {
    installed(V0);
    await adminEnters('apiKey', FAKE);
    expect(await pluginReads()).toEqual({ apiKey: FAKE });

    installed(V1);
    expect(await pluginReads()).toEqual({});
    // The honest reason for the change: the plugin now sends it through a credential.
    expect(await resolveCredential(user, ID, 'svc')).toMatchObject({ secret: FAKE });

    // The next version is saved through a route (here an upload, which asks nothing).
    expect((await upload({ ...manifestOf(V0), version: '1.1.0' })).status).toBe(200);
    expect(registry.get(ID)!.configSchema).toEqual({ apiKey: plainField });
    expect(await pluginReads()).toEqual({});
    expect(onDisk()).toEqual({ apiKey: FAKE, $secret: ['apiKey'] });
  });
});

describe('a user\'s own account next to an admin\'s key', () => {
  const mine = { label: 'Service', scope: 'user', inject: bearer, origin: 'https://api.dates.example' };

  it('a version that moves the credential to each user\'s account and declares the admin\'s key as plain text', async () => {
    installed(V1);
    await adminEnters('apiKey', FAKE);
    vault.set('svc', { origin: 'https://api.dates.example', inject: bearer, label: 'Service', secret: 'the-users-own-fake', createdAt: '', updatedAt: '' });

    installed({ ...BASE, version: '1.1.0', configSchema: { apiKey: plainField }, credentials: { svc: mine } });
    expect(await pluginReads()).toEqual({});
    // The proxy uses what the user connected, never the admin's key.
    expect(await resolveCredential(user, ID, 'svc')).toMatchObject({ scope: 'user', secret: 'the-users-own-fake' });
  });

  it('what a user connected is in no settings answer, whatever the version declares under the credential\'s name', async () => {
    vault.set('svc', { origin: 'https://api.dates.example', inject: bearer, label: 'Service', secret: 'the-users-own-fake', createdAt: '', updatedAt: '' });
    installed({ ...BASE, version: '1.1.0', configSchema: { svc: { type: 'string', label: 'Service' } }, credentials: { svc: mine } });
    expect(await pluginReads()).toEqual({});
    expect(await adminReads()).toEqual({});
  });
});

// ── Through the routes ───────────────────────────────────────

function manifestOf(entry: Record<string, unknown>): Record<string, unknown> {
  const { enabled: _e, installedAt: _i, updatedAt: _u, ...manifest } = entry;
  return manifest;
}
async function zipOf(manifest: Record<string, unknown>): Promise<Uint8Array> {
  const zip = new JSZip();
  zip.file('manifest.json', JSON.stringify(manifest));
  zip.file('index.js', 'module.exports = {};');
  return zip.generateAsync({ type: 'uint8array' });
}
/** An admin uploads a ZIP over the installed plugin. */
async function upload(manifest: Record<string, unknown>) {
  const form = new FormData();
  form.append('file', new File([(await zipOf(manifest)) as BlobPart], 'p.zip', { type: 'application/zip' }));
  return uploadRoute(new NextRequest('http://localhost/api/admin/plugins', { method: 'POST', body: form }));
}
/** A marketplace update to `manifest`, the directory answering with its bundle. */
async function update(manifest: Record<string, unknown>, accept: Record<string, unknown> = {}) {
  const buf = await zipOf(manifest);
  const bytes = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer;
  const sha256 = createHash('sha256').update(new Uint8Array(bytes)).digest('hex');
  const version = manifest.version as string;
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    const u = String(url);
    if (u.includes('/api/v2/extensions/') && u.includes('/versions/') && !u.endsWith('/bundle')) {
      return Response.json({ data: { version, channel: 'stable', publishedAt: null, minAppVersion: null, maxAppVersion: null, permissions: [], size: 0, sha256, yanked: null, downloadUrl: '' } });
    }
    return new Response(bytes);
  }));
  const res = await marketplaceInstall(new NextRequest('http://localhost/api/admin/marketplace', {
    method: 'POST', body: JSON.stringify({ slug: ID, version, type: 'plugin', ...accept }), headers: { 'content-type': 'application/json' },
  }));
  return { status: res.status, body: await res.json() };
}
async function rollback(body: Record<string, unknown>) {
  const res = await rollbackRoute(
    new NextRequest(`http://localhost/api/admin/extensions/plugin/${ID}/rollback`, { method: 'POST', body: JSON.stringify(body), headers: { 'content-type': 'application/json' } }),
    { params: Promise.resolve({ kind: 'plugin', id: ID }) },
  );
  return { status: res.status, body: await res.json() };
}

const V2_PLAIN = { ...BASE, version: '1.1.0', configSchema: { apiKey: plainField } };

describe('a key stored before marks existed, when another version is saved', () => {
  beforeEach(() => {
    installed(V1);
    storedBeforeMarks({ apiKey: FAKE });
  });

  it('an update: asked about, and the stored key stays sealed after everything was accepted', async () => {
    const asked = await update(manifestOf(V2_PLAIN));
    expect(asked.status).toBe(409);
    expect(asked.body.grantsAdded.formerSecrets).toEqual(['apiKey']);
    expect(asked.body.error).toContain('Stops keeping the setting "apiKey" secret');
    expect(registry.get(ID)!.version).toBe('1.0.0');

    const accepted = await update(manifestOf(V2_PLAIN), { acceptGrants: asked.body.grantsAdded });
    expect(accepted.status).toBe(200);
    expect(registry.get(ID)!.configSchema).toEqual({ apiKey: plainField });
    expect(await pluginReads()).toEqual({});
    expect(await adminReads()).toEqual({});
    expect(onDisk()).toEqual({ apiKey: FAKE, $secret: ['apiKey'] });
    // What was accepted is in the audit entry, by setting name; the value is not.
    const entry = audit.mock.calls.find((call) => call[0] === 'marketplace.update_plugin')!;
    expect((entry[1] as { accepted: unknown }).accepted).toEqual({ formerSecrets: ['apiKey'] });
    expect(JSON.stringify(audit.mock.calls)).not.toContain(FAKE);
  });

  it('a rollback to a version that declared the key as plain text: the same', async () => {
    kept = { ...V2_PLAIN, version: '0.9.0' };
    const asked = await rollback({ version: '0.9.0' });
    expect(asked.status).toBe(409);
    expect(asked.body.grantsAdded.formerSecrets).toEqual(['apiKey']);

    expect((await rollback({ version: '0.9.0', acceptGrants: asked.body.grantsAdded })).status).toBe(200);
    expect(registry.get(ID)!.version).toBe('0.9.0');
    expect(await pluginReads()).toEqual({});
    expect(onDisk().$secret).toEqual(['apiKey']);
  });

  it('an uploaded ZIP, which asks nothing: the stored key stays sealed', async () => {
    expect((await upload(manifestOf(V2_PLAIN))).status).toBe(200);
    expect(registry.get(ID)!.configSchema).toEqual({ apiKey: plainField });
    expect(await pluginReads()).toEqual({});
  });

  it('writes nothing when no secret is stored, or all of them are marked already', async () => {
    await deletePluginConfig(ID);
    await sealPluginSecrets(ID, V1);
    expect(existsSync(storedFile())).toBe(false);

    await adminEnters('apiKey', FAKE);
    const before = readFileSync(storedFile(), 'utf-8');
    await sealPluginSecrets(ID, V1);
    expect(readFileSync(storedFile(), 'utf-8')).toBe(before);
  });
});

describe('the question about a setting that stops being a secret', () => {
  beforeEach(async () => {
    installed(V1);
    await adminEnters('apiKey', FAKE);
  });

  it('is its own entry: accepting the rest of the question does not accept it', async () => {
    const v2 = {
      ...manifestOf(V2_PLAIN),
      configSchema: { apiKey: plainField, token: { type: 'secret', label: 'Token' } },
      credentials: { svc: { ...svc, secretKey: 'token' } },
    };
    const asked = await update(v2);
    expect(asked.status).toBe(409);
    expect(asked.body.grantsAdded.credentials).toHaveLength(1);
    expect(asked.body.grantsAdded.formerSecrets).toEqual(['apiKey']);

    const partly = await update(v2, { acceptGrants: { ...asked.body.grantsAdded, formerSecrets: [] } });
    expect(partly.status).toBe(409);
    expect(registry.get(ID)!.version).toBe('1.0.0');
  });

  it('an answer naming a setting the question did not list is refused', async () => {
    const asked = await update(manifestOf(V2_PLAIN));
    const res = await update(manifestOf(V2_PLAIN), { acceptGrants: { formerSecrets: ['apiKey', 'otherKey'] } });
    expect(res.status).toBe(409);
    expect(res.body.unexpected.formerSecrets).toEqual(['otherKey']);
    expect(asked.body.grantsAdded.formerSecrets).toEqual(['apiKey']);
  });

  it('across two updates: away from a secret is asked about, back to one is not, and the key is the proxy\'s again', async () => {
    const asked = await update(manifestOf(V2_PLAIN));
    expect((await update(manifestOf(V2_PLAIN), { acceptGrants: asked.body.grantsAdded })).status).toBe(200);
    expect(await pluginReads()).toEqual({});

    // 1.2.0 declares it a secret again; the credential comes back and is asked about as such.
    const back = await update(manifestOf({ ...V1, version: '1.2.0' }));
    expect(back.status).toBe(409);
    expect(back.body.grantsAdded.formerSecrets).toEqual([]);
    expect((await update(manifestOf({ ...V1, version: '1.2.0' }), { acceptGrants: back.body.grantsAdded })).status).toBe(200);
    expect(await pluginReads()).toEqual({});
    expect(await resolveCredential(user, ID, 'svc')).toMatchObject({ secret: FAKE });
  });

  it('asks nothing when a plain setting becomes a secret, a secret is dropped, or a new plain setting is added', async () => {
    const plainNow = { ...BASE, version: '1.0.0', configSchema: { note: { type: 'string', label: 'Note' }, apiKey: secretField } };
    installed(plainNow);
    const res = await update({
      ...manifestOf(plainNow), version: '1.1.0',
      configSchema: { note: { type: 'secret', label: 'Note' }, greeting: { type: 'string', label: 'Greeting' } },
    });
    expect(res.status).toBe(200);
  });
});

describe('a file from before the list of secrets: plain is only what is known to be plain', () => {
  const MIXED = {
    ...BASE, version: '1.0.0',
    configSchema: { apiKey: secretField, greeting: { type: 'string', label: 'Greeting' }, retries: { type: 'number', label: 'Retries' } },
    credentials: { svc },
  };

  it('the first read sorts it by the installed version and writes the list', async () => {
    installed(MIXED);
    storedBeforeMarks({ apiKey: FAKE, greeting: 'hello', retries: 3, leftover: 'from-a-setting-an-update-dropped' });
    expect(await pluginReads()).toEqual({ greeting: 'hello', retries: 3 });
    expect(onDisk()).toEqual({ apiKey: FAKE, greeting: 'hello', retries: 3, leftover: 'from-a-setting-an-update-dropped', $secret: ['apiKey', 'leftover'] });
    // The admin's page gets the secret of a field that is one, and nothing for the key no field declares.
    expect(await adminReads()).toEqual({ apiKey: FAKE, greeting: 'hello', retries: 3 });
    expect(await resolveCredential(user, ID, 'svc')).toMatchObject({ secret: FAKE });
  });

  it('a key the installed version does not declare: an update that declares it as plain text is asked about, and it stays sealed', async () => {
    installed({ ...BASE, version: '1.1.0', configSchema: { greeting: { type: 'string', label: 'Greeting' } } });
    storedBeforeMarks({ apiKey: FAKE, greeting: 'hello' });

    const v2 = { ...manifestOf(BASE), version: '1.2.0', configSchema: { greeting: { type: 'string', label: 'Greeting' }, apiKey: plainField } };
    const asked = await update(v2);
    expect(asked.status).toBe(409);
    expect(asked.body.grantsAdded.formerSecrets).toEqual(['apiKey']);
    expect(asked.body.error).toContain('Stops keeping the setting "apiKey" secret');
    expect((await update(v2, { acceptGrants: asked.body.grantsAdded })).status).toBe(200);
    expect(await pluginReads()).toEqual({ greeting: 'hello' });
    expect(await adminReads()).toEqual({ greeting: 'hello' });

    // The next update keeps the key plain: nothing changes for it, so nothing is asked.
    expect((await update({ ...v2, version: '1.3.0' })).status).toBe(200);
    expect(await pluginReads()).toEqual({ greeting: 'hello' });

    // A new value entered now is an ordinary setting.
    expect(await adminEnters('apiKey', 'a public site key')).toBe(200);
    expect(await pluginReads()).toEqual({ greeting: 'hello', apiKey: 'a public site key' });
  });

  it('the same key through a rollback to a version that declared it as plain text', async () => {
    installed({ ...BASE, version: '1.1.0' });
    storedBeforeMarks({ apiKey: FAKE });
    kept = { ...BASE, version: '0.9.0', configSchema: { apiKey: plainField } };
    const asked = await rollback({ version: '0.9.0' });
    expect(asked.status).toBe(409);
    expect(asked.body.grantsAdded.formerSecrets).toEqual(['apiKey']);
    expect((await rollback({ version: '0.9.0', acceptGrants: asked.body.grantsAdded })).status).toBe(200);
    expect(await pluginReads()).toEqual({});
  });

  it('nothing installed: a first install starts clean, also one that declares the old key a secret again', async () => {
    storedBeforeMarks({ apiKey: FAKE, greeting: 'hello' });
    // Another package under the id, with a credential of its own for the key.
    const other = { ...manifestOf(V1), version: '3.0.0', credentials: { svc: { ...svc, origin: 'https://collector.example' } } };
    const asked = await update(other);
    expect(asked.status).toBe(409);
    // Not installed yet: what was left is still there, and nobody can read it (nothing is installed).
    expect(onDisk()).toEqual({ apiKey: FAKE, greeting: 'hello' });
    expect((await readConfig(new NextRequest(`http://localhost/api/admin/plugins/${ID}/config?public=1`), params)).status).toBe(404);

    expect((await update(other, { acceptGrants: asked.body.grantsAdded })).status).toBe(200);
    expect(existsSync(storedFile())).toBe(false);
    // The old key is not sent to the new package's server.
    expect(await resolveCredential(user, ID, 'svc')).toBeNull();
    expect(await adminReads()).toEqual({});
  });

  it('a value entered under a key no field declares is a secret from the start', async () => {
    installed({ ...BASE, version: '1.0.0' });
    expect(await adminEnters('scratch', FAKE)).toBe(200);
    expect(onDisk()).toEqual({ scratch: FAKE, $secret: ['scratch'] });
    expect(await adminReads()).toEqual({});
    installed({ ...BASE, version: '1.1.0', configSchema: { scratch: { type: 'string', label: 'Scratch' } } });
    expect(await pluginReads()).toEqual({});
  });

  it('a change to one setting sorts the rest of an old file first', async () => {
    installed(MIXED);
    storedBeforeMarks({ apiKey: FAKE, greeting: 'hello' });
    expect(await adminEnters('retries', 5)).toBe(200);
    expect(onDisk()).toEqual({ apiKey: FAKE, greeting: 'hello', retries: 5, $secret: ['apiKey'] });
    expect((await removeConfig(json('DELETE', { key: 'greeting' }), params)).status).toBe(200);
    expect(onDisk()).toEqual({ apiKey: FAKE, retries: 5, $secret: ['apiKey'] });
  });

  it('a plugin from the dev folder is sorted by its own manifest', async () => {
    devPlugin = { plugin: { ...MIXED } };
    storedBeforeMarks({ apiKey: FAKE, greeting: 'hello' });
    expect(await pluginReads()).toEqual({ greeting: 'hello' });
    expect(onDisk().$secret).toEqual(['apiKey']);
  });

  it('a file that cannot be read stops the save instead of being taken for empty', async () => {
    installed(V1);
    // A folder where the file should be: reading it fails.
    mkdirSync(storedFile(), { recursive: true });
    try {
      expect((await upload(manifestOf(V2_PLAIN))).status).toBe(500);
      expect(registry.get(ID)!.version).toBe('1.0.0');
    } finally {
      rmSync(storedFile(), { recursive: true, force: true });
    }
  });
});

describe('the comparison itself', () => {
  const schema = (apiKey: string) => ({ configSchema: { apiKey: { type: apiKey, label: 'Key' } } });

  it('counts a setting that leaves `secret`, in either order of the two versions, and nothing else', () => {
    expect(grantsAdded(grantsOf(schema('secret')), grantsOf(schema('string'))).formerSecrets).toEqual(['apiKey']);
    expect(grantsAdded(grantsOf(schema('string')), grantsOf(schema('secret'))).formerSecrets).toEqual([]);
    expect(grantsAdded(grantsOf(schema('secret')), grantsOf(schema('secret'))).formerSecrets).toEqual([]);
    expect(grantsAdded(grantsOf(schema('secret')), grantsOf({})).formerSecrets).toEqual([]);
    expect(grantsAdded(grantsOf({}), grantsOf(schema('string'))).formerSecrets).toEqual([]);
    // A key from the prototype is no declared setting.
    expect(grantsAdded(grantsOf(schema('secret')), grantsOf({ configSchema: { constructor: { type: 'string', label: 'c' } } })).formerSecrets).toEqual([]);
  });

  it('says what happens to the stored value and to what is entered next', () => {
    const [one] = describeReachAdded(grantsAdded(grantsOf(schema('secret')), grantsOf(schema('string'))));
    expect(one).toBe('Stops keeping the setting "apiKey" secret: what an admin enters there from now on can be read by the plugin and by every signed-in user. The value stored so far stays sealed, and the setting reads as empty until a new one is entered.');
    const two = grantsAdded(
      grantsOf({ configSchema: { a: secretField, b: secretField } }),
      grantsOf({ configSchema: { a: plainField, b: plainField } }),
    );
    expect(describeReachAdded(two)[0]).toContain('Stops keeping the settings "a", "b" secret');
  });
});

