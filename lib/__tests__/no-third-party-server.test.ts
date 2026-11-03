// @vitest-environment node
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { NextRequest } from 'next/server';

// The server half of the "no third-party traffic" mode (#903): every route
// and scheduler that talks to a built-in outside host stops before the
// request once the switch is on, and works as before when it is off.

vi.hoisted(() => { process.env.NEXT_PUBLIC_APP_VERSION = '1.18.0'; });

vi.mock('@/lib/stalwart/credentials', () => ({
  getStalwartCredentials: vi.fn(async () => ({ serverUrl: 'https://mail.example.com', authHeader: 'Basic x', username: 'u' })),
}));
vi.mock('@/lib/security/same-origin', () => ({ rejectCrossOriginRequest: () => null }));
vi.mock('@/lib/auth/instance-details', () => ({ canSeeInstanceDetails: vi.fn(async () => true) }));
vi.mock('@/lib/admin/session', () => ({
  requireAdminAuth: vi.fn(async () => ({ session: { sub: 'admin' } })),
  getClientIP: () => '127.0.0.1',
}));
vi.mock('@/lib/admin/audit', () => ({ auditLog: vi.fn(async () => {}) }));

const registryPlugins: Record<string, unknown>[] = [];
vi.mock('@/lib/admin/plugin-registry', () => ({
  getPluginRegistry: vi.fn(async () => ({ plugins: registryPlugins })),
  getThemeRegistry: vi.fn(async () => ({ themes: [] })),
  getPlugin: vi.fn(async (id: string) => registryPlugins.find((p) => p.id === id) ?? null),
  getTheme: vi.fn(async () => null),
}));
vi.mock('@/lib/admin/plugin-dev', () => ({ listDevPlugins: vi.fn(async () => []) }));

import { configManager } from '@/lib/admin/config-manager';
import { isNoThirdPartyTrafficOn, noThirdPartyTrafficState } from '@/lib/admin/third-party-mode';

let dir: string;
const fetchMock = vi.fn(async (_url: unknown, _init?: unknown) => new Response(new Uint8Array(64).fill(1), { headers: { 'content-type': 'image/png' } }));

function calledHosts(): string[] {
  return fetchMock.mock.calls.map(([url]) => {
    try { return new URL(String(url)).hostname; } catch { return String(url); }
  });
}

/** The switch as an admin sets it: config.json, read again. */
async function setMode(on: boolean, policy: Record<string, unknown> = {}) {
  writeFileSync(path.join(dir, 'config.json'), JSON.stringify(on ? { noThirdPartyTraffic: true } : {}));
  writeFileSync(path.join(dir, 'policy.json'), JSON.stringify(policy));
  await configManager.load();
}

beforeAll(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'bulwark-3p-'));
  process.env.ADMIN_CONFIG_DIR = dir;
  process.env.TELEMETRY_DATA_DIR = path.join(dir, 'telemetry');
  process.env.VERSION_CHECK_DATA_DIR = path.join(dir, 'version');
});
afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
  delete process.env.ADMIN_CONFIG_DIR;
  delete process.env.TELEMETRY_DATA_DIR;
  delete process.env.VERSION_CHECK_DATA_DIR;
});
beforeEach(() => {
  fetchMock.mockClear();
  vi.stubGlobal('fetch', fetchMock);
  delete process.env.NO_THIRD_PARTY_TRAFFIC;
  registryPlugins.length = 0;
});
afterEach(() => {
  vi.unstubAllGlobals();
  delete process.env.NO_THIRD_PARTY_TRAFFIC;
});

describe('the switch', () => {
  it('is off by default and on from config.json', async () => {
    await setMode(false);
    expect(await isNoThirdPartyTrafficOn()).toBe(false);
    expect(noThirdPartyTrafficState()).toEqual({ on: false, source: 'default' });
    await setMode(true);
    expect(await isNoThirdPartyTrafficOn()).toBe(true);
    expect(noThirdPartyTrafficState()).toEqual({ on: true, source: 'admin' });
  });

  it('takes an env "on" over a config.json false, and any common spelling of on', async () => {
    writeFileSync(path.join(dir, 'config.json'), JSON.stringify({ noThirdPartyTraffic: false }));
    await configManager.load();
    for (const value of ['true', '1', 'YES', 'on']) {
      process.env.NO_THIRD_PARTY_TRAFFIC = value;
      expect(await isNoThirdPartyTrafficOn()).toBe(true);
      expect(noThirdPartyTrafficState()).toEqual({ on: true, source: 'env' });
    }
    process.env.NO_THIRD_PARTY_TRAFFIC = 'false';
    expect(await isNoThirdPartyTrafficOn()).toBe(false);
  });

  it('is in the client config', async () => {
    const { GET } = await import('@/app/api/config/route');
    await setMode(true);
    expect((await (await GET(new NextRequest('https://webmail.example/api/config'))).json()).noThirdPartyTraffic).toBe(true);
    await setMode(false);
    expect((await (await GET(new NextRequest('https://webmail.example/api/config'))).json()).noThirdPartyTraffic).toBe(false);
  });

  it('refuses an admin "off" while the environment says on', async () => {
    const { PATCH } = await import('@/app/api/admin/config/route');
    process.env.NO_THIRD_PARTY_TRAFFIC = 'true';
    const res = await PATCH(new NextRequest('https://webmail.example/api/admin/config', {
      method: 'PATCH', body: JSON.stringify({ noThirdPartyTraffic: false }),
    }));
    expect(res.status).toBe(409);
  });
});

describe('sender favicons', () => {
  it('answer 403 without contacting DuckDuckGo', async () => {
    const { GET } = await import('@/app/api/favicon/route');
    await setMode(true);
    const res = await GET(new NextRequest('https://webmail.example/api/favicon?domain=github.com'));
    expect(res.status).toBe(403);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('come from DuckDuckGo with the mode off', async () => {
    const { GET } = await import('@/app/api/favicon/route');
    await setMode(false);
    await GET(new NextRequest('https://webmail.example/api/favicon?domain=gitlab.com'));
    expect(calledHosts()).toEqual(['icons.duckduckgo.com']);
  });
});

describe('translation', () => {
  const post = async (body: Record<string, unknown>) => {
    const { POST } = await import('@/app/api/translate/route');
    return POST(new NextRequest('https://webmail.example/api/translate', { method: 'POST', body: JSON.stringify(body) }));
  };

  it('refuses MyMemory before any request', async () => {
    await setMode(true);
    const res = await post({ text: 'Hallo Welt', target: 'en', source: 'de' });
    expect(res.status).toBe(403);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('still uses MyMemory with the mode off, and the admin\'s LibreTranslate with it on', async () => {
    fetchMock.mockImplementation(async () => Response.json({ responseData: { translatedText: 'Hello world' }, translatedText: 'Hello world' }));
    await setMode(false);
    await post({ text: 'Hallo Welt', target: 'en', source: 'de' });
    expect(calledHosts()).toContain('api.mymemory.translated.net');

    fetchMock.mockClear();
    process.env.LIBRETRANSLATE_URL = 'https://translate.corp.example';
    try {
      await setMode(true);
      await post({ text: 'Hallo Welt', target: 'en', source: 'de', provider: 'libretranslate' });
      expect(calledHosts()).toEqual(['translate.corp.example']);
    } finally {
      delete process.env.LIBRETRANSLATE_URL;
      fetchMock.mockImplementation(async () => new Response(new Uint8Array(64).fill(1), { headers: { 'content-type': 'image/png' } }));
    }
  });
});

describe('connector', () => {
  it('answers 404 in the mode', async () => {
    const { GET } = await import('@/app/api/connector/capabilities/route');
    await setMode(false);
    expect((await GET()).status).toBe(200);
    await setMode(true);
    expect((await GET()).status).toBe(404);
  });
});

describe('telemetry', () => {
  it('is off whatever the saved consent says, and send-now sends nothing', async () => {
    const { effectiveConsent, saveState, loadState, sendOnce } = await import('@/lib/telemetry');
    await setMode(false);
    await saveState({ ...(await loadState()), consent: 'on' });
    expect((await effectiveConsent()).consent).toBe('on');

    await setMode(true);
    expect(await effectiveConsent()).toMatchObject({ consent: 'off', source: 'no-third-party' });
    expect((await sendOnce({ reason: 'test' })).ok).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('version check', () => {
  it('asks the version endpoint only with the mode off', async () => {
    const { checkOnce } = await import('@/lib/version-check');
    fetchMock.mockImplementation(async () => Response.json({ latest: '1.18.0', severity: 'none' }));
    try {
      await setMode(true);
      expect(await checkOnce()).toMatchObject({ ok: false, error: 'off: no third-party traffic' });
      expect(fetchMock).not.toHaveBeenCalled();

      await setMode(false);
      await checkOnce();
      expect(calledHosts()).toEqual(['version.telemetry.bulwarkmail.org']);
    } finally {
      fetchMock.mockImplementation(async () => new Response(new Uint8Array(64).fill(1), { headers: { 'content-type': 'image/png' } }));
    }
  });
});

describe('extension directory', () => {
  it('refuses the official directory in the mode and keeps a self-hosted one', async () => {
    const { directoryOff } = await import('@/lib/admin/marketplace-directory');
    const { GET } = await import('@/app/api/admin/marketplace/route');
    await setMode(true);
    expect(await directoryOff()).toBe(true);
    const res = await GET(new NextRequest('https://webmail.example/api/admin/marketplace'));
    expect(res.status).toBe(403);
    expect(fetchMock).not.toHaveBeenCalled();

    writeFileSync(path.join(dir, 'config.json'), JSON.stringify({ noThirdPartyTraffic: true, extensionDirectoryUrl: 'https://extensions.corp.example' }));
    await configManager.load();
    expect(await directoryOff()).toBe(false);

    await setMode(false);
    expect(await directoryOff()).toBe(false);
  });

  it('keeps the installed list of the updates view', async () => {
    const { GET } = await import('@/app/api/admin/marketplace/updates/route');
    await setMode(true);
    const res = await GET(new NextRequest('https://webmail.example/api/admin/marketplace/updates'));
    expect(res.status).toBe(200);
    expect((await res.json()).error).toMatch(/official extension directory is off/);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('plugins', () => {
  const plugins = [
    { id: 'offline', name: 'Offline', version: '1.0.0', enabled: true, permissions: ['email:read'] },
    { id: 'fetcher', name: 'Fetcher', version: '1.0.0', enabled: true, permissions: ['http:fetch'], httpOrigins: ['https://api.vendor.example'] },
    { id: 'proxied', name: 'Proxied', version: '1.0.0', enabled: true, permissions: ['http:proxy'] },
    { id: 'framer', name: 'Framer', version: '1.0.0', enabled: true, permissions: [], frameOrigins: ['https://www.youtube-nocookie.com'] },
  ];

  it('that declare network access never reach a browser in the mode', async () => {
    registryPlugins.push(...plugins);
    const { GET } = await import('@/app/api/plugins/route');
    await setMode(false);
    const off = await (await GET(new NextRequest('https://webmail.example/api/plugins'))).json();
    expect(off.plugins.map((p: { id: string }) => p.id)).toEqual(['offline', 'fetcher', 'proxied', 'framer']);
    await setMode(true);
    const on = await (await GET(new NextRequest('https://webmail.example/api/plugins'))).json();
    expect(on.plugins.map((p: { id: string }) => p.id)).toEqual(['offline']);
  });

  it('get no outside frames in the CSP', async () => {
    registryPlugins.push(...plugins);
    const { getEnabledPluginFrameOrigins, invalidateFrameOriginsCache } = await import('@/lib/admin/csp-frame-origins');
    await setMode(false);
    invalidateFrameOriginsCache();
    expect(await getEnabledPluginFrameOrigins()).toEqual(['https://www.youtube-nocookie.com']);
    await setMode(true);
    invalidateFrameOriginsCache();
    expect(await getEnabledPluginFrameOrigins()).toEqual([]);
  });

  it('can\'t use the credential proxy', async () => {
    const { POST } = await import('@/app/api/plugin-proxy/route');
    await setMode(true, { features: { pluginsEnabled: true } });
    const res = await POST(new NextRequest('https://webmail.example/api/plugin-proxy?plugin=proxied&credential=main&url=https%3A%2F%2Fapi.vendor.example%2F', { method: 'POST' }));
    expect(res.status).toBe(403);
    expect(res.headers.get('x-bulwark-proxy-error')).toBe('no-third-party-traffic');
    expect((await res.json()).code).toBe('no-third-party-traffic');
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('admin view', () => {
  it('reports the switch, its source, what stays reachable and the refused plugins', async () => {
    registryPlugins.push(
      { id: 'offline', name: 'Offline', version: '1.0.0', enabled: true, permissions: ['email:read'] },
      { id: 'fetcher', name: 'Fetcher', version: '1.0.0', enabled: true, permissions: ['http:fetch'], httpOrigins: ['https://api.vendor.example'] },
    );
    const { GET } = await import('@/app/api/admin/outgoing-hosts/route');
    writeFileSync(path.join(dir, 'config.json'), JSON.stringify({ noThirdPartyTraffic: true, jmapServerUrl: 'https://mail.corp.example' }));
    writeFileSync(path.join(dir, 'policy.json'), JSON.stringify({ pushRelays: [{ label: 'Own', url: 'https://push.corp.example' }] }));
    await configManager.load();
    const body = await (await GET(new NextRequest('https://webmail.example/api/admin/outgoing-hosts'))).json();
    expect(body).toMatchObject({ noThirdPartyTraffic: true, source: 'admin', envLocked: false, readOnly: false });
    expect(body.reachable.map((h: { host: string }) => h.host)).toEqual(['mail.corp.example', 'push.corp.example', 'any address your users enter', 'any address your users enter']);
    expect(body.networkPlugins).toEqual([{ id: 'fetcher', name: 'Fetcher' }]);
    expect(body.builtIn.length).toBeGreaterThan(5);

    process.env.NO_THIRD_PARTY_TRAFFIC = 'true';
    expect(await (await GET(new NextRequest('https://webmail.example/api/admin/outgoing-hosts'))).json()).toMatchObject({ source: 'env', envLocked: true });
  });
});

describe('review follow-ups', () => {
  it('counts a string "true", "1", "yes" or "on" in config.json as on', async () => {
    for (const value of ['true', '1', 'yes', 'on', 'TRUE']) {
      writeFileSync(path.join(dir, 'config.json'), JSON.stringify({ noThirdPartyTraffic: value }));
      await configManager.load();
      expect(await isNoThirdPartyTrafficOn(), value).toBe(true);
      expect(noThirdPartyTrafficState(), value).toEqual({ on: true, source: 'admin' });
    }
    writeFileSync(path.join(dir, 'config.json'), JSON.stringify({ noThirdPartyTraffic: 'no' }));
    await configManager.load();
    expect(await isNoThirdPartyTrafficOn()).toBe(false);
  });

  it('keeps the version check scheduled in the mode, so it resumes once the switch is off', async () => {
    const { startScheduler, stopScheduler, checkOnce, loadState, saveState } = await import('@/lib/version-check');
    fetchMock.mockImplementation(async () => Response.json({ latest: '1.18.0', severity: 'none' }));
    try {
      await setMode(true);
      await saveState({ ...(await loadState()), nextScheduledAt: null });
      await startScheduler();
      expect((await loadState()).nextScheduledAt).not.toBeNull();
      await stopScheduler();
      expect((await checkOnce()).ok).toBe(false);
      expect(fetchMock).not.toHaveBeenCalled();
      await setMode(false);
      await checkOnce();
      expect(calledHosts()).toEqual(['version.telemetry.bulwarkmail.org']);
    } finally {
      await stopScheduler();
      fetchMock.mockImplementation(async () => new Response(new Uint8Array(64).fill(1), { headers: { 'content-type': 'image/png' } }));
    }
  });

  it('makes getDirectoryUrl refuse the official directory in the mode', async () => {
    const { getDirectoryUrl, DirectoryError } = await import('@/lib/admin/marketplace-directory');
    await setMode(true);
    await expect(getDirectoryUrl()).rejects.toBeInstanceOf(DirectoryError);
    await expect(getDirectoryUrl()).rejects.toMatchObject({ status: 403 });
    await setMode(false);
    expect(await getDirectoryUrl()).toBe('https://extensions.bulwarkmail.org');
  });

  it('leaves the sample contact photos out of the mock server in the mode', async () => {
    process.env.DEV_MOCK_JMAP = 'true';
    process.env.NEXT_PUBLIC_DEV_MOCK_JMAP = 'true';
    try {
      const { POST } = await import('@/app/api/dev-jmap/[...path]/route');
      const photos = async () => {
        const res = await POST(
          new NextRequest('http://localhost:3000/api/dev-jmap/api', { method: 'POST', body: JSON.stringify({ using: [], methodCalls: [['ContactCard/get', {}, '0']] }) }),
          { params: Promise.resolve({ path: ['api'] }) },
        );
        const list = (await res.json()).methodResponses[0][1].list as Array<{ media?: Record<string, { uri?: string }> }>;
        return list.flatMap((c) => Object.values(c.media ?? {}).map((m) => m.uri ?? '')).filter((uri) => uri.includes('randomuser.me'));
      };
      await setMode(false);
      expect((await photos()).length).toBeGreaterThan(0);
      await setMode(true);
      expect(await photos()).toEqual([]);
    } finally {
      delete process.env.DEV_MOCK_JMAP;
      delete process.env.NEXT_PUBLIC_DEV_MOCK_JMAP;
    }
  });
});

// A company link check is a server the admin entered on the plugin's admin
// page: it stays reachable with the switch on, like the JMAP server. The
// plugin used to be refused completely, and its domain warning with it.
describe('plugins reaching only servers the admin entered', () => {
  const linkCheck = {
    id: 'link-check', name: 'Link Check', version: '2.0.0', enabled: true, permissions: ['http:proxy'],
    configSchema: { endpointUrl: { type: 'string', label: 'URL' }, token: { type: 'secret', label: 'Token' }, key: { type: 'secret', label: 'Key' } },
    credentials: {
      company: { label: 'Company', scope: 'admin', inject: { type: 'none' }, secretKey: 'token', originKey: 'endpointUrl' },
      google: { label: 'Google', scope: 'admin', inject: { type: 'header', name: 'X-Goog-Api-Key' }, secretKey: 'key', origin: 'https://safebrowsing.googleapis.com' },
    },
  };
  const googleOnly = {
    id: 'google-only', name: 'Google Only', version: '1.0.0', enabled: true, permissions: ['http:proxy'],
    configSchema: { key: { type: 'secret', label: 'Key' } },
    credentials: { google: { label: 'Google', scope: 'admin', inject: { type: 'bearer' }, secretKey: 'key', origin: 'https://safebrowsing.googleapis.com' } },
  };

  it('reach the browser in the mode, unlike one with only fixed servers', async () => {
    registryPlugins.push(linkCheck, googleOnly);
    const { GET } = await import('@/app/api/plugins/route');
    await setMode(true);
    const on = await (await GET(new NextRequest('https://webmail.example/api/plugins'))).json();
    expect(on.plugins.map((p: { id: string }) => p.id)).toEqual(['link-check']);
  });

  it('get the proxy for the admin-entered server only', async () => {
    registryPlugins.push(linkCheck);
    const { setPluginConfig } = await import('@/lib/admin/plugin-config');
    await setPluginConfig('link-check', 'endpointUrl', 'https://linkcheck.corp.example/check');
    fetchMock.mockResolvedValueOnce(new Response('{"verdict":"safe"}', { headers: { 'content-type': 'application/json' } }));
    const { POST } = await import('@/app/api/plugin-proxy/route');
    await setMode(true, { features: { pluginsEnabled: true } });
    const company = await POST(new NextRequest('https://webmail.example/api/plugin-proxy?plugin=link-check&credential=company&url=https%3A%2F%2Flinkcheck.corp.example%2Fcheck', { method: 'POST' }));
    expect(company.status).toBe(200);
    expect(await company.json()).toEqual({ verdict: 'safe' });
    expect(calledHosts()).toEqual(['linkcheck.corp.example']);
    const google = await POST(new NextRequest('https://webmail.example/api/plugin-proxy?plugin=link-check&credential=google&url=https%3A%2F%2Fsafebrowsing.googleapis.com%2Fv5%2Fhashes%3Asearch', { method: 'POST' }));
    expect(google.status).toBe(403);
    expect((await google.json()).code).toBe('no-third-party-traffic');
    expect(calledHosts()).not.toContain('safebrowsing.googleapis.com');
  });

  // The admin page saves a field's default with the first Save: a plugin
  // could bring its own collector as the default and reach it in the mode.
  it("don't count a server the plugin brought as the field's default", async () => {
    const shipped = {
      ...linkCheck, id: 'shipped',
      configSchema: { ...linkCheck.configSchema, endpointUrl: { type: 'string', label: 'URL', default: 'https://collector.example/in' } },
    };
    registryPlugins.push(shipped);
    const { setPluginConfig } = await import('@/lib/admin/plugin-config');
    await setPluginConfig('shipped', 'endpointUrl', 'https://collector.example/in');
    const { POST } = await import('@/app/api/plugin-proxy/route');
    await setMode(true, { features: { pluginsEnabled: true } });
    const res = await POST(new NextRequest('https://webmail.example/api/plugin-proxy?plugin=shipped&credential=company&url=https%3A%2F%2Fcollector.example%2Fin', { method: 'POST' }));
    expect(res.status).toBe(403);
    expect((await res.json()).code).toBe('no-third-party-traffic');
    expect(fetchMock).not.toHaveBeenCalled();
    const { adminEnteredOrigins } = await import('@/lib/plugin-secrets/proxy');
    expect(await adminEnteredOrigins('shipped')).toEqual([]);
    // The admin types another address: that one is theirs.
    await setPluginConfig('shipped', 'endpointUrl', 'https://linkcheck.corp.example/check');
    expect(await adminEnteredOrigins('shipped')).toEqual(['https://linkcheck.corp.example']);
  });

  it('are listed on the Security page with the server the admin entered and the one that stays off', async () => {
    registryPlugins.push(linkCheck, googleOnly);
    const { setPluginConfig } = await import('@/lib/admin/plugin-config');
    await setPluginConfig('link-check', 'endpointUrl', 'https://linkcheck.corp.example/check');
    const { GET } = await import('@/app/api/admin/outgoing-hosts/route');
    await setMode(true);
    const body = await (await GET(new NextRequest('https://webmail.example/api/admin/outgoing-hosts'))).json();
    expect(body.reachable).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: 'Plugin Link Check', host: 'linkcheck.corp.example', side: 'server' }),
    ]));
    expect(body.networkPlugins).toEqual([{ id: 'google-only', name: 'Google Only' }]);
    expect(body.partlyOffPlugins).toEqual([{ id: 'link-check', name: 'Link Check', hosts: ['safebrowsing.googleapis.com'] }]);
  });
});
