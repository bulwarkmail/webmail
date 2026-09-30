import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The Stalwart Lite target is a build-time switch (NEXT_PUBLIC_LITE_TARGET),
 * so every test imports the modules fresh with the env stubbed.
 */
async function loadStalwartModules(target: 'stalwart' | 'static' = 'stalwart') {
  vi.resetModules();
  vi.stubEnv('NEXT_PUBLIC_BULWARK_LITE', '1');
  vi.stubEnv('NEXT_PUBLIC_LITE_TARGET', target);
  vi.stubEnv('NEXT_PUBLIC_LITE_BUILD_ID', '1.10.0-abc1234-x1');
  vi.stubEnv('NEXT_PUBLIC_BASE_PATH', '');
  const lite = await import('@/lib/lite');
  const nav = await import('@/lib/browser-navigation');
  const tokens = await import('@/lib/auth/lite-tokens');
  return { lite, nav, tokens };
}

const w = window as unknown as Record<string, unknown>;

describe('Lite on Stalwart: runtime mount and client id', () => {
  beforeEach(() => {
    delete w.__BULWARK_LITE_MOUNT__;
    delete w.__BULWARK_LITE_OAUTH_CLIENT_ID__;
    localStorage.clear();
    sessionStorage.clear();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
    vi.resetModules();
    delete w.__BULWARK_LITE_MOUNT__;
    delete w.__BULWARK_LITE_OAUTH_CLIENT_ID__;
  });

  it('reads the mount the entry document published, and only a single-segment one', async () => {
    const { lite, nav } = await loadStalwartModules();
    expect(lite.IS_LITE_STALWART).toBe(true);
    expect(lite.getLiteMount()).toBeNull();

    w.__BULWARK_LITE_MOUNT__ = '/webmail';
    expect(lite.getLiteMount()).toBe('/webmail');
    // getPathPrefix follows it even where the URL has no locale segment.
    expect(nav.getPathPrefix()).toBe('/webmail');
    expect(nav.withBasePath('/branding/x.svg')).toBe('/webmail/branding/x.svg');

    w.__BULWARK_LITE_MOUNT__ = '';
    expect(lite.getLiteMount()).toBe('');

    for (const bad of ['/a/b', 'webmail', '/web mail', '/x"y', 42]) {
      w.__BULWARK_LITE_MOUNT__ = bad;
      expect(lite.getLiteMount()).toBeNull();
    }
  });

  it('ignores the globals in the static-host build', async () => {
    const { lite } = await loadStalwartModules('static');
    w.__BULWARK_LITE_MOUNT__ = '/webmail';
    w.__BULWARK_LITE_OAUTH_CLIENT_ID__ = 'custom';
    expect(lite.IS_LITE_STALWART).toBe(false);
    expect(lite.getLiteMount()).toBeNull();
    expect(lite.getLiteInjectedClientId()).toBe('');
    expect(lite.withLiteBuildId('/config.json')).toBe('/config.json');
  });

  it('stamps un-hashed files with the build id', async () => {
    const { lite } = await loadStalwartModules();
    expect(lite.withLiteBuildId('/config.json')).toBe('/config.json?v=1.10.0-abc1234-x1');
    expect(lite.withLiteBuildId('/x?a=1')).toBe('/x?a=1&v=1.10.0-abc1234-x1');
  });

  it('points /_next assets at the mount and serves .mjs as .js', async () => {
    const { lite } = await loadStalwartModules();
    const origin = window.location.origin;
    const worker = `${origin}/_next/static/media/pdf.worker.min.abc.mjs`;
    // Not booted by the entry document (no mount): untouched.
    expect(lite.liteMountedAssetUrl(worker)).toBe(worker);
    w.__BULWARK_LITE_MOUNT__ = '/webmail';
    expect(lite.liteMountedAssetUrl(`${origin}/_next/static/media/pdf.worker.min.abc.mjs`)).toBe(`${origin}/webmail/_next/static/media/pdf.worker.min.abc.js`);
    expect(lite.liteMountedAssetUrl('https://cdn.example.com/_next/x.mjs')).toBe('https://cdn.example.com/_next/x.mjs');
    expect(lite.liteMountedAssetUrl(`${origin}/other/x.mjs`)).toBe(`${origin}/other/x.mjs`);
  });

  it('uses the Application oauthClientId when Stalwart injected one, else bulwark-webmail', async () => {
    const { tokens } = await loadStalwartModules();
    expect(tokens.getLiteClientId()).toBe('bulwark-webmail');
    w.__BULWARK_LITE_OAUTH_CLIENT_ID__ = '  ';
    expect(tokens.getLiteClientId()).toBe('bulwark-webmail');
    w.__BULWARK_LITE_OAUTH_CLIENT_ID__ = 'my-webmail';
    expect(tokens.getLiteClientId()).toBe('my-webmail');
  });

  it('does not probe /api/auth on its own origin (Stalwart serves the bundle)', async () => {
    const { tokens } = await loadStalwartModules();
    const fetchMock = vi.fn(async () => new Response('{}', { status: 400 }));
    vi.stubGlobal('fetch', fetchMock);
    tokens.resetLiteProbeCache();
    await expect(tokens.probeLiteTokenLogin(`${window.location.origin}/`)).resolves.toBe(true);
    expect(fetchMock).not.toHaveBeenCalled();
    // Another server (a custom build pointing elsewhere) is still probed.
    await expect(tokens.probeLiteTokenLogin('https://other.example.com')).resolves.toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('logs in and refreshes with the injected client id, and keeps using the one a token was issued to', async () => {
    const { tokens } = await loadStalwartModules();
    w.__BULWARK_LITE_OAUTH_CLIENT_ID__ = 'app-client';
    const calls: { url: string; body: string }[] = [];
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      calls.push({ url, body: String(init?.body ?? '') });
      if (url.endsWith('/api/auth')) return new Response(JSON.stringify({ type: 'authenticated', client_code: 'code' }), { status: 200 });
      return new Response(JSON.stringify({ access_token: 'at', refresh_token: 'rt2', expires_in: 60 }), { status: 200 });
    }));

    await tokens.liteTokenLogin({ serverUrl: 'https://mail.example.com', username: 'a', password: 'p', redirectUri: 'https://mail.example.com/webmail/' });
    expect(JSON.parse(calls[0].body).clientId).toBe('app-client');
    expect(new URLSearchParams(calls[1].body).get('client_id')).toBe('app-client');

    // A token issued before the admin changed oauthClientId refreshes with its own client.
    tokens.saveLiteRefreshToken(0, { serverUrl: 'https://mail.example.com', username: 'a', refreshToken: 'rt', clientId: 'old-client' }, true);
    await tokens.liteRefreshTokens(0);
    expect(new URLSearchParams(calls[2].body).get('client_id')).toBe('old-client');
    // The rotated token keeps its client id.
    expect(tokens.readLiteRefreshToken(0)?.clientId).toBe('old-client');

    // Tokens stored before this change carry no client id: fall back to the current one.
    tokens.saveLiteRefreshToken(1, { serverUrl: 'https://mail.example.com', username: 'b', refreshToken: 'rt' }, false);
    await tokens.liteRefreshTokens(1);
    expect(new URLSearchParams(calls[3].body).get('client_id')).toBe('app-client');
  });
});
