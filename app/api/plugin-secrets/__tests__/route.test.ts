/**
 * @vitest-environment node
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';

let signedIn = true;
let pluginsEnabled = true;
let stalwartFeatures = true;
let impersonating = false;
let sameOrigin = true;
// A token sign-in may claim a bare name; the context then also names the account it resolved to.
let claimed = { username: 'alice@example.org', accountName: 'alice@example.org' };
vi.mock('@/lib/stalwart/credentials', () => ({
  getStalwartCredentials: async () => (signedIn
    ? { ...claimed, serverUrl: 'https://mail.example.org', authHeader: 'Bearer session', slot: 0, trusted: true, hasSessionCookie: true }
    : null),
}));
vi.mock('@/lib/admin/config-manager', () => ({
  configManager: {
    ensureLoaded: async () => {},
    getPolicy: () => ({ features: { pluginsEnabled } }),
    get: (key: string, fallback: unknown) => (key === 'stalwartFeaturesEnabled' ? stalwartFeatures : fallback),
  },
}));
vi.mock('next/headers', () => ({ cookies: async () => ({ get: () => ({ value: 'sealed' }) }) }));
vi.mock('@/lib/impersonation/grant-cookie', () => ({
  IMPERSONATION_GRANT_COOKIE: 'jmap_impersonation',
  openImpersonationGrant: () => (impersonating ? { serverUrl: 'https://mail.example.org', mailbox: 'alice', credentialId: 'imp' } : null),
}));
// The app passwords the server made on the mail server, by id.
const made = new Map<string, string>();
let refuseAppPassword: string | null = null;
vi.mock('@/lib/plugin-secrets/app-password', () => ({
  makePluginAppPassword: vi.fn(async (_session: unknown, description: string) => {
    if (refuseAppPassword) throw new Error(refuseAppPassword);
    const id = `ap${made.size + 1}`;
    made.set(id, description);
    return { id, secret: `secret-of-${id}`, username: 'alice@login.example.org' };
  }),
  revokePluginAppPassword: vi.fn(async (_session: unknown, id: string) => { made.delete(id); }),
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
  getUserCredential: vi.fn(async (_u: unknown, pluginId: string, credentialId: string) => store.get(`${pluginId}/${credentialId}`) ?? null),
  listUserCredentials: vi.fn(async () => []),
  deleteUserCredentials: vi.fn(async (_u: unknown, pluginId: string) => {
    const removed = [...store].filter(([key]) => key.startsWith(`${pluginId}/`));
    for (const [key] of removed) store.delete(key);
    return removed.map(([, value]) => value);
  }),
}));
// What the server knows the plugins declare (lib/plugin-secrets/known-plugins).
const declared: Record<string, { scope: 'user'; label: string; inject: { type: string }; origin?: string; appPassword?: true }> = {
  'nextcloud/cloud': { scope: 'user', label: 'Nextcloud', inject: { type: 'basic' } },
  'paperless/docs': { scope: 'user', label: 'Paperless', inject: { type: 'bearer' }, origin: 'https://paperless.example.com' },
  'team-calendar/stalwart': { scope: 'user', label: 'Stalwart', inject: { type: 'basic' }, appPassword: true },
  'elsewhere/stalwart': { scope: 'user', label: 'Stalwart', inject: { type: 'basic' }, appPassword: true, origin: 'https://other.example.org' },
};
vi.mock('@/lib/plugin-secrets/known-plugins', () => ({
  declaringPlugin: async (pluginId: string, credentialId: string) => {
    const spec = declared[`${pluginId}/${credentialId}`];
    return spec ? { name: pluginId === 'team-calendar' ? 'Teamkalender' : pluginId, spec } : null;
  },
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

import { DELETE as disconnect, GET as listCredentials, POST as saveCredential } from '../route';
import { putUserCredential, VaultFullError } from '@/lib/plugin-secrets/vault';
import { revokePluginAppPassword } from '@/lib/plugin-secrets/app-password';
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

const TEAM = { pluginId: 'team-calendar', credentialId: 'stalwart', label: 'Stalwart', appPassword: true };

beforeEach(() => {
  signedIn = true;
  pluginsEnabled = true;
  stalwartFeatures = true;
  impersonating = false;
  sameOrigin = true;
  claimed = { username: 'alice@example.org', accountName: 'alice@example.org' };
  refuseAppPassword = null;
  store.clear();
  made.clear();
  vi.mocked(revokePluginAppPassword).mockClear();
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

describe('POST /api/plugin-secrets with appPassword', () => {
  it('makes an app password on the signed-in server, named for the plugin, and keeps it from the browser', async () => {
    const res = await save(TEAM);

    expect(res.status).toBe(200);
    expect(JSON.stringify(await res.json())).not.toContain('secret-of');
    expect([...made]).toEqual([['ap1', 'Plugin: Teamkalender']]);
    expect(store.get('team-calendar/stalwart')).toEqual({
      origin: 'https://mail.example.org', inject: { type: 'basic' }, label: 'Stalwart',
      username: 'alice@login.example.org', secret: 'secret-of-ap1', appPasswordId: 'ap1',
    });
  });

  it('replaces the app password made before when connecting again', async () => {
    await save(TEAM);
    await save(TEAM);

    expect([...made.keys()]).toEqual(['ap2']);
    expect(store.get('team-calendar/stalwart')).toMatchObject({ appPasswordId: 'ap2' });
  });

  it.each([
    ['a typed password for it', { ...VALID, pluginId: 'team-calendar', credentialId: 'stalwart', origin: 'https://mail.example.org' }],
    ['it for a credential that takes a typed password', { ...TEAM, pluginId: 'nextcloud', credentialId: 'cloud' }],
    ['anything sent along', { ...TEAM, secret: 'mine' }],
    ['another server than the one the plugin names', { ...TEAM, pluginId: 'elsewhere' }],
  ])('refuses %s', async (_name, body) => {
    expect((await save(body)).status).toBe(400);
    expect(made.size).toBe(0);
    expect(store.size).toBe(0);
  });

  it('refuses without Stalwart features and in a support session', async () => {
    stalwartFeatures = false;
    expect((await save(TEAM)).status).toBe(403);
    stalwartFeatures = true;
    impersonating = true;
    expect((await save(TEAM)).status).toBe(403);
    expect(made.size).toBe(0);
    expect(store.size).toBe(0);
  });

  it("says why when the mail server makes none, and stores nothing", async () => {
    refuseAppPassword = 'forbidden';
    const res = await save(TEAM);

    expect(res.status).toBe(502);
    expect((await res.json()).error).toMatch(/forbidden/);
    expect(store.size).toBe(0);
  });

  it('deletes the app password again when it cannot be stored', async () => {
    vi.mocked(putUserCredential).mockRejectedValueOnce(new VaultFullError());

    expect((await save(TEAM)).status).toBe(409);
    expect(made.size).toBe(0);
  });
});

describe('DELETE /api/plugin-secrets', () => {
  function remove(query: string) {
    return disconnect(new NextRequest(`http://localhost/api/plugin-secrets?${query}`, { method: 'DELETE' }));
  }

  it('deletes the app password the server made, and only that', async () => {
    await save(TEAM);
    await save({ ...VALID, origin: 'https://mail.example.org' });

    expect((await remove('plugin=team-calendar&credential=stalwart')).status).toBe(200);
    expect(made.size).toBe(0);
    expect((await remove('plugin=nextcloud')).status).toBe(200);
    expect(store.size).toBe(0);
    expect(revokePluginAppPassword).toHaveBeenCalledTimes(1);
  });

  it('leaves the mail server alone without Stalwart features', async () => {
    await save(TEAM);
    stalwartFeatures = false;

    expect((await remove('plugin=team-calendar')).status).toBe(200);
    expect(made.size).toBe(1);
    expect(store.size).toBe(0);
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
