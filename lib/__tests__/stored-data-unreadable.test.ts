// @vitest-environment node
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

// A settings file or plugin vault that exists but doesn't decrypt (written
// with another session secret) used to read as "nothing stored", and the
// next save wrote over it: the user's real data was gone for good. Now the
// save first moves it aside (`<file>.unreadable-<time>`, bytes unchanged)
// and goes on as if nothing was stored, so the user can save again and the
// old data can still be restored with the old secret.

let secret = 'a'.repeat(64);
vi.mock('@/lib/auth/session-secret', () => ({
  getSessionSecret: () => secret,
  hasSessionSecret: () => true,
}));
vi.mock('@/lib/logger', () => ({
  logger: { warn: () => {}, error: () => {}, info: () => {}, debug: () => {} },
}));
vi.mock('@/lib/admin/config-manager', () => ({
  configManager: {
    ensureLoaded: async () => {},
    get: (key: string, fallback: unknown) => (key === 'settingsSyncEnabled' ? true : fallback),
    getPolicy: () => ({ restrictions: {}, features: { pluginsEnabled: true } }),
  },
}));
vi.mock('@/lib/admin/third-party-mode', () => ({ isNoThirdPartyTrafficOn: async () => false, thirdPartyRefusal: () => null }));
// One installed plugin with a credential the admin set up.
vi.mock('@/lib/admin/plugin-registry', () => ({
  getPlugin: async (id: string) => (id === 'paperless'
    ? { id, enabled: true, credentials: { shared: { scope: 'admin', label: 'Paperless', inject: { type: 'bearer' }, origin: 'https://paperless.example.com', secretKey: 'token' } } }
    : null),
}));
vi.mock('@/lib/admin/plugin-config', () => ({ getPluginConfig: async () => ({ token: 'admin-token' }) }));

const jar = new Map<string, string>();
vi.mock('next/headers', () => ({
  cookies: async () => ({
    get: (name: string) => (jar.has(name) ? { name, value: jar.get(name)! } : undefined),
    set: (name: string, value: string) => { jar.set(name, value); },
    delete: (name: string) => { jar.delete(name); },
    getAll: () => [...jar].map(([name, value]) => ({ name, value })),
  }),
}));

const SERVER = 'https://mail.example.org';
const USER = 'alice@example.org';
vi.mock('@/lib/stalwart/credentials', () => ({
  getStalwartCredentials: async () => ({ username: USER, accountName: USER, serverUrl: SERVER, authHeader: 'x' }),
}));
vi.mock('@/lib/plugin-secrets/known-plugins', () => ({
  declaredUserCredential: async () => ({ scope: 'user', label: 'Nextcloud', inject: { type: 'basic' } }),
}));

let dataDir: string;

beforeEach(async () => {
  dataDir = mkdtempSync(path.join(tmpdir(), 'bw-unreadable-'));
  vi.stubEnv('SETTINGS_DATA_DIR', path.join(dataDir, 'settings'));
  vi.stubEnv('PLUGIN_SECRETS_DIR', path.join(dataDir, 'plugin-secrets'));
  vi.stubEnv('SETTINGS_SYNC_ENABLED', 'true');
  secret = 'a'.repeat(64);
  jar.clear();
});

afterEach(() => {
  vi.unstubAllEnvs();
  rmSync(dataDir, { recursive: true, force: true });
});

/** Sign in after the secret change: the context cookie is sealed with the current secret. */
async function signIn() {
  const { setStalwartAuthContextInStore } = await import('@/lib/stalwart/auth-context');
  setStalwartAuthContextInStore({
    get: (n: string) => (jar.has(n) ? { name: n, value: jar.get(n)! } : undefined),
    set: (n: string, v: string) => { jar.set(n, v); },
    delete: (n: string) => { jar.delete(n); },
  } as never, 0, { serverUrl: SERVER, authHeader: 'Bearer t', username: USER });
}

function files(dir: string): string[] {
  return readdirSync(dir).sort();
}

function onlyFile(dir: string): string {
  const [file] = files(dir).filter((name) => name.endsWith('.enc'));
  return path.join(dir, file);
}

function asideOf(dir: string, file: string): string | undefined {
  const name = files(dir).find((n) => n.startsWith(`${path.basename(file)}.unreadable-`));
  return name && path.join(dir, name);
}

describe('settings that do not decrypt', () => {
  it('read as nothing stored, and a file too short to hold any as well', async () => {
    const { loadUserSettings, saveUserSettings } = await import('@/lib/settings-sync');
    expect(await loadUserSettings(USER, SERVER)).toBeNull();

    await saveUserSettings(USER, SERVER, { theme: 'dark' });
    secret = 'b'.repeat(64);
    expect(await loadUserSettings(USER, SERVER)).toBeNull();

    writeFileSync(onlyFile(path.join(dataDir, 'settings')), Buffer.alloc(10));
    expect(await loadUserSettings(USER, SERVER)).toBeNull();
  });

  it('are moved aside unchanged by the next save, which then goes through', async () => {
    const { saveUserSettings, loadUserSettings } = await import('@/lib/settings-sync');
    await saveUserSettings(USER, SERVER, { theme: 'dark', templates: [{ id: 'a' }] });
    const dir = path.join(dataDir, 'settings');
    const file = onlyFile(dir);
    const before = readFileSync(file);
    secret = 'b'.repeat(64);
    await signIn();

    const { GET, POST } = await import('@/app/api/settings/route');
    const got = await GET(new NextRequest('https://webmail.example/api/settings', {
      headers: { 'x-settings-username': USER, 'x-settings-server': SERVER },
    }));
    expect(got.status).toBe(200);
    expect((await got.json()).settings).toBeNull();

    const saved = await POST(new NextRequest('https://webmail.example/api/settings', {
      method: 'POST',
      headers: { 'sec-fetch-site': 'same-origin', 'content-type': 'application/json' },
      body: JSON.stringify({ username: USER, serverUrl: SERVER, settings: { theme: 'light' } }),
    }));
    expect(saved.status).toBe(200);
    expect(await loadUserSettings(USER, SERVER)).toEqual({ theme: 'light' });

    const aside = asideOf(dir, file);
    expect(aside).toBeDefined();
    expect(readFileSync(aside!).equals(before)).toBe(true);
    // With the old secret back, the moved file still holds the old settings.
    secret = 'a'.repeat(64);
    writeFileSync(file, readFileSync(aside!));
    expect(await loadUserSettings(USER, SERVER)).toEqual({ theme: 'dark', templates: [{ id: 'a' }] });
  });

  it('a file too short to hold any is written over, not moved', async () => {
    const { updateUserSettings, loadUserSettings, settingsId } = await import('@/lib/settings-sync');
    const dir = path.join(dataDir, 'settings');
    mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(dir, `${settingsId(USER, SERVER)}.enc`), Buffer.alloc(0));
    await updateUserSettings(USER, SERVER, (stored) => ({ ...(stored ?? {}), theme: 'dark' }));
    expect(files(dir)).toEqual([`${settingsId(USER, SERVER)}.enc`]);
    expect(await loadUserSettings(USER, SERVER)).toEqual({ theme: 'dark' });
  });
});

describe('a plugin vault that does not decrypt', () => {
  const user = { username: USER, serverUrl: SERVER };
  const input = { origin: 'https://cloud.example.org', inject: { type: 'basic' } as const, label: 'Nextcloud', secret: 'pw' };

  it('reads as empty, and the next write moves it aside unchanged and goes through', async () => {
    const { listUserCredentials, putUserCredential } = await import('@/lib/plugin-secrets/vault');
    expect(await listUserCredentials(user)).toEqual([]);
    await putUserCredential(user, 'nextcloud', 'cloud', input);
    const dir = path.join(dataDir, 'plugin-secrets');
    const file = onlyFile(dir);
    const before = readFileSync(file);
    secret = 'b'.repeat(64);

    expect(await listUserCredentials(user)).toEqual([]);
    await putUserCredential(user, 'other', 'x', input);
    expect((await listUserCredentials(user)).map((c) => c.pluginId)).toEqual(['other']);
    const aside = asideOf(dir, file);
    expect(aside).toBeDefined();
    expect(readFileSync(aside!).equals(before)).toBe(true);
  });

  it('lets the routes work again: list, connect, disconnect, and the proxy finds no credential', async () => {
    const { putUserCredential } = await import('@/lib/plugin-secrets/vault');
    await putUserCredential(user, 'nextcloud', 'cloud', input);
    secret = 'b'.repeat(64);

    const { GET, POST, DELETE } = await import('@/app/api/plugin-secrets/route');
    const { POST: proxy } = await import('@/app/api/plugin-proxy/route');
    const same = { 'sec-fetch-site': 'same-origin' };

    const listed = await GET(new NextRequest('http://localhost/api/plugin-secrets?plugin=paperless'));
    expect(listed.status).toBe(200);
    expect(await listed.json()).toMatchObject({ credentials: [], admin: [{ credentialId: 'shared', configured: true }] });
    const proxied = await proxy(new NextRequest(
      'http://localhost/api/plugin-proxy?plugin=nextcloud&credential=cloud&url=https%3A%2F%2Fcloud.example.org%2F',
      { method: 'POST', headers: same },
    ));
    expect(proxied.status).toBe(404);
    const post = await POST(new NextRequest('http://localhost/api/plugin-secrets', {
      method: 'POST',
      headers: same,
      body: JSON.stringify({ pluginId: 'nextcloud', credentialId: 'cloud', label: 'x', origin: 'https://cloud.example.org', inject: { type: 'basic' }, secret: 's' }),
    }));
    expect(post.status).toBe(200);
    const del = await DELETE(new NextRequest('http://localhost/api/plugin-secrets?plugin=nextcloud', { method: 'DELETE', headers: same }));
    expect(del.status).toBe(200);
  });

  it('resolves an admin credential without reading the user vault', async () => {
    const { resolveCredential } = await import('@/lib/plugin-secrets/proxy');
    // A vault that can't even be read (a folder where the file should be).
    const { userKey } = await import('@/lib/plugin-secrets/vault');
    mkdirSync(path.join(dataDir, 'plugin-secrets', `${userKey(user)}.enc`), { recursive: true });

    expect(await resolveCredential(user, 'paperless', 'shared')).toMatchObject({ scope: 'admin', secret: 'admin-token' });
    await expect(resolveCredential(user, 'nextcloud', 'cloud')).rejects.toThrow();
  });
});
