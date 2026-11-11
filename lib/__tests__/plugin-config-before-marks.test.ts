/**
 * @vitest-environment node
 *
 * A key an admin stored in a `secret` field before the config store kept a
 * list of its secrets (`$secret`) is in a file without that list. This file
 * follows a key stored that way through every order in which a later version
 * can declare its setting as plain text: the installed version declares it
 * `secret`, the installed version dropped the setting, nothing is installed
 * under the id any more, and a version change that goes around the install
 * routes. Same setup as plugin-config-sealed.test.ts: the real store on a
 * scratch folder, the registry a map.
 */
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { NextRequest } from 'next/server';
import JSZip from 'jszip';

const dir = await vi.hoisted(async () => {
  const { mkdtempSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const made = mkdtempSync(join(tmpdir(), 'bw-secret-before-marks-'));
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
vi.mock('@/lib/admin/plugin-dev', () => ({ getDevPlugin: vi.fn(async () => null), listDevPlugins: vi.fn(async () => []) }));
vi.mock('@/lib/admin/plugin-approvals', () => ({ listApprovals: vi.fn(async () => []) }));
vi.mock('@/lib/stalwart/credentials', () => ({
  getStalwartCredentials: vi.fn(async () => ({ accountName: 'alice@example.org', serverUrl: 'https://mail.example.org' })),
}));
vi.mock('@/lib/plugin-secrets/vault', () => ({
  getUserCredential: vi.fn(async () => null),
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

import { GET as readConfig } from '@/app/api/admin/plugins/[id]/config/route';
import { POST as marketplaceInstall } from '@/app/api/admin/marketplace/route';
import { POST as rollbackRoute } from '@/app/api/admin/extensions/[kind]/[id]/rollback/route';
import { POST as uploadRoute } from '@/app/api/admin/plugins/route';
import { resolveCredential } from '@/lib/plugin-secrets/proxy';
import { deletePluginConfig } from '@/lib/admin/plugin-config';

const ID = 'pretty-dates';
const FAKE = 'fake-key-stored-before-the-upgrade';
const user = { username: 'alice@example.org', serverUrl: 'https://mail.example.org' };
const BASE = {
  id: ID, name: 'Pretty Dates', author: 'x', description: 'd', type: 'hook', entrypoint: 'index.js',
  enabled: true, installedAt: '2026-09-01T00:00:00.000Z', updatedAt: '2026-09-01T00:00:00.000Z',
  permissions: ['email:read', 'http:proxy'],
};
const secretField = { type: 'secret', label: 'Key' };
const plainField = { type: 'string', label: 'Key' };
const svc = { label: 'Service', scope: 'admin', inject: { type: 'bearer' }, secretKey: 'apiKey', origin: 'https://api.dates.example' };
/** 1.0.0: the key is a secret, sent only through a credential. */
const V1 = { ...BASE, version: '1.0.0', configSchema: { apiKey: secretField }, credentials: { svc } };
/** A later version that declares the same key as plain text and has no credential. */
const PLAIN = { ...BASE, version: '1.2.0', configSchema: { apiKey: plainField } };

const params = { params: Promise.resolve({ id: ID }) };
const config = (query = '') => new NextRequest(`http://localhost/api/admin/plugins/${ID}/config${query}`);
/** What the plugin gets (`api.admin.getConfig`), and so any signed-in user. */
const pluginReads = async (): Promise<Record<string, unknown>> => (await readConfig(config('?public=1'), params)).json();
/** A mailbox user with no admin session calling the route without the flag. */
async function userReads(): Promise<Record<string, unknown>> {
  admin = false;
  try { return await (await readConfig(config(), params)).json(); } finally { admin = true; }
}
const adminReads = async (): Promise<Record<string, unknown>> => (await readConfig(config(), params)).json();

const storedFile = () => path.join(dir, 'plugin-config', `${ID}.json`);
/** A config file as a webmail before the marks wrote it: the settings and nothing else. */
function storedBeforeMarks(settings: Record<string, unknown>): void {
  mkdirSync(path.dirname(storedFile()), { recursive: true });
  writeFileSync(storedFile(), JSON.stringify(settings, null, 2));
}
const onDisk = (): Record<string, unknown> => JSON.parse(readFileSync(storedFile(), 'utf-8'));

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
async function upload(manifest: Record<string, unknown>) {
  const form = new FormData();
  form.append('file', new File([(await zipOf(manifest)) as BlobPart], 'p.zip', { type: 'application/zip' }));
  return uploadRoute(new NextRequest('http://localhost/api/admin/plugins', { method: 'POST', body: form }));
}
/** A marketplace install or update of `manifest`, the directory answering with its bundle. */
async function install(manifest: Record<string, unknown>, accept: Record<string, unknown> = {}) {
  const buf = await zipOf(manifest);
  const bytes = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer;
  const sha256 = createHash('sha256').update(new Uint8Array(bytes)).digest('hex');
  const version = manifest.version as string;
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    const u = String(url);
    if (u.includes('/api/v2/extensions/') && u.includes('/versions/') && !u.endsWith('/bundle')) {
      return Response.json({ data: { version, channel: 'stable', publishedAt: null, minAppVersion: null, maxAppVersion: null, permissions: manifest.permissions ?? [], size: 0, sha256, yanked: null, downloadUrl: '' } });
    }
    return new Response(bytes);
  }));
  const res = await marketplaceInstall(new NextRequest('http://localhost/api/admin/marketplace', {
    method: 'POST', body: JSON.stringify({ slug: ID, version, type: 'plugin', ...accept }), headers: { 'content-type': 'application/json' },
  }));
  return { status: res.status, body: await res.json() };
}
/** The admin says yes to whatever the install asks: the first answer's lists, sent back as they came. */
async function installAcceptingEverything(manifest: Record<string, unknown>) {
  const first = await install(manifest);
  if (first.status !== 409) return { asked: null as Record<string, unknown> | null, ...first };
  const second = await install(manifest, { acceptPermissions: first.body.permissionsAdded, acceptGrants: first.body.grantsAdded });
  return { asked: first.body as Record<string, unknown>, ...second };
}
async function rollback(body: Record<string, unknown>) {
  const res = await rollbackRoute(
    new NextRequest(`http://localhost/api/admin/extensions/plugin/${ID}/rollback`, { method: 'POST', body: JSON.stringify(body), headers: { 'content-type': 'application/json' } }),
    { params: Promise.resolve({ kind: 'plugin', id: ID }) },
  );
  return { status: res.status, body: await res.json() };
}

/** Everyone who is not the credential's server. */
async function nobodyReadsTheKey(): Promise<void> {
  expect({ plugin: await pluginReads(), user: await userReads(), adminPage: await adminReads() })
    .toEqual({ plugin: {}, user: {}, adminPage: {} });
}

beforeEach(async () => {
  admin = true;
  registry.clear();
  audit.mockClear();
  kept = {};
  await deletePluginConfig(ID);
});
afterEach(() => { vi.unstubAllGlobals(); });
afterAll(() => { rmSync(dir, { recursive: true, force: true }); });

describe('a key stored before the upgrade, the installed version declares it `secret`', () => {
  beforeEach(() => {
    registry.set(ID, V1);
    storedBeforeMarks({ apiKey: FAKE });
  });

  it('control: the upgraded webmail still sends it through the proxy and hands it to nobody', async () => {
    expect(await pluginReads()).toEqual({});
    expect(await userReads()).toEqual({});
    expect(await resolveCredential(user, ID, 'svc')).toMatchObject({ secret: FAKE });
  });

  it('a marketplace update that declares it plain, the question accepted', async () => {
    const res = await installAcceptingEverything(manifestOf(PLAIN));
    expect(res.asked?.grantsAdded).toMatchObject({ formerSecrets: ['apiKey'] });
    expect(res.status).toBe(200);
    expect(registry.get(ID)!.version).toBe('1.2.0');
    await nobodyReadsTheKey();
    expect(onDisk()).toEqual({ apiKey: FAKE, $secret: ['apiKey'] });
  });

  it('an uploaded ZIP that declares it plain (no question)', async () => {
    expect((await upload(manifestOf(PLAIN))).status).toBe(200);
    expect(registry.get(ID)!.version).toBe('1.2.0');
    await nobodyReadsTheKey();
  });

  it('a rollback to a kept version that declared it plain, the question accepted', async () => {
    kept = { ...PLAIN, version: '0.9.0' };
    const asked = await rollback({ version: '0.9.0' });
    expect(asked.status).toBe(409);
    expect((await rollback({ version: '0.9.0', acceptGrants: asked.body.grantsAdded })).status).toBe(200);
    await nobodyReadsTheKey();
  });
});

describe('a key stored before the upgrade, in the other orders', () => {
  it('control: a setting that always was plain text is still read by the plugin', async () => {
    registry.set(ID, { ...BASE, version: '1.0.0', configSchema: { greeting: { type: 'string', label: 'Greeting' } } });
    storedBeforeMarks({ greeting: 'hello' });
    expect(await pluginReads()).toEqual({ greeting: 'hello' });
  });

  it('the installed version dropped the setting before the upgrade; an update brings the key back as plain text', async () => {
    // 1.0.0 declared apiKey `secret` and the admin stored a key. 1.1.0 (installed with the old
    // webmail) dropped the setting; the value stayed in the file, as it does today.
    registry.set(ID, { ...BASE, version: '1.1.0' });
    storedBeforeMarks({ apiKey: FAKE });
    expect(await pluginReads()).toEqual({});

    const res = await installAcceptingEverything(manifestOf(PLAIN));
    expect(res.status).toBe(200);
    // Nothing was asked about the setting, so the stored key must not be readable.
    expect({ asked: res.asked, plugin: await pluginReads(), user: await userReads() })
      .toEqual({ asked: res.asked, plugin: {}, user: {} });
  });

  it('the same through an uploaded ZIP', async () => {
    registry.set(ID, { ...BASE, version: '1.1.0' });
    storedBeforeMarks({ apiKey: FAKE });
    expect((await upload(manifestOf(PLAIN))).status).toBe(200);
    expect({ plugin: await pluginReads(), user: await userReads() }).toEqual({ plugin: {}, user: {} });
  });

  it('the plugin was removed and its settings stayed; a first install declares the key as plain text', async () => {
    // No registry entry. Webmails before 1.15.0 kept the config file of a removed plugin,
    // and a clean-up that fails after the registry entry is gone leaves it too.
    storedBeforeMarks({ apiKey: FAKE });

    const res = await installAcceptingEverything(manifestOf({ ...PLAIN, version: '2.0.0' }));
    expect(res.status).toBe(200);
    expect(registry.get(ID)!.version).toBe('2.0.0');
    expect(JSON.stringify(res.asked ?? {})).not.toContain('apiKey');
    expect({ plugin: await pluginReads(), user: await userReads() }).toEqual({ plugin: {}, user: {} });
  });

  it('the same through an uploaded ZIP', async () => {
    storedBeforeMarks({ apiKey: FAKE });
    expect((await upload(manifestOf({ ...PLAIN, version: '2.0.0' }))).status).toBe(200);
    expect({ plugin: await pluginReads(), user: await userReads() }).toEqual({ plugin: {}, user: {} });
  });

  it('the version changes without a route (what holds if an install route is ever missed)', async () => {
    registry.set(ID, V1);
    storedBeforeMarks({ apiKey: FAKE });
    // The upgraded webmail reads the settings while 1.0.0 is installed, as it does for
    // every page that loads the plugin. That read sorts the file. A file nobody has read
    // yet says nothing about its keys, and neither does a registry entry that is gone.
    expect(await pluginReads()).toEqual({});
    expect(onDisk()).toEqual({ apiKey: FAKE, $secret: ['apiKey'] });
    registry.set(ID, PLAIN);
    expect({ plugin: await pluginReads(), user: await userReads() }).toEqual({ plugin: {}, user: {} });
  });

  it('control: the same file under a version that always declared the key as plain text stays readable', async () => {
    registry.set(ID, PLAIN);
    storedBeforeMarks({ apiKey: 'a-site-key-that-was-never-a-secret' });
    expect(await pluginReads()).toEqual({ apiKey: 'a-site-key-that-was-never-a-secret' });
  });
});
