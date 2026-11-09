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
  const ENDPOINTS = { authorization_endpoint: 'https://mail.example/authorize', client_id: 'registered-client', scope: 'openid email', issuer: 'https://mail.example' };
  const REDIRECT = 'http://127.0.0.1:51234/bulwark-desktop/callback';

  function authBridge(result: unknown) {
    const controls = {
      begin: vi.fn(async (): Promise<unknown> => ({ ok: true, flowId: 'f1', redirectUri: REDIRECT, state: 'main-state' })),
      complete: vi.fn(async (_flowId: string, url: string) => (
        typeof result === 'function' ? (result as (u: string) => unknown)(url) : result
      )),
      useScheme: vi.fn(async () => 'bulwark://sign-in/callback'),
      cancel: vi.fn(),
      beginPassword: vi.fn(async (): Promise<unknown> => ({ ok: true, host: 'mail.example' })),
      nextPassword: vi.fn(async (): Promise<unknown> => ({ ok: false, error: 'timeout' })),
      answerPassword: vi.fn(),
      outcome: vi.fn(async (): Promise<unknown> => ({ ok: true, code: '', state: 'main-state' })),
    };
    setBridge({ version: 1, platform: 'win32', auth: { claim: () => controls } } as unknown as BulwarkDesktopBridge);
    return controls;
  }

  const redeem = vi.fn(async () => true);
  const tryPassword = vi.fn(async (): Promise<{ ok: true } | { ok: false; error: 'invalid_credentials' | 'totp_required' | 'other' }> => ({ ok: true }));
  const options = { serverUrl: 'https://mail.example', slot: 1, remember: true, addAccount: false, fresh: false, redeem, tryPassword };

  beforeEach(() => {
    redeem.mockClear();
    tryPassword.mockClear();
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify(ENDPOINTS), { status: 200 })));
  });

  it('runs PKCE with state from main and the loopback redirect, and redeems here, with nothing in an address', async () => {
    const { runDesktopBrowserSignIn } = await import('../browser-sign-in');
    let authorize = new URL('https://x');
    authBridge((url: string) => {
      authorize = new URL(url);
      return { ok: true, code: 'the-code', state: 'main-state' };
    });
    let readBack = {};
    redeem.mockImplementationOnce(async () => {
      readBack = { client: sessionStorage.getItem('oauth_client_id'), slot: sessionStorage.getItem('oauth_cookie_slot'), remember: sessionStorage.getItem('oauth_remember') };
      return true;
    });
    const outcome = await runDesktopBrowserSignIn(options);
    expect(outcome).toEqual({ kind: 'signed-in' });
    expect(authorize.origin + authorize.pathname).toBe('https://mail.example/authorize');
    expect(authorize.searchParams.get('client_id')).toBe('registered-client');
    expect(authorize.searchParams.get('redirect_uri')).toBe(REDIRECT);
    expect(authorize.searchParams.get('state')).toBe('main-state');
    expect(authorize.searchParams.get('code_challenge_method')).toBe('S256');
    expect(authorize.searchParams.get('code_challenge')).toBeTruthy();
    expect(readBack).toEqual({ client: 'registered-client', slot: '1', remember: 'true' });
    const [server, code, verifier, redirect] = redeem.mock.calls[0] as unknown as string[];
    expect([server, code, redirect]).toEqual(['https://mail.example', 'the-code', REDIRECT]);
    // The verifier behind the challenge, kept in this function and nowhere else.
    expect(verifier.length).toBeGreaterThanOrEqual(43);
    expect(authorize.toString()).not.toContain(verifier);
    expect(sessionStorage.getItem('oauth_code_verifier')).toBeNull();
    expect(sessionStorage.getItem('oauth_client_id')).toBeNull();
  });

  it('passes the address typed in the app on as login_hint, and nothing when there is none', async () => {
    const { runDesktopBrowserSignIn } = await import('../browser-sign-in');
    const opened: URL[] = [];
    authBridge((url: string) => {
      opened.push(new URL(url));
      return { ok: false, error: 'cancelled' };
    });
    await runDesktopBrowserSignIn({ ...options, loginHint: 'sam@example.org' });
    await runDesktopBrowserSignIn(options);
    expect(opened.map((url) => url.searchParams.get('login_hint'))).toEqual(['sam@example.org', null]);
  });

  it('refuses an answer another issuer signed', async () => {
    const { runDesktopBrowserSignIn } = await import('../browser-sign-in');
    authBridge({ ok: true, code: 'c', state: 'main-state', iss: 'https://evil.example' });
    expect(await runDesktopBrowserSignIn(options)).toEqual({ kind: 'failed', error: 'issuer_mismatch' });
    expect(redeem).not.toHaveBeenCalled();
  });

  it('asks the provider for a new login when the app says one is due', async () => {
    const { runDesktopBrowserSignIn } = await import('../browser-sign-in');
    let authorize = new URL('https://x');
    authBridge((url: string) => {
      authorize = new URL(url);
      return { ok: false, error: 'cancelled' };
    });
    await runDesktopBrowserSignIn({ ...options, fresh: true });
    expect(authorize.searchParams.get('prompt')).toBe('login');
  });

  it.each(['declined', 'policy', 'invalid'])('takes the no from main: %s, and nothing is asked of the server', async (error) => {
    const { runDesktopBrowserSignIn } = await import('../browser-sign-in');
    const controls = authBridge({ ok: false, error: 'cancelled' });
    controls.begin.mockResolvedValueOnce({ ok: false, error });
    expect((await runDesktopBrowserSignIn(options)).kind).toBe(error);
    expect(controls.complete).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
  });

  it('a timeout is its own answer, so the page can say try again', async () => {
    const { runDesktopBrowserSignIn } = await import('../browser-sign-in');
    authBridge({ ok: false, error: 'timeout' });
    expect((await runDesktopBrowserSignIn(options)).kind).toBe('timeout');
  });

  it('a discovery outage is a failure, not the password page', async () => {
    const { runDesktopBrowserSignIn } = await import('../browser-sign-in');
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status: 503 })));
    const controls = authBridge({ ok: true });
    expect((await runDesktopBrowserSignIn(options)).kind).toBe('failed');
    expect(controls.cancel).toHaveBeenCalledWith('f1');
    expect(controls.beginPassword).not.toHaveBeenCalled();
  });

  it('a server with no OAuth gets the page main serves, and each post goes through the login of the app', async () => {
    const { runDesktopBrowserSignIn } = await import('../browser-sign-in');
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ error: 'no_oauth' }), { status: 404 })));
    const controls = authBridge({ ok: true });
    controls.nextPassword
      .mockResolvedValueOnce({ ok: true, username: 'a', password: 'wrong' })
      .mockResolvedValueOnce({ ok: true, username: 'a', password: 'right', totp: '123456' });
    tryPassword.mockResolvedValueOnce({ ok: false, error: 'invalid_credentials' }).mockResolvedValueOnce({ ok: true });
    expect(await runDesktopBrowserSignIn(options)).toEqual({ kind: 'signed-in' });
    expect(controls.complete).not.toHaveBeenCalled();
    expect(tryPassword.mock.calls.map((call) => (call as unknown[])[0])).toEqual([
      { ok: true, username: 'a', password: 'wrong' },
      { ok: true, username: 'a', password: 'right', totp: '123456' },
    ]);
    expect(controls.answerPassword.mock.calls).toEqual([
      ['f1', { ok: false, error: 'invalid_credentials' }],
      ['f1', { ok: true }],
    ]);
  });

  it('a server that refuses loopback goes by the scheme', async () => {
    const { runDesktopBrowserSignIn } = await import('../browser-sign-in');
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ ...ENDPOINTS, use_scheme: true }), { status: 200 })));
    let authorize = new URL('https://x');
    const controls = authBridge((url: string) => {
      authorize = new URL(url);
      return { ok: true, code: 'c', state: 'main-state' };
    });
    await runDesktopBrowserSignIn(options);
    expect(controls.useScheme).toHaveBeenCalledWith('f1');
    expect(authorize.searchParams.get('redirect_uri')).toBe('bulwark://sign-in/callback');
    expect((redeem.mock.calls[0] as unknown as string[])[3]).toBe('bulwark://sign-in/callback');
  });
});

describe('runInstanceBrowserSignIn', () => {
  const REDIRECT = 'http://127.0.0.1:51234/bulwark-desktop/callback';

  function bridgeWith(complete: (flowId: string, url: string) => unknown) {
    const controls = {
      begin: vi.fn(async () => ({ ok: true, flowId: 'f1', redirectUri: REDIRECT, state: 'main-state' })),
      complete: vi.fn(async (flowId: string, url: string) => complete(flowId, url)),
      cancel: vi.fn(),
    };
    setBridge({ version: 1, platform: 'win32', auth: { claim: () => controls } } as unknown as BulwarkDesktopBridge);
    return controls;
  }

  it('opens the login page of the instance with no secret in the address, and hands back the verifier', async () => {
    const { runInstanceBrowserSignIn } = await import('../browser-sign-in');
    let opened = new URL('https://x');
    bridgeWith((_flow, url) => {
      opened = new URL(url);
      return { ok: true, code: 'the-code', state: 'main-state' };
    });
    const outcome = await runInstanceBrowserSignIn({ base: 'https://bulwark.example/mail', locale: 'de', fresh: false });
    expect(opened.origin + opened.pathname).toBe('https://bulwark.example/mail/de/login');
    expect(opened.searchParams.get('mobile_redirect_uri')).toBe(REDIRECT);
    expect(opened.searchParams.get('mobile_state')).toBe('main-state');
    expect(opened.searchParams.get('mobile_code_challenge')).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(opened.searchParams.has('fresh_login')).toBe(false);
    if (outcome.kind !== 'code') throw new Error(outcome.kind);
    expect(outcome.code).toBe('the-code');
    expect(opened.toString()).not.toContain(outcome.verifier);
    const challenge = Buffer.from(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(outcome.verifier))).toString('base64url');
    expect(opened.searchParams.get('mobile_code_challenge')).toBe(challenge);
  });

  it('hands the address typed in the app to the instance\'s login page', async () => {
    const { runInstanceBrowserSignIn } = await import('../browser-sign-in');
    let opened = new URL('https://x');
    bridgeWith((_flow, url) => {
      opened = new URL(url);
      return { ok: false, error: 'cancelled' };
    });
    await runInstanceBrowserSignIn({ base: 'https://b.example', locale: 'en', fresh: false, loginHint: 'sam@example.org' });
    expect(opened.searchParams.get('login_hint')).toBe('sam@example.org');
  });

  it('passes on that a new login is due, and takes a timeout as a timeout', async () => {
    const { runInstanceBrowserSignIn } = await import('../browser-sign-in');
    let opened = new URL('https://x');
    bridgeWith((_flow, url) => {
      opened = new URL(url);
      return { ok: false, error: 'timeout' };
    });
    expect((await runInstanceBrowserSignIn({ base: 'https://b.example', locale: 'en', fresh: true })).kind).toBe('timeout');
    expect(opened.searchParams.get('fresh_login')).toBe('1');
  });
});

describe('who gets the sign-in calls', () => {
  it('claims them once per bridge, whatever asks after that', async () => {
    const { claimBrowserSignIn } = await import('../browser-sign-in');
    const controls = {};
    const claim = vi.fn(() => controls);
    setBridge({ version: 1, platform: 'win32', auth: { claim } } as unknown as BulwarkDesktopBridge);
    expect(claimBrowserSignIn()).toBe(controls);
    expect(claimBrowserSignIn()).toBe(controls);
    expect(claim).toHaveBeenCalledTimes(1);
  });

  it('offers nothing in a browser, under an older shell, or with the policy off', async () => {
    const { browserSignInAvailable } = await import('../browser-sign-in');
    setBridge(undefined);
    expect(browserSignInAvailable()).toBe(false);
    setBridge({ version: 1, platform: 'win32' } as unknown as BulwarkDesktopBridge);
    expect(browserSignInAvailable()).toBe(false);
    const claim = () => ({});
    setBridge({ version: 1, platform: 'win32', auth: { claim } } as unknown as BulwarkDesktopBridge);
    expect(browserSignInAvailable()).toBe(true);
    const { EMPTY_POLICY_LAYERS, resolvePolicies } = await import('../policy-schema');
    const snapshot = resolvePolicies({ ...EMPTY_POLICY_LAYERS, forcedMachine: { BrowserSignIn: false } });
    setBridge({ version: 1, platform: 'win32', auth: { claim }, policy: { get: () => snapshot, onChange: () => () => {} } } as unknown as BulwarkDesktopBridge);
    expect(browserSignInAvailable()).toBe(false);
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
