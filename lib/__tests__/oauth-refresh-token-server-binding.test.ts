// @vitest-environment node
import { createHash } from 'node:crypto';
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

// A refresh token is only ever sent to the server that issued it, for renewal
// and for revocation. The server is recorded in the token's sealed sign-in
// stamp; the plain jmap_rts cookie only repeats it, and a cookie that says
// otherwise is refused. A password + two-factor sign-in to a server the user
// typed (allowCustomJmapEndpoint) is renewed at that server, not the default.

vi.mock('@/lib/logger', () => ({
  logger: { warn: vi.fn(), error: vi.fn(), debug: vi.fn(), info: vi.fn() },
}));
vi.mock('@/lib/auth/session-secret', () => ({
  getSessionSecret: () => 's'.repeat(64),
  hasSessionSecret: () => true,
}));
vi.mock('@/lib/telemetry/login-tracker', () => ({ recordLogin: () => {} }));
// Every host in this test counts as a public address.
vi.mock('@/lib/security/url-guard', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/security/url-guard')>()),
  isPublicHttpUrl: async () => true,
}));
// The sign-in itself is not under test: the typed server accepts the password and code.
vi.mock('@/lib/auth/stalwart-password-login', () => ({
  STALWART_LOOPBACK_REDIRECT_URI: 'http://127.0.0.1/bulwark-webmail/callback',
  stalwartPasswordLogin: async (opts: { serverUrl: string }) => ({
    ok: true,
    tokens: { access_token: 'AT-OWN', refresh_token: 'RT-OWN-SERVER', expires_in: 3600 },
    tokenEndpoint: `${opts.serverUrl}/auth/token`,
    clientId: 'bulwark-webmail',
  }),
  stalwartDefaultClientId: async (_serverUrl: string, clientId: string) => clientId,
}));

let config: Record<string, unknown> = {};
vi.mock('@/lib/admin/config-manager', () => ({
  configManager: {
    ensureLoaded: async () => {},
    get: (key: string, fallback?: unknown) => (key in config ? config[key] : fallback),
    getPolicy: () => ({}),
  },
}));

let jar = new Map<string, string>();
vi.mock('next/headers', () => ({
  cookies: async () => ({
    get: (name: string) => (jar.has(name) ? { name, value: jar.get(name)! } : undefined),
    set: (name: string, value: string) => { jar.set(name, value); },
    delete: (name: string | { name: string }) => { jar.delete(typeof name === 'string' ? name : name.name); },
    getAll: () => [...jar].map(([name, value]) => ({ name, value })),
  }),
}));

const SAME_ORIGIN = { 'sec-fetch-site': 'same-origin', 'sec-fetch-mode': 'cors', 'sec-fetch-dest': 'empty', 'content-type': 'application/json' };

/** Every request body a host received, by host. */
let received: Array<{ host: string; path: string; body: string }>;

/** Each host is its own OAuth provider with endpoints on its own origin. */
function providers(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const url = new URL(String(input));
  const body = typeof init?.body === 'string' ? init.body : '';
  received.push({ host: url.host, path: url.pathname, body });
  if (url.pathname.startsWith('/.well-known/')) {
    return Promise.resolve(Response.json({
      issuer: url.origin,
      authorization_endpoint: `${url.origin}/authorize`,
      token_endpoint: `${url.origin}/auth/token`,
      revocation_endpoint: `${url.origin}/auth/revoke`,
    }));
  }
  if (url.pathname === '/auth/token') {
    const params = new URLSearchParams(body);
    if (params.get('grant_type') === 'authorization_code') {
      return Promise.resolve(Response.json({ access_token: `AT-${url.host}`, refresh_token: `RT-ISSUED-BY-${url.host}`, expires_in: 3600 }));
    }
    return Promise.resolve(Response.json({ access_token: `AT2-${url.host}`, refresh_token: params.get('refresh_token'), expires_in: 3600 }));
  }
  if (url.pathname === '/auth/revoke') return Promise.resolve(new Response(null, { status: 200 }));
  return Promise.resolve(new Response('not found', { status: 404 }));
}

async function renew() {
  const { PUT } = await import('@/app/api/auth/token/route');
  return PUT(new NextRequest('https://webmail.example/api/auth/token?slot=0&force=true', { method: 'PUT', headers: SAME_ORIGIN }));
}

const sentTo = (host: string, token: string) => received.filter((r) => r.host === host && r.body.includes(token));
const sentAnywhere = (token: string) => received.filter((r) => r.body.includes(token));

const TWO_SERVERS = {
  jmapServers: [
    { id: 'a', label: 'A', url: 'https://a.example', oauth: { clientId: 'webmail-a' } },
    { id: 'b', label: 'B', url: 'https://b.example', oauth: { clientId: 'webmail-b' } },
  ],
};

/** A provider sign-in at server entry `a`, as the page-driven flow completes it. */
async function signInAtA() {
  const { POST } = await import('@/app/api/auth/token/route');
  const signIn = await POST(new NextRequest('https://webmail.example/api/auth/token', {
    method: 'POST',
    headers: SAME_ORIGIN,
    body: JSON.stringify({ code: 'c', code_verifier: 'v'.repeat(43), redirect_uri: 'https://webmail.example/en/auth/callback', server_id: 'a', slot: 0 }),
  }));
  expect(signIn.status).toBe(200);
  expect(jar.get('jmap_rt')).toBe('RT-ISSUED-BY-a.example');
  expect(jar.get('jmap_rts')).toBe('a');
}

// Every test loads the routes afresh (vi.resetModules), which takes a while.
vi.setConfig({ testTimeout: 30_000 });

describe('a refresh token only goes to the server that issued it', () => {
  beforeEach(() => {
    vi.resetModules();
    jar = new Map();
    received = [];
    config = {};
    vi.stubGlobal('fetch', vi.fn(providers));
  });
  afterEach(() => vi.unstubAllGlobals());

  it('not to another listed server when the jmap_rts cookie is changed; the renewal sets the cookie back', async () => {
    config = TWO_SERVERS;
    await signInAtA();

    // One cookie overwritten from outside the app.
    jar.set('jmap_rts', 'b');
    received = [];
    const res = await renew();

    expect(sentTo('b.example', 'RT-ISSUED-BY-a.example')).toEqual([]);
    expect(res.status).toBe(200);
    expect(sentTo('a.example', 'RT-ISSUED-BY-a.example')).toEqual([expect.objectContaining({ path: '/auth/token' })]);
    expect(jar.get('jmap_rts')).toBe('a');
  });

  it('renews at the server that issued it, also after its token rotated and the cookie changed', async () => {
    config = TWO_SERVERS;
    await signInAtA();
    received = [];
    expect((await renew()).status).toBe(200);
    expect(sentTo('a.example', 'RT-ISSUED-BY-a.example')).toHaveLength(1);
    // The rotated token keeps the binding (the stub hands back the same token,
    // so the kept redemption is dropped to make the second one go out).
    (await import('@/lib/oauth/slot-renewal')).resetRedemptionsForTests();
    jar.set('jmap_rts', 'b');
    received = [];
    expect((await renew()).status).toBe(200);
    expect(sentTo('b.example', 'RT-ISSUED-BY-a.example')).toEqual([]);
    expect(sentTo('a.example', 'RT-ISSUED-BY-a.example')).toHaveLength(1);
  });

  it('is not revoked at another server when signing out with a changed cookie', async () => {
    config = TWO_SERVERS;
    await signInAtA();
    jar.set('jmap_rts', 'b');
    received = [];
    const { DELETE } = await import('@/app/api/auth/token/route');
    const res = await DELETE(new NextRequest('https://webmail.example/api/auth/token?slot=0', { method: 'DELETE', headers: SAME_ORIGIN }));
    expect(res.status).toBe(200);
    expect(sentTo('b.example', 'RT-ISSUED-BY-a.example')).toEqual([]);
    expect(sentTo('a.example', 'RT-ISSUED-BY-a.example')).toEqual([expect.objectContaining({ path: '/auth/revoke' })]);
    expect(jar.has('jmap_rt')).toBe(false);
  });

  it('is revoked at the server that issued it on sign-out (control)', async () => {
    config = TWO_SERVERS;
    await signInAtA();
    received = [];
    const { DELETE } = await import('@/app/api/auth/token/route');
    await DELETE(new NextRequest('https://webmail.example/api/auth/token?slot=0', { method: 'DELETE', headers: SAME_ORIGIN }));
    expect(sentTo('a.example', 'RT-ISSUED-BY-a.example')).toEqual([
      expect.objectContaining({ path: '/auth/revoke' }),
    ]);
  });

  it('starts a re-authentication only at the server that issued the token', async () => {
    config = TWO_SERVERS;
    await signInAtA();
    const { POST: start } = await import('@/app/api/auth/sso/start/route');
    const reauth = () => start(new NextRequest('https://webmail.example/api/auth/sso/start', {
      method: 'POST',
      headers: { ...SAME_ORIGIN, origin: 'https://webmail.example' },
      body: JSON.stringify({ redirect_uri: 'https://webmail.example/en/auth/callback', purpose: 'reauth', slot: 0 }),
    }));
    const honest = await reauth();
    expect(new URL((await honest.json()).authorize_url).host).toBe('a.example');

    jar.set('jmap_rts', 'b');
    const changed = await reauth();
    expect(new URL((await changed.json()).authorize_url).host).toBe('a.example');
  });

  it('is not renewed at another server by the push preview', async () => {
    config = TWO_SERVERS;
    await signInAtA();
    jar.set('jmap_rts', 'b');
    received = [];
    const { renewPushAuthHeader } = await import('@/lib/stalwart/push-token-renewal');
    const store = await (await import('next/headers')).cookies();
    const renewed = await renewPushAuthHeader(store as never, 0, {
      serverUrl: 'https://a.example',
      username: 'me@a.example',
      authHeader: 'Bearer AT-a.example',
    }, undefined);
    expect(renewed).toBe('Bearer AT2-a.example');
    expect(sentTo('b.example', 'RT-ISSUED-BY-a.example')).toEqual([]);
  });

  it('takes the cookie once for a stamp from before it named the server, then keeps to it', async () => {
    config = TWO_SERVERS;
    const { writeSignInStamp } = await import('@/lib/auth/session-age');
    const store = await (await import('next/headers')).cookies();
    jar.set('jmap_rt', 'RT-ISSUED-BY-a.example');
    jar.set('jmap_rts', 'a');
    writeSignInStamp(store as never, 0, { signedInAt: Date.now(), refreshToken: 'RT-ISSUED-BY-a.example', remember: true });

    expect((await renew()).status).toBe(200);
    expect(sentTo('a.example', 'RT-ISSUED-BY-a.example')).toHaveLength(1);

    (await import('@/lib/oauth/slot-renewal')).resetRedemptionsForTests();
    jar.set('jmap_rts', 'b');
    received = [];
    expect((await renew()).status).toBe(200);
    expect(sentTo('b.example', 'RT-ISSUED-BY-a.example')).toEqual([]);
    expect(sentTo('a.example', 'RT-ISSUED-BY-a.example')).toHaveLength(1);
  });

  it('is not sent anywhere without a stamp when its cookie names a listed server', async () => {
    config = TWO_SERVERS;
    jar.set('jmap_rt', 'RT-ISSUED-BY-a.example');
    jar.set('jmap_rts', 'b');
    const res = await renew();
    expect(res.status).toBe(401);
    expect(sentAnywhere('RT-ISSUED-BY-a.example')).toEqual([]);
  });

  it('is not sent anywhere without a stamp when a typed server is recorded for the slot', async () => {
    config = { jmapServerUrl: 'https://default.example', oauthClientId: 'webmail', allowCustomJmapEndpoint: true };
    const { writeCustomUpstream } = await import('@/lib/oauth/custom-upstream');
    const store = await (await import('next/headers')).cookies();
    jar.set('jmap_rt', 'RT-OWN-SERVER');
    writeCustomUpstream(store as never, 0, { serverUrl: 'https://own.example', clientId: 'bulwark-webmail' }, true);
    const res = await renew();
    expect(res.status).toBe(401);
    expect(sentAnywhere('RT-OWN-SERVER')).toEqual([]);
  });

  it('renews at the configured server without a stamp when the slot names no other server', async () => {
    // A sign-in from before stamps, or one whose stamp the session secret no longer opens.
    config = { ...TWO_SERVERS, jmapServerUrl: 'https://default.example', oauthClientId: 'webmail', allowCustomJmapEndpoint: true };
    jar.set('jmap_rt', 'RT-ISSUED-BY-default.example');
    jar.set('jmap_signed_in', 'sealed-with-an-earlier-secret');
    const res = await renew();
    expect(res.status).toBe(200);
    expect(sentTo('default.example', 'RT-ISSUED-BY-default.example')).toEqual([expect.objectContaining({ path: '/auth/token' })]);
    expect(sentAnywhere('RT-ISSUED-BY-default.example').filter((r) => r.host !== 'default.example')).toEqual([]);

    // The renewal stamps the token with the configured server; a cookie set afterwards changes nothing.
    jar.set('jmap_rts', 'b');
    received = [];
    await renew();
    expect(sentTo('b.example', 'RT-ISSUED-BY-default.example')).toEqual([]);
  });

  it('is not sent to the configured server once its own server is no longer listed', async () => {
    config = { ...TWO_SERVERS, jmapServerUrl: 'https://default.example', oauthClientId: 'webmail' };
    await signInAtA();
    config = { jmapServers: [TWO_SERVERS.jmapServers[1]], jmapServerUrl: 'https://default.example', oauthClientId: 'webmail' };
    received = [];
    expect((await renew()).status).toBe(401);
    expect(sentAnywhere('RT-ISSUED-BY-a.example')).toEqual([]);
  });

  it('keeps working on a single-server instance, which writes no jmap_rts', async () => {
    config = { jmapServerUrl: 'https://single.example', oauthClientId: 'webmail' };
    const { POST } = await import('@/app/api/auth/token/route');
    const signIn = await POST(new NextRequest('https://webmail.example/api/auth/token', {
      method: 'POST',
      headers: SAME_ORIGIN,
      body: JSON.stringify({ code: 'c', code_verifier: 'v'.repeat(43), redirect_uri: 'https://webmail.example/en/auth/callback', slot: 0 }),
    }));
    expect(signIn.status).toBe(200);
    expect(jar.has('jmap_rts')).toBe(false);
    received = [];
    expect((await renew()).status).toBe(200);
    expect(sentTo('single.example', 'RT-ISSUED-BY-single.example')).toHaveLength(1);
  });

  it('not to the default server after a two-factor sign-in to a typed server', async () => {
    config = { jmapServerUrl: 'https://default.example', allowCustomJmapEndpoint: true };
    await twoFactorSignIn('https://own.example');

    received = [];
    const res = await renew();

    expect(sentTo('default.example', 'RT-OWN-SERVER')).toEqual([]);
    // It is renewed where it came from, with no configured secret.
    expect(res.status).toBe(200);
    expect(sentTo('own.example', 'RT-OWN-SERVER')).toEqual([expect.objectContaining({ path: '/auth/token' })]);
  });

  it('is revoked at the typed server on sign-out', async () => {
    config = { jmapServerUrl: 'https://default.example', allowCustomJmapEndpoint: true, oauthClientSecret: 'admin-secret' };
    await twoFactorSignIn('https://own.example');
    received = [];
    const { DELETE } = await import('@/app/api/auth/token/route');
    await DELETE(new NextRequest('https://webmail.example/api/auth/token?slot=0', { method: 'DELETE', headers: SAME_ORIGIN }));
    expect(sentTo('default.example', 'RT-OWN-SERVER')).toEqual([]);
    expect(sentTo('own.example', 'RT-OWN-SERVER')).toEqual([expect.objectContaining({ path: '/auth/revoke' })]);
    expect(received.some((r) => r.body.includes('admin-secret'))).toBe(false);
    expect(jar.has('jmap_rtu')).toBe(false);
  });

  it('is renewed nowhere once typed servers are no longer allowed, and the slot is signed out', async () => {
    config = { jmapServerUrl: 'https://default.example', allowCustomJmapEndpoint: true };
    await twoFactorSignIn('https://own.example');
    config = { jmapServerUrl: 'https://default.example' };
    received = [];
    const res = await renew();
    expect(res.status).toBe(401);
    expect(sentAnywhere('RT-OWN-SERVER')).toEqual([]);
    expect(jar.has('jmap_rt')).toBe(false);
  });

  it('is renewed nowhere when the record of the typed server is gone', async () => {
    config = { jmapServerUrl: 'https://default.example', allowCustomJmapEndpoint: true };
    await twoFactorSignIn('https://own.example');
    jar.delete('jmap_rtu');
    received = [];
    expect((await renew()).status).toBe(401);
    expect(sentAnywhere('RT-OWN-SERVER')).toEqual([]);
  });

  it('leaves a later sign-in to the configured server with the configured server', async () => {
    config = { jmapServerUrl: 'https://default.example', allowCustomJmapEndpoint: true };
    await twoFactorSignIn('https://own.example');
    // The record of the typed server stays behind; the next sign-in is not one.
    await twoFactorSignIn('https://default.example');
    received = [];
    expect((await renew()).status).toBe(200);
    expect(sentTo('own.example', 'RT-OWN-SERVER')).toEqual([]);
    expect(sentTo('default.example', 'RT-OWN-SERVER')).toHaveLength(1);
  });

  it("renews the desktop app's browser sign-in to a typed server at that server", async () => {
    config = { jmapServerUrl: 'https://default.example', allowCustomJmapEndpoint: true };
    const { stashHandoff } = await import('@/lib/auth/handoff-store');
    const verifier = 'v'.repeat(64);
    const code = await stashHandoff({
      flow: 'desktop-tokens',
      server_url: 'https://own.example',
      server_id: null,
      custom: true,
      password_login: true,
      username: 'me@own.example',
      access_token: 'AT-OWN',
      refresh_token: 'RT-OWN-SERVER',
      expires_in: 3600,
      signed_in_at: Date.now(),
    }, { challenge: createHash('sha256').update(verifier, 'ascii').digest('base64url'), state: 's' });
    const { POST } = await import('@/app/api/auth/desktop-handoff/redeem/route');
    const redeemed = await POST(new NextRequest('https://webmail.example/api/auth/desktop-handoff/redeem', {
      method: 'POST',
      headers: SAME_ORIGIN,
      body: JSON.stringify({ code, code_verifier: verifier, slot: 0, remember: true, allowed_servers: null, custom_servers_allowed: true }),
    }));
    expect(redeemed.status).toBe(200);
    expect(jar.get('jmap_rt')).toBe('RT-OWN-SERVER');

    received = [];
    expect((await renew()).status).toBe(200);
    expect(sentTo('default.example', 'RT-OWN-SERVER')).toEqual([]);
    expect(sentTo('own.example', 'RT-OWN-SERVER')).toHaveLength(1);
  });
});

/** A password + two-factor sign-in to `serverUrl`, which the stubbed server accepts. */
async function twoFactorSignIn(serverUrl: string) {
  const { POST } = await import('@/app/api/auth/totp-token-exchange/route');
  const signIn = await POST(new NextRequest('https://webmail.example/api/auth/totp-token-exchange', {
    method: 'POST',
    headers: SAME_ORIGIN,
    body: JSON.stringify({ serverUrl, username: 'me@own.example', password: 'pw', totp: '123456', slot: 0 }),
  }));
  expect(signIn.status).toBe(200);
  expect(jar.get('jmap_rt')).toBe('RT-OWN-SERVER');
}
