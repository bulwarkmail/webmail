/**
 * @vitest-environment node
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';

let signedIn = true;
let pluginsEnabled = true;
let sameOrigin = true;
// A token sign-in may claim a bare name; the context then also names the account it resolved to.
let claimed = { username: 'alice@example.org', accountName: 'alice@example.org' };
vi.mock('@/lib/stalwart/credentials', () => ({
  getStalwartCredentials: async () => (signedIn ? { ...claimed, serverUrl: 'https://mail.example.org', authHeader: 'x' } : null),
}));
vi.mock('@/lib/admin/config-manager', () => ({
  configManager: { ensureLoaded: async () => {}, getPolicy: () => ({ features: { pluginsEnabled } }) },
}));
vi.mock('@/lib/security/same-origin', async () => {
  const { NextResponse } = await import('next/server');
  return { rejectCrossOriginRequest: () => (sameOrigin ? null : NextResponse.json({}, { status: 403 })) };
});
const store = new Map<string, Record<string, unknown>>();
vi.mock('@/lib/plugin-secrets/vault', () => ({
  VaultFullError: class extends Error {},
  putUserCredential: vi.fn(async (_u: unknown, pluginId: string, credentialId: string, input: Record<string, unknown>) => {
    store.set(`${pluginId}/${credentialId}`, input);
  }),
  listUserCredentials: vi.fn(async () => []),
  deleteUserCredentials: vi.fn(async () => {}),
}));
// What the server knows the plugins declare (lib/plugin-secrets/known-plugins).
const declared: Record<string, { scope: 'user'; label: string; inject: { type: string }; origin?: string }> = {
  'nextcloud/cloud': { scope: 'user', label: 'Nextcloud', inject: { type: 'basic' } },
  'paperless/docs': { scope: 'user', label: 'Paperless', inject: { type: 'bearer' }, origin: 'https://paperless.example.com' },
};
vi.mock('@/lib/plugin-secrets/known-plugins', () => ({
  declaredUserCredential: async (pluginId: string, credentialId: string) => declared[`${pluginId}/${credentialId}`] ?? null,
}));
const proxied: unknown[] = [];
vi.mock('@/lib/plugin-secrets/proxy', async (orig) => {
  const real = await orig<typeof import('@/lib/plugin-secrets/proxy')>();
  return {
    ...real,
    proxyRequest: vi.fn(async (input: unknown) => { proxied.push(input); return new Response('ok'); }),
    adminCredentialStatus: vi.fn(async () => [{ credentialId: 'shared', configured: true }]),
    adminCredentialOrigins: vi.fn(async () => ['https://paperless.example.com']),
  };
});

import { GET as listCredentials, POST as saveCredential } from '../route';
import { POST as proxy } from '../../plugin-proxy/route';

const VALID = {
  pluginId: 'nextcloud', credentialId: 'cloud', label: 'Nextcloud',
  origin: 'https://cloud.example.org/index.php', inject: { type: 'basic' }, username: 'alice', secret: 'app-pw',
};

function save(body: unknown) {
  return saveCredential(new NextRequest('http://localhost/api/plugin-secrets', { method: 'POST', body: JSON.stringify(body) }));
}

function proxyCall(query: string, headers: Record<string, string> = {}) {
  return proxy(new NextRequest(`http://localhost/api/plugin-proxy?${query}`, { method: 'POST', headers }));
}

beforeEach(() => {
  signedIn = true;
  pluginsEnabled = true;
  sameOrigin = true;
  claimed = { username: 'alice@example.org', accountName: 'alice@example.org' };
  store.clear();
  proxied.length = 0;
});

describe('GET /api/plugin-secrets', () => {
  it("names the servers of set-up admin credentials for one plugin, for the host page's link check", async () => {
    const res = await listCredentials(new NextRequest('http://localhost/api/plugin-secrets?plugin=paperless'));
    expect(await res.json()).toMatchObject({ admin: [{ credentialId: 'shared', configured: true }], adminOrigins: ['https://paperless.example.com'] });
    const all = await listCredentials(new NextRequest('http://localhost/api/plugin-secrets'));
    expect((await all.json()).adminOrigins).toEqual([]);
  });
});

describe('POST /api/plugin-secrets', () => {
  it('stores a credential for the server origin only', async () => {
    const res = await save(VALID);

    expect(res.status).toBe(200);
    expect(store.get('nextcloud/cloud')).toMatchObject({ origin: 'https://cloud.example.org', secret: 'app-pw', username: 'alice' });
  });

  it.each([
    ['a plain http server', { origin: 'http://cloud.example.org' }],
    ['a header the proxy owns', { inject: { type: 'header', name: 'Cookie' } }],
    ['a secret with a line break', { secret: 'a\r\nX-Evil: 1' }],
    ['a bad plugin id', { pluginId: '../x' }],
  ])('refuses %s', async (_name, change) => {
    const res = await save({ ...VALID, ...change });

    expect(res.status).toBe(400);
    expect(store.size).toBe(0);
  });

  it('refuses a credential no known plugin declares, so the proxy is no relay for made-up plugin ids', async () => {
    expect((await save({ ...VALID, pluginId: 'made-up' })).status).toBe(404);
    expect((await save({ ...VALID, credentialId: 'other' })).status).toBe(404);
    expect(store.size).toBe(0);
  });

  it('keeps a credential on the server its plugin fixes and stores the inject the manifest declares', async () => {
    const paperless = { ...VALID, pluginId: 'paperless', credentialId: 'docs', inject: { type: 'basic' } };
    expect((await save({ ...paperless, origin: 'https://elsewhere.example.com' })).status).toBe(400);
    expect(store.size).toBe(0);
    expect((await save({ ...paperless, origin: 'https://paperless.example.com/api/' })).status).toBe(200);
    expect(store.get('paperless/docs')).toMatchObject({ origin: 'https://paperless.example.com', inject: { type: 'bearer' } });
  });

  it('refuses without a session, with plugins off, or from another site', async () => {
    signedIn = false;
    expect((await save(VALID)).status).toBe(401);
    signedIn = true;
    pluginsEnabled = false;
    expect((await save(VALID)).status).toBe(403);
    pluginsEnabled = true;
    sameOrigin = false;
    expect((await save(VALID)).status).toBe(403);
    expect(store.size).toBe(0);
  });

  it('keeps credentials under the account a bare-name token sign-in resolved to, not under the bare name', async () => {
    const { putUserCredential } = await import('@/lib/plugin-secrets/vault');
    claimed = { username: 'john', accountName: 'john@b.example' };

    expect((await save(VALID)).status).toBe(200);
    expect(vi.mocked(putUserCredential).mock.lastCall?.[0]).toEqual({ username: 'john@b.example', serverUrl: 'https://mail.example.org' });
  });
});

describe('POST /api/plugin-proxy', () => {
  it('passes the request on with the method and capture header', async () => {
    const res = await proxyCall('plugin=nextcloud&credential=cloud&url=https%3A%2F%2Fcloud.example.org%2Flogin%2Fv2%2Fpoll', {
      'x-bulwark-method': 'POST', 'x-bulwark-capture': '{"secret":"appPassword","username":"loginName"}',
    });

    expect(res.status).toBe(200);
    expect(proxied[0]).toMatchObject({
      pluginId: 'nextcloud', credentialId: 'cloud', method: 'POST',
      url: 'https://cloud.example.org/login/v2/poll',
      capture: { secret: 'appPassword', username: 'loginName' },
      user: { username: 'alice@example.org' },
    });
  });

  it('refuses without a session, from another site, or with a broken capture header', async () => {
    signedIn = false;
    expect((await proxyCall('plugin=nextcloud&credential=cloud&url=https%3A%2F%2Fa.example')).status).toBe(401);
    signedIn = true;
    sameOrigin = false;
    expect((await proxyCall('plugin=nextcloud&credential=cloud&url=https%3A%2F%2Fa.example')).status).toBe(403);
    sameOrigin = true;
    expect((await proxyCall('plugin=nextcloud&credential=cloud&url=https%3A%2F%2Fa.example', { 'x-bulwark-capture': '{"secret":"a.b"}' })).status).toBe(400);
    expect(proxied).toEqual([]);
  });

  it('uses the credentials of the account a bare-name token sign-in resolved to', async () => {
    claimed = { username: 'john', accountName: 'john@b.example' };

    await proxyCall('plugin=nextcloud&credential=cloud&url=https%3A%2F%2Fcloud.example.org%2Fx');
    expect(proxied[0]).toMatchObject({ user: { username: 'john@b.example' } });
  });
});
