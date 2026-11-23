/**
 * @vitest-environment node
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

// The proxy injected whatever credential the vault held for the (plugin,
// credential) pair in the query string, and the connect route stored one for
// any plugin id of the right shape. Neither asked whether a plugin the server
// knows declares that credential, so a signed-in user could relay requests
// through the server to any origin, and a plugin could reach for another's
// secret by id. Now a user credential exists only for a plugin the server
// can name: an installed one, or an admin-approved upload.

const registry = new Map<string, { enabled: boolean; credentials?: Record<string, unknown> }>();
const approvals: { pluginId: string; status: string; manifest: { credentials?: Record<string, unknown> } }[] = [];
vi.mock('@/lib/admin/plugin-registry', () => ({ getPlugin: async (id: string) => registry.get(id) ?? null }));
vi.mock('@/lib/admin/plugin-approvals', () => ({ listApprovals: async () => approvals }));
vi.mock('@/lib/admin/plugin-config', () => ({ getPluginConfig: async () => ({}) }));
vi.mock('@/lib/logger', () => ({ logger: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} } }));

const vault = new Map<string, { origin: string; inject: { type: string }; secret?: string }>();
vi.mock('@/lib/plugin-secrets/vault', () => ({
  getUserCredential: async (_u: unknown, p: string, c: string) => vault.get(`${p}/${c}`) ?? null,
  setUserCredentialSecret: async () => {},
  userKey: () => 'user',
}));

import { declaredUserCredential, declaringPlugins } from '@/lib/plugin-secrets/known-plugins';
import { resolveCredential } from '@/lib/plugin-secrets/proxy';

const USER = { username: 'alice@example.org', serverUrl: 'https://mail.example.org' };
const CLOUD = { scope: 'user', label: 'Nextcloud', inject: { type: 'basic' } };

beforeEach(() => {
  registry.clear();
  approvals.length = 0;
  vault.clear();
});

describe('declaredUserCredential', () => {
  it('finds the credential of an installed, enabled plugin', async () => {
    registry.set('nextcloud', { enabled: true, credentials: { cloud: CLOUD } });
    expect(await declaredUserCredential('nextcloud', 'cloud')).toEqual(CLOUD);
    expect(await declaredUserCredential('nextcloud', 'other')).toBeNull();
    registry.set('nextcloud', { enabled: false, credentials: { cloud: CLOUD } });
    expect(await declaredUserCredential('nextcloud', 'cloud')).toBeNull();
  });

  it('finds the credential of an approved upload, not of a pending or denied one', async () => {
    approvals.push({ pluginId: 'upload', status: 'pending', manifest: { credentials: { cloud: CLOUD } } });
    expect(await declaredUserCredential('upload', 'cloud')).toBeNull();
    approvals.push({ pluginId: 'upload', status: 'approved', manifest: { credentials: { cloud: CLOUD } } });
    expect(await declaredUserCredential('upload', 'cloud')).toEqual(CLOUD);
  });

  it('names every approved version of an upload, the first one first', async () => {
    const newer = { ...CLOUD, label: 'Nextcloud 2' };
    approvals.push({ pluginId: 'upload', status: 'approved', manifest: { credentials: { cloud: CLOUD } } });
    approvals.push({ pluginId: 'upload', status: 'denied', manifest: { credentials: { cloud: CLOUD } } });
    approvals.push({ pluginId: 'upload', status: 'approved', manifest: { credentials: { cloud: newer } } });
    expect((await declaringPlugins('upload', 'cloud')).map((plugin) => plugin.spec)).toEqual([CLOUD, newer]);
    expect(await declaredUserCredential('upload', 'cloud')).toEqual(CLOUD);
  });

  it('knows nothing about a made-up plugin or an admin-scope credential', async () => {
    expect(await declaredUserCredential('x-y', 'c')).toBeNull();
    registry.set('ai', { enabled: true, credentials: { key: { scope: 'admin', label: 'Key', inject: { type: 'bearer' }, secretKey: 'apiKey' } } });
    expect(await declaredUserCredential('ai', 'key')).toBeNull();
  });
});

describe('resolveCredential for a stored user credential', () => {
  it('refuses one stored under a plugin the server does not know', async () => {
    vault.set('x-y/c', { origin: 'https://any.example', inject: { type: 'none' } });
    expect(await resolveCredential(USER, 'x-y', 'c')).toBeNull();
  });

  it('serves one a known plugin declares, on the origin the manifest fixes', async () => {
    registry.set('nextcloud', { enabled: true, credentials: { cloud: CLOUD } });
    vault.set('nextcloud/cloud', { origin: 'https://cloud.example.org', inject: { type: 'basic' }, secret: 's' });
    expect(await resolveCredential(USER, 'nextcloud', 'cloud')).toMatchObject({ origin: 'https://cloud.example.org', scope: 'user' });

    registry.set('paperless', { enabled: true, credentials: { docs: { ...CLOUD, origin: 'https://paperless.example.com' } } });
    vault.set('paperless/docs', { origin: 'https://elsewhere.example.com', inject: { type: 'basic' }, secret: 's' });
    expect(await resolveCredential(USER, 'paperless', 'docs')).toBeNull();
    vault.set('paperless/docs', { origin: 'https://paperless.example.com', inject: { type: 'basic' }, secret: 's' });
    expect(await resolveCredential(USER, 'paperless', 'docs')).toMatchObject({ origin: 'https://paperless.example.com' });
  });
});
