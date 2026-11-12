// @vitest-environment node
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

// The plain cookies next to a refresh token (the server id, the record of a
// typed server) can be written by someone who can't read them or seal
// anything. They never send the token to a server other than the one that
// issued it, which the token's sealed sign-in stamp names.

vi.mock('@/lib/logger', () => ({
  logger: { warn: vi.fn(), error: vi.fn(), debug: vi.fn(), info: vi.fn() },
}));
vi.mock('@/lib/auth/session-secret', () => ({
  getSessionSecret: () => 's'.repeat(64),
  hasSessionSecret: () => true,
}));
// Every host in this test counts as a public address.
vi.mock('@/lib/security/url-guard', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/security/url-guard')>()),
  isPublicHttpUrl: async () => true,
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

async function renew(slot = 0) {
  const { PUT } = await import('@/app/api/auth/token/route');
  return PUT(new NextRequest(`https://webmail.example/api/auth/token?slot=${slot}&force=true`, { method: 'PUT', headers: SAME_ORIGIN }));
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

describe('the cookies next to a refresh token', () => {
  beforeEach(() => {
    vi.resetModules();
    jar = new Map();
    received = [];
    config = {};
    vi.stubGlobal('fetch', vi.fn(providers));
  });
  afterEach(() => vi.unstubAllGlobals());

  it('do not send it to a typed server named by a record that sits next to a stamp from before it named the server', async () => {
    config = { jmapServerUrl: 'https://default.example', oauthClientId: 'webmail', allowCustomJmapEndpoint: true };
    const { writeSignInStamp } = await import('@/lib/auth/session-age');
    const { writeCustomUpstream } = await import('@/lib/oauth/custom-upstream');
    const store = await (await import('next/headers')).cookies();
    // A sign-in at the configured server, with a stamp as written before
    // stamps named the server.
    jar.set('jmap_rt', 'RT-ISSUED-BY-default.example');
    writeSignInStamp(store as never, 0, { signedInAt: Date.now(), refreshToken: 'RT-ISSUED-BY-default.example', remember: true });
    // A sealed record of another browser's sign-in to a server it typed.
    writeCustomUpstream(store as never, 0, { serverUrl: 'https://typed.example', clientId: 'typed-client' }, true);

    expect((await renew()).status).toBe(200);
    expect(sentTo('typed.example', 'RT-ISSUED-BY-default.example')).toEqual([]);
    expect(sentTo('default.example', 'RT-ISSUED-BY-default.example')).toHaveLength(1);

    // The renewal's stamp names the configured server, so the record stays ignored.
    received = [];
    expect((await renew()).status).toBe(200);
    expect(sentTo('typed.example', 'RT-ISSUED-BY-default.example')).toEqual([]);
  });

  it('do not send it elsewhere when the token and its stamp are moved to a slot whose cookie names another server', async () => {
    config = TWO_SERVERS;
    await signInAtA();
    jar.set('jmap_rt_1', jar.get('jmap_rt')!);
    jar.set('jmap_signed_in_1', jar.get('jmap_signed_in')!);
    jar.set('jmap_rts_1', 'b');
    received = [];
    await renew(1);
    expect(sentAnywhere('RT-ISSUED-BY-a.example').filter((r) => r.host !== 'a.example')).toEqual([]);
  });
});
