import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { BulwarkDesktopBridge } from '../types';

/** The webmail's view of the bridge, and the http server route. */

// The client's first import compiles a good part of the app.
vi.setConfig({ testTimeout: 60_000 });

function setBridge(bridge: Partial<BulwarkDesktopBridge> | undefined) {
  window.bulwarkDesktop = bridge as BulwarkDesktopBridge | undefined;
}

afterEach(() => {
  setBridge(undefined);
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  sessionStorage.clear();
});

describe('feature detection', () => {
  it('finds nothing in a browser', async () => {
    const { getDesktopBridge, isDesktopApp } = await import('../bridge');
    expect(getDesktopBridge()).toBeNull();
    expect(isDesktopApp()).toBe(false);
  });

  it('finds the bridge in the app', async () => {
    const { isDesktopApp } = await import('../bridge');
    setBridge({ version: 1, platform: 'win32' });
    expect(isDesktopApp()).toBe(true);
  });

  it('treats a newer bridge major as absent rather than guessing at it', async () => {
    const { getDesktopBridge } = await import('../bridge');
    setBridge({ version: 2, platform: 'win32' });
    expect(getDesktopBridge()).toBeNull();
  });
});

describe('web push', () => {
  beforeEach(() => {
    Object.defineProperty(navigator, 'serviceWorker', { value: {}, configurable: true });
    vi.stubGlobal('PushManager', function PushManager() {});
    vi.stubGlobal('Notification', function Notification() {});
  });

  it('is on offer in a browser', async () => {
    const { isWebPushSupported } = await import('@/lib/web-push');
    expect(isWebPushSupported()).toBe(true);
  });

  it('is off in the app: Electron has the API, but subscribing fails', async () => {
    const { isWebPushSupported } = await import('@/lib/web-push');
    setBridge({ version: 1, platform: 'win32' });
    expect(isWebPushSupported()).toBe(false);
  });
});

describe('desktopJmapBase', () => {
  async function load() {
    vi.resetModules();
    return import('../jmap-route');
  }

  it('leaves every URL alone outside the desktop build', async () => {
    const { desktopJmapBase, desktopJmapOrigin } = await load();
    expect(desktopJmapBase('http://192.168.1.5:8080')).toBe('http://192.168.1.5:8080');
    expect(desktopJmapOrigin('http://192.168.1.5:8080')).toBe('http://192.168.1.5:8080');
  });

  it('moves a plain http server onto the same-origin route', async () => {
    vi.stubEnv('NEXT_PUBLIC_BULWARK_DESKTOP', '1');
    const { desktopJmapBase, desktopJmapOriginId } = await load();
    const id = desktopJmapOriginId('http://192.168.1.5:8080');
    expect(id).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(Buffer.from(id, 'base64url').toString()).toBe('http://192.168.1.5:8080');
    expect(desktopJmapBase('http://192.168.1.5:8080')).toBe(`${window.location.origin}/__jmap/${id}`);
  });

  it('keeps an https server direct', async () => {
    vi.stubEnv('NEXT_PUBLIC_BULWARK_DESKTOP', '1');
    const { desktopJmapBase, desktopJmapOrigin } = await load();
    expect(desktopJmapBase('https://mail.lan')).toBe('https://mail.lan');
    expect(desktopJmapOrigin('https://mail.lan')).toBe('https://mail.lan');
  });
});

describe('JMAPClient on an approved http server', () => {
  const SESSION = {
    capabilities: { 'urn:ietf:params:jmap:core': { maxObjectsInGet: 500 }, 'urn:ietf:params:jmap:mail': {} },
    accounts: { a1: { name: 'ent-alice', isPersonal: true, isReadOnly: false, accountCapabilities: { 'urn:ietf:params:jmap:mail': {} } } },
    primaryAccounts: { 'urn:ietf:params:jmap:mail': 'a1' },
    username: 'ent-alice',
    apiUrl: 'http://stalwart.local:8080/jmap/',
    downloadUrl: 'http://stalwart.local:8080/jmap/download/{accountId}/{blobId}/{name}?accept={type}',
    uploadUrl: 'http://stalwart.local:8080/jmap/upload/{accountId}/',
    eventSourceUrl: 'http://stalwart.local:8080/jmap/eventsource/',
    state: 's1',
  };

  function stubFetch() {
    const urls: string[] = [];
    vi.stubGlobal('fetch', vi.fn(async (input: string | URL | Request) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      urls.push(url);
      if (url.includes('/.well-known/jmap')) return new Response(JSON.stringify(SESSION), { status: 200 });
      return new Response(JSON.stringify({ methodResponses: [], sessionState: 's1' }), { status: 200 });
    }));
    return urls;
  }

  async function connect(serverUrl: string) {
    vi.resetModules();
    const { JMAPClient } = await import('@/lib/jmap/client');
    const client = new JMAPClient(serverUrl, 'ent-alice', 'pw');
    await client.connect();
    const session = (client as unknown as { session: typeof SESSION }).session;
    client.disconnect();
    return session;
  }

  it('sends discovery and every session URL through /__jmap in the desktop build', async () => {
    vi.stubEnv('NEXT_PUBLIC_BULWARK_DESKTOP', '1');
    const urls = stubFetch();
    const noteSession = vi.fn();
    setBridge({ version: 1, platform: 'win32', servers: { prepare: vi.fn(), noteSession } });
    const session = await connect('http://192.168.1.5:8080');
    const base = `${window.location.origin}/__jmap/${Buffer.from('http://192.168.1.5:8080').toString('base64url')}`;
    expect(urls[0]).toBe(`${base}/.well-known/jmap`);
    expect(session.apiUrl).toBe(`${base}/jmap/`);
    expect(session.downloadUrl).toBe(`${base}/jmap/download/{accountId}/{blobId}/{name}?accept={type}`);
    expect(session.uploadUrl).toBe(`${base}/jmap/upload/{accountId}/`);
    expect(session.eventSourceUrl).toBe(`${base}/jmap/eventsource/`);
    expect(urls.filter((u) => u.startsWith('http://192.168.1.5'))).toEqual([]);
    expect(noteSession).toHaveBeenCalledWith('http://192.168.1.5:8080', expect.objectContaining({ apiUrl: `${base}/jmap/` }));
  });

  it('a server build talks to the server directly, as it always did', async () => {
    const urls = stubFetch();
    const session = await connect('http://192.168.1.5:8080');
    expect(urls[0]).toBe('http://192.168.1.5:8080/.well-known/jmap');
    expect(session.apiUrl).toBe('http://192.168.1.5:8080/jmap/');
  });
});

describe('runDesktopBrowserSignIn', () => {
  const ENDPOINTS = { authorization_endpoint: 'https://mail.example/authorize', client_id: 'registered-client', scope: 'openid email' };

  function authBridge(result: unknown) {
    const completeBrowserSignIn = vi.fn(async (_flowId: string, url: string) => (
      typeof result === 'function' ? (result as (u: string) => unknown)(url) : result
    ));
    const bridge = {
      version: 1,
      platform: 'win32',
      servers: { prepare: vi.fn(async () => ({ ok: true, approved: false })), noteSession: vi.fn() },
      auth: {
        beginBrowserSignIn: vi.fn(async () => ({ flowId: 'f1', redirectUri: 'http://127.0.0.1:51234/bulwark-desktop/callback' })),
        completeBrowserSignIn,
        cancelBrowserSignIn: vi.fn(),
      },
    } as unknown as BulwarkDesktopBridge;
    setBridge(bridge);
    return bridge;
  }

  const options = { serverUrl: 'https://mail.example', callbackPath: '/en/auth/callback', slot: 1, remember: true, addAccount: false };

  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify(ENDPOINTS), { status: 200 })));
  });

  it('runs PKCE with the loopback redirect and parks what the callback page needs', async () => {
    const { runDesktopBrowserSignIn } = await import('../browser-sign-in');
    let authorize = new URL('https://x');
    authBridge((url: string) => {
      authorize = new URL(url);
      return { ok: true, code: 'the-code', state: authorize.searchParams.get('state') };
    });
    const outcome = await runDesktopBrowserSignIn(options);
    expect(outcome.kind).toBe('callback');
    expect(authorize.origin + authorize.pathname).toBe('https://mail.example/authorize');
    expect(authorize.searchParams.get('client_id')).toBe('registered-client');
    expect(authorize.searchParams.get('redirect_uri')).toBe('http://127.0.0.1:51234/bulwark-desktop/callback');
    expect(authorize.searchParams.get('code_challenge_method')).toBe('S256');
    expect(authorize.searchParams.get('code_challenge')).toBeTruthy();
    expect(sessionStorage.getItem('oauth_redirect_uri')).toBe('http://127.0.0.1:51234/bulwark-desktop/callback');
    expect(sessionStorage.getItem('oauth_client_id')).toBe('registered-client');
    expect(sessionStorage.getItem('oauth_server_url')).toBe('https://mail.example');
    expect(sessionStorage.getItem('oauth_cookie_slot')).toBe('1');
    expect(sessionStorage.getItem('oauth_code_verifier')).toBeTruthy();
  });

  it('rejects an answer with another state', async () => {
    const { runDesktopBrowserSignIn } = await import('../browser-sign-in');
    authBridge({ ok: true, code: 'c', state: 'forged' });
    const outcome = await runDesktopBrowserSignIn(options);
    expect(outcome).toEqual({ kind: 'failed', error: 'state_mismatch' });
    expect(sessionStorage.getItem('oauth_code_verifier')).toBeNull();
  });

  it('sends nothing to a server the user declined', async () => {
    const { runDesktopBrowserSignIn } = await import('../browser-sign-in');
    const bridge = authBridge({ ok: false, error: 'cancelled' });
    bridge.servers!.prepare = vi.fn(async () => ({ ok: false as const, reason: 'declined' as const }));
    const outcome = await runDesktopBrowserSignIn(options);
    expect(outcome.kind).toBe('declined');
    expect(bridge.auth!.beginBrowserSignIn).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
  });

  it('says so when the server has no OAuth, and closes the listener', async () => {
    const { runDesktopBrowserSignIn } = await import('../browser-sign-in');
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status: 404 })));
    const bridge = authBridge({ ok: true });
    const outcome = await runDesktopBrowserSignIn(options);
    expect(outcome.kind).toBe('unavailable');
    expect(bridge.auth!.cancelBrowserSignIn).toHaveBeenCalledWith('f1');
    expect(bridge.auth!.completeBrowserSignIn).not.toHaveBeenCalled();
  });
});

describe('isDesktopBlockedRoute', () => {
  it('closes pairing and hand-off, and nothing else', async () => {
    const { isDesktopBlockedRoute } = await import('../blocked-routes');
    for (const path of ['/api/auth/pair/create', '/api/auth/pair/token', '/api/auth/handoff/redeem', '/api/auth/impersonate']) {
      expect(isDesktopBlockedRoute(path), path).toBe(true);
    }
    for (const path of ['/api/auth/session', '/api/auth/token', '/api/auth/pairs', '/en/login']) {
      expect(isDesktopBlockedRoute(path), path).toBe(false);
    }
  });
});
