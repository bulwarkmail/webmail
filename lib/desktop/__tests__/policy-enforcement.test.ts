/**
 * @vitest-environment node
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import type { ServerPolicy } from '../policy-schema';

/**
 * PluginsMode in the install path, on the server. The five ways a plugin gets
 * installed or switched on, the serving points, and what tightening leaves alone.
 * Every route is the real one; only storage and the session are stand-ins.
 */

vi.mock('@/lib/admin/session', () => ({
  requireAdminAuth: async () => ({ payload: { role: 'admin' } }),
  getClientIP: () => '127.0.0.1',
}));
vi.mock('@/lib/admin/audit', () => ({ auditLog: async () => {} }));
vi.mock('@/lib/auth/instance-details', () => ({ canSeeInstanceDetails: async () => true }));
vi.mock('@/lib/admin/third-party-mode', () => ({ isNoThirdPartyTrafficOn: async () => false }));
vi.mock('@/lib/admin/config-manager', () => ({
  configManager: {
    ensureLoaded: async () => {},
    get: () => undefined,
    getPolicy: () => ({ forceEnabledPlugins: [], features: {} }),
  },
}));

const registry = vi.hoisted(() => ({
  plugins: [] as Record<string, unknown>[],
  saved: [] as string[],
  decided: [] as string[],
  updated: [] as unknown[],
}));

vi.mock('@/lib/admin/plugin-registry', () => ({
  getPlugin: async (id: string) => registry.plugins.find((p) => p.id === id) ?? null,
  getTheme: async () => null,
  getPluginRegistry: async () => ({ plugins: registry.plugins }),
  getThemeRegistry: async () => ({ themes: [] }),
  savePlugin: vi.fn(async (plugin: { id: string }) => { registry.saved.push(plugin.id); }),
  saveTheme: vi.fn(),
  deletePlugin: vi.fn(),
  updatePluginMeta: vi.fn(async (id: string, updates: unknown) => { registry.updated.push([id, updates]); return { id, ...(updates as object) }; }),
  getPluginBundle: async () => 'code',
  isBundleMismatch: () => false,
  getPluginSignature: async () => null,
  readHistoryEntry: async () => ({ entry: { id: 'x', version: '0.9.0' }, code: 'old' }),
  themeCSSResolver: async () => () => null,
}));
vi.mock('@/lib/admin/plugin-dev', () => ({
  listDevPlugins: async () => [],
  getDevPlugin: async () => null,
  readDevBundle: async () => '',
}));
vi.mock('@/lib/admin/plugin-signing', () => ({ signBytes: async () => 'sig' }));
vi.mock('@/lib/admin/plugin-approvals', async (original) => ({
  ...(await original<object>()),
  decideApproval: vi.fn(async (pluginId: string) => { registry.decided.push(pluginId); return { pluginId, bundleHash: 'a'.repeat(64), status: 'approved' }; }),
}));
vi.mock('@/lib/admin/csp-frame-origins', async (original) => {
  const real = await original<object>();
  return { ...real, invalidateFrameOriginsCache: () => {} };
});

// Every address counts as public here, so only the policy can be what refuses one.
vi.mock('@/lib/security/url-guard', async (original) => ({
  ...(await original<object>()),
  isPublicHttpUrl: async () => true,
}));

const POLICY_KEY = Symbol.for('bulwark.desktop.serverPolicy');

function setPolicy(policy: Partial<ServerPolicy> | undefined) {
  (globalThis as unknown as Record<symbol, unknown>)[POLICY_KEY] = policy && { pluginAllowlist: [], allowedJmapServers: null, ...policy };
}

function jsonRequest(url: string, method: string, body: unknown) {
  return new NextRequest(`http://localhost${url}`, {
    method,
    body: JSON.stringify(body),
    headers: { 'content-type': 'application/json', 'sec-fetch-site': 'same-origin' },
  });
}

beforeEach(() => {
  vi.stubEnv('NEXT_PUBLIC_BULWARK_DESKTOP', '1');
  vi.resetModules();
  registry.plugins = [{ id: 'kept', name: 'Kept', version: '1.0.0', enabled: true, frameOrigins: ['https://kept.example'] }, { id: 'other', name: 'Other', version: '1.0.0', enabled: true, frameOrigins: ['https://other.example'] }];
  registry.saved = [];
  registry.decided = [];
  registry.updated = [];
  // A route that gets past the gate tries the directory. It must not reach a network.
  vi.stubGlobal('fetch', vi.fn(async () => new Response('nope', { status: 502 })));
});

afterEach(() => {
  setPolicy(undefined);
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe.each(['off', 'allowlist'] as const)('with PluginsMode %s and the plugin not on the list', (pluginsMode) => {
  beforeEach(() => setPolicy({ pluginsMode, pluginAllowlist: pluginsMode === 'allowlist' ? ['kept'] : [] }));

  it('the marketplace refuses before anyone asks the directory', async () => {
    const { POST } = await import('@/app/api/admin/marketplace/route');
    const answer = await POST(jsonRequest('/api/admin/marketplace', 'POST', { slug: 'other', version: '1.0.0', type: 'plugin' }));
    expect(answer.status).toBe(403);
    expect((await answer.json()).code).toBe('blocked_by_policy');
    expect(fetch).not.toHaveBeenCalled();
    expect(registry.saved).toEqual([]);
  });

  it('PATCH will not switch it on, or force it on', async () => {
    const { PATCH } = await import('@/app/api/admin/plugins/route');
    for (const body of [{ id: 'other', enabled: true }, { id: 'other', forceEnabled: true }]) {
      const answer = await PATCH(jsonRequest('/api/admin/plugins', 'PATCH', body));
      expect(answer.status).toBe(403);
    }
    expect(registry.updated).toEqual([]);
  });

  it('PATCH can still switch it off', async () => {
    const { PATCH } = await import('@/app/api/admin/plugins/route');
    const answer = await PATCH(jsonRequest('/api/admin/plugins', 'PATCH', { id: 'other', enabled: false }));
    expect(answer.status).toBe(200);
  });

  it('a rollback is refused', async () => {
    const { POST } = await import('@/app/api/admin/extensions/[kind]/[id]/rollback/route');
    const answer = await POST(jsonRequest('/x', 'POST', { version: '0.9.0' }), { params: Promise.resolve({ kind: 'plugin', id: 'other' }) });
    expect(answer.status).toBe(403);
    expect(registry.saved).toEqual([]);
  });

  it('approving a user\'s package is refused, and denying it is not', async () => {
    const { POST } = await import('@/app/api/admin/plugin-approvals/route');
    const hash = 'a'.repeat(64);
    expect((await POST(jsonRequest('/x', 'POST', { pluginId: 'other', bundleHash: hash, decision: 'approved' }))).status).toBe(403);
    expect(registry.decided).toEqual([]);
    expect((await POST(jsonRequest('/x', 'POST', { pluginId: 'other', bundleHash: hash, decision: 'denied' }))).status).toBe(200);
  });

  it('the bundle is not served', async () => {
    const { GET } = await import('@/app/api/admin/plugins/[id]/bundle/route');
    const answer = await GET(new NextRequest('http://localhost/api/admin/plugins/other/bundle'), { params: Promise.resolve({ id: 'other' }) });
    expect(answer.status).toBe(403);
  });

  it('its frame origins are not in the CSP', async () => {
    delete (globalThis as unknown as Record<symbol, unknown>)[Symbol.for('bulwark.admin.cspFrameOrigins')];
    const { getEnabledPluginFrameOrigins } = await import('@/lib/admin/csp-frame-origins');
    const origins = await getEnabledPluginFrameOrigins();
    expect(origins).not.toContain('https://other.example');
    expect(origins.includes('https://kept.example')).toBe(pluginsMode === 'allowlist');
  });

  it('the list still names it, flagged as refused, so nothing counts it as removed', async () => {
    const { GET } = await import('@/app/api/plugins/route');
    const answer = await GET(new NextRequest('http://localhost/api/plugins'));
    const { plugins } = await answer.json() as { plugins: { id: string; refused?: boolean }[] };
    expect(plugins.map((p) => p.id).sort()).toEqual(['kept', 'other']);
    expect(plugins.find((p) => p.id === 'other')!.refused).toBe(true);
    expect(plugins.find((p) => p.id === 'kept')!.refused === true).toBe(pluginsMode === 'off');
  });
});

describe('what is allowed goes through', () => {
  it('an allowlisted plugin passes the gate', async () => {
    setPolicy({ pluginsMode: 'allowlist', pluginAllowlist: ['kept'] });
    const { PATCH } = await import('@/app/api/admin/plugins/route');
    const patched = await PATCH(jsonRequest('/api/admin/plugins', 'PATCH', { id: 'kept', enabled: true }));
    expect(await patched.json()).toMatchObject({ plugin: { id: 'kept', enabled: true } });
    expect(patched.status).toBe(200);
    const { GET } = await import('@/app/api/admin/plugins/[id]/bundle/route');
    expect((await GET(new NextRequest('http://localhost/x'), { params: Promise.resolve({ id: 'kept' }) })).status).toBe(200);
  });

  it('a build without the desktop flag ignores all of it, even with a value on globalThis', async () => {
    vi.stubEnv('NEXT_PUBLIC_BULWARK_DESKTOP', '');
    setPolicy({ pluginsMode: 'off' });
    const { PATCH } = await import('@/app/api/admin/plugins/route');
    expect((await PATCH(jsonRequest('/api/admin/plugins', 'PATCH', { id: 'other', enabled: true }))).status).toBe(200);
    const { GET } = await import('@/app/api/plugins/route');
    const { plugins } = await (await GET(new NextRequest('http://localhost/api/plugins'))).json() as { plugins: { refused?: boolean }[] };
    expect(plugins.every((p) => !p.refused)).toBe(true);
  });
});

describe('AllowedJmapServers on the sign-in routes', () => {
  it('refuses a server off the list before contacting it', async () => {
    setPolicy({ pluginsMode: 'allowed', allowedJmapServers: ['https://mail.example.com'] });
    const { POST } = await import('@/app/api/auth/session/route');
    const answer = await POST(jsonRequest('/api/auth/session', 'POST', { serverUrl: 'https://other.example.org', username: 'a', password: 'b' }));
    expect(answer.status).toBe(403);
    expect((await answer.json()).code).toBe('blocked_by_policy');
    expect(fetch).not.toHaveBeenCalled();
  });

  it('the browser sign-in\'s lookup refuses it too', async () => {
    setPolicy({ pluginsMode: 'allowed', allowedJmapServers: ['https://mail.example.com'] });
    const { resolveCustomUpstream } = await import('@/lib/oauth/custom-upstream');
    expect(await resolveCustomUpstream('https://other.example.org', 'client')).toBeNull();
    expect(await resolveCustomUpstream('https://mail.example.com', 'client')).toMatchObject({ serverUrl: 'https://mail.example.com' });
  });
});
