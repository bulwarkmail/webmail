// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

/**
 * What the desktop app asks before it sends someone to a server's own sign-in page: the
 * authorize endpoint and a client id, and which redirect that server will take.
 */

vi.mock('@/lib/logger', () => ({ logger: { warn: vi.fn(), error: vi.fn(), debug: vi.fn(), info: vi.fn() } }));
vi.mock('@/lib/admin/config-manager', () => ({
  configManager: { ensureLoaded: async () => {}, get: (key: string, fallback: unknown) => (key === 'allowCustomJmapEndpoint' ? true : fallback) },
}));
vi.mock('@/lib/oauth/custom-upstream', () => ({
  resolveCustomUpstream: async (serverUrl: string, clientId: string) => (serverUrl.startsWith('https://') ? { serverUrl, clientId, trusted: false } : null),
}));
const discoverOAuth = vi.hoisted(() => vi.fn());
vi.mock('@/lib/oauth/discovery', () => ({ discoverOAuth }));
vi.mock('@/lib/oauth/token-exchange', () => ({ getDiscoveryValidator: () => undefined }));

const SERVER = 'https://mail.example';
const REDIRECT = 'http://127.0.0.1:51234/bulwark-desktop/callback';
const METADATA = { issuer: SERVER, authorization_endpoint: `${SERVER}/login`, token_endpoint: `${SERVER}/auth/token` };

let registrations: { url: string; redirect: string }[];
let answer: (redirect: string) => Response;

function post(body: unknown) {
  return new NextRequest(`https://app.bulwark.localhost/api/auth/desktop-oauth`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'sec-fetch-site': 'same-origin' },
    body: JSON.stringify(body),
  });
}

async function route() {
  vi.stubEnv('NEXT_PUBLIC_BULWARK_DESKTOP', '1');
  vi.resetModules();
  return (await import('@/app/api/auth/desktop-oauth/route')).POST;
}

beforeEach(() => {
  registrations = [];
  discoverOAuth.mockReset().mockResolvedValue(METADATA);
  answer = () => new Response(JSON.stringify({ client_id: 'swc1.abc' }), { status: 201 });
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const redirect = (JSON.parse(String(init?.body)) as { redirect_uris: string[] }).redirect_uris[0];
    registrations.push({ url: String(input), redirect });
    return answer(redirect);
  }));
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe('/api/auth/desktop-oauth', () => {
  it('registers the loopback redirect, with no port: servers ignore the port', async () => {
    const POST = await route();
    const res = await POST(post({ serverUrl: SERVER, redirectUri: REDIRECT }));
    expect(await res.json()).toMatchObject({ authorization_endpoint: `${SERVER}/login`, client_id: 'swc1.abc', issuer: SERVER });
    expect(registrations).toEqual([{ url: `${SERVER}/auth/register`, redirect: 'http://127.0.0.1/bulwark-desktop/callback' }]);
  });

  it('uses the registration endpoint the server names', async () => {
    discoverOAuth.mockResolvedValue({ ...METADATA, registration_endpoint: `${SERVER}/oauth/clients` });
    const POST = await route();
    await POST(post({ serverUrl: SERVER, redirectUri: REDIRECT }));
    expect(registrations[0].url).toBe(`${SERVER}/oauth/clients`);
  });

  it('says so when a server has no OAuth', async () => {
    discoverOAuth.mockResolvedValue(null);
    const POST = await route();
    const res = await POST(post({ serverUrl: SERVER, redirectUri: REDIRECT }));
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: 'no_oauth' });
  });

  it('a discovery outage is not the same answer', async () => {
    discoverOAuth.mockRejectedValue(new Error('down'));
    const POST = await route();
    expect((await POST(post({ serverUrl: SERVER, redirectUri: REDIRECT }))).status).toBe(503);
  });

  it('with registration off, sends the fixed id and the loopback redirect', async () => {
    answer = () => new Response('{}', { status: 401 });
    const POST = await route();
    const body = await (await POST(post({ serverUrl: SERVER, redirectUri: REDIRECT }))).json();
    expect(body.client_id).toBe('bulwark-desktop');
    expect(body.use_scheme).toBeUndefined();
    expect(registrations).toHaveLength(1);
  });

  it('takes the scheme only from a server that refuses loopback by name and accepts the scheme', async () => {
    answer = (redirect) => (redirect.startsWith('bulwark:')
      ? new Response(JSON.stringify({ client_id: 'schemed' }), { status: 201 })
      : new Response(JSON.stringify({ error: 'invalid_redirect_uri' }), { status: 400 }));
    const POST = await route();
    const body = await (await POST(post({ serverUrl: SERVER, redirectUri: REDIRECT }))).json();
    expect(body).toMatchObject({ client_id: 'schemed', use_scheme: true });
    expect(registrations.map((r) => r.redirect)).toEqual(['http://127.0.0.1/bulwark-desktop/callback', 'bulwark://sign-in/callback']);
  });

  it('stays on loopback when the server refuses both', async () => {
    answer = () => new Response(JSON.stringify({ error: 'invalid_redirect_uri' }), { status: 400 });
    const POST = await route();
    const body = await (await POST(post({ serverUrl: SERVER, redirectUri: REDIRECT }))).json();
    expect(body.client_id).toBe('bulwark-desktop');
    expect(body.use_scheme).toBeUndefined();
  });

  it.each(['http://localhost:51234/bulwark-desktop/callback', 'https://evil.example/bulwark-desktop/callback', 'bulwark://sign-in/callback'])('refuses %s as the redirect', async (redirectUri) => {
    const POST = await route();
    expect((await POST(post({ serverUrl: SERVER, redirectUri }))).status).toBe(400);
    expect(registrations).toEqual([]);
  });
});
