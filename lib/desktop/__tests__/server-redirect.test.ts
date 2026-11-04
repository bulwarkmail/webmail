// @vitest-environment node
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * An approved server sits inside the SSRF guard, so where it redirects to is the
 * whole question. Real sockets: what counts is who received the request, and
 * whether it carried the user's credentials.
 */

const TRUST_KEY = Symbol.for('bulwark.desktop.trustedJmapOrigins');
const POLICY_KEY = Symbol.for('bulwark.desktop.serverPolicy');
const holder = globalThis as unknown as Record<symbol, unknown>;
const AUTH = `Basic ${Buffer.from('probe@example.org:not-a-real-password').toString('base64')}`;

interface Host {
  origin: string;
  hits: { url: string; auth: boolean }[];
  answer: (req: IncomingMessage, res: ServerResponse) => void;
}

const servers: Server[] = [];

function session(res: ServerResponse) {
  res.writeHead(200, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ apiUrl: '/jmap/', accounts: { a: {} }, primaryAccounts: { 'urn:ietf:params:jmap:mail': 'a' }, username: 'probe@example.org' }));
}

async function host(answer: Host['answer'] = (_req, res) => session(res)): Promise<Host> {
  const self: Host = { origin: '', hits: [], answer };
  const server = createServer((req, res) => {
    self.hits.push({ url: req.url ?? '', auth: !!req.headers.authorization });
    self.answer(req, res);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  servers.push(server);
  self.origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  return self;
}

const redirectTo = (location: string, status = 307): Host['answer'] => (_req, res) => {
  res.writeHead(status, { location });
  res.end();
};

function approve(...origins: string[]) {
  holder[TRUST_KEY] = new Set(origins);
}

beforeEach(() => {
  vi.resetModules();
  delete holder[TRUST_KEY];
  delete holder[POLICY_KEY];
});

afterEach(async () => {
  vi.unstubAllEnvs();
  delete holder[TRUST_KEY];
  delete holder[POLICY_KEY];
  await Promise.all(servers.splice(0).map((server) => new Promise((resolve) => server.close(resolve))));
});

async function verify(server: string) {
  const { fetchJmapSessionIdentity } = await import('@/lib/auth/verify-jmap-auth');
  return fetchJmapSessionIdentity(server, AUTH, { trusted: true });
}

async function fetchVia(url: string, init: RequestInit = {}) {
  const { fetchJmapServer } = await import('@/lib/stalwart/server-fetch');
  return fetchJmapServer(url, { headers: { Authorization: AUTH }, ...init }, true);
}

describe('the desktop build, signing in to an approved server', () => {
  beforeEach(() => vi.stubEnv('NEXT_PUBLIC_BULWARK_DESKTOP', '1'));

  it('follows a redirect on the same origin, as Stalwart answers /.well-known/jmap', async () => {
    const a = await host((req, res) => (req.url === '/.well-known/jmap' ? redirectTo('/jmap/session')(req, res) : session(res)));
    approve(a.origin);
    await expect(verify(a.origin)).resolves.toBeTruthy();
    expect(a.hits).toEqual([{ url: '/.well-known/jmap', auth: true }, { url: '/jmap/session', auth: true }]);
  });

  it('refuses a redirect to a server nobody approved, which gets nothing', async () => {
    const b = await host();
    const a = await host(redirectTo(''));
    a.answer = redirectTo(`${b.origin}/.well-known/jmap`);
    approve(a.origin);
    await expect(verify(a.origin)).rejects.toMatchObject({ name: 'JmapAuthVerificationError', status: 502 });
    expect(b.hits).toEqual([]);
  });

  it('counts another name for the same machine as another server', async () => {
    const b = await host();
    const a = await host(redirectTo(`${b.origin.replace('127.0.0.1', 'localhost')}/x`));
    approve(a.origin);
    await expect(verify(a.origin)).rejects.toMatchObject({ status: 502 });
    expect(b.hits).toEqual([]);
  });

  it('follows one to another approved server', async () => {
    const b = await host();
    const a = await host(redirectTo(`${b.origin}/jmap/session`));
    approve(a.origin, b.origin);
    await expect(verify(a.origin)).resolves.toBeTruthy();
    expect(b.hits).toEqual([{ url: '/jmap/session', auth: true }]);
  });

  it('holds AllowedJmapServers across the redirect, even to an approved server', async () => {
    const b = await host();
    const a = await host(redirectTo(`${b.origin}/jmap/session`));
    approve(a.origin, b.origin);
    holder[POLICY_KEY] = { pluginsMode: 'allowed', pluginAllowlist: [], allowedJmapServers: [a.origin] };
    await expect(verify(a.origin)).rejects.toMatchObject({ status: 502 });
    expect(b.hits).toEqual([]);
  });
});

describe('the desktop build, other requests to an approved server', () => {
  beforeEach(() => vi.stubEnv('NEXT_PUBLIC_BULWARK_DESKTOP', '1'));

  it('follows the same origin', async () => {
    const a = await host((req, res) => (req.url === '/.well-known/jmap' ? redirectTo('/jmap/session')(req, res) : session(res)));
    approve(a.origin);
    expect((await fetchVia(`${a.origin}/.well-known/jmap`)).status).toBe(200);
    expect(a.hits.map((hit) => hit.auth)).toEqual([true, true]);
  });

  it('refuses a server nobody approved, which gets nothing', async () => {
    const b = await host();
    const a = await host(redirectTo(`${b.origin}/x`));
    approve(a.origin);
    await expect(fetchVia(`${a.origin}/y`)).rejects.toThrow();
    expect(b.hits).toEqual([]);
  });

  it('still hands back the redirect when asked to', async () => {
    const b = await host();
    const a = await host(redirectTo(`${b.origin}/x`));
    approve(a.origin);
    expect((await fetchVia(`${a.origin}/y`, { redirect: 'manual' })).status).toBe(307);
    expect(b.hits).toEqual([]);
  });

  it('postJmap keeps to the approved set too', async () => {
    const b = await host();
    const a = await host(redirectTo(`https://127.0.0.1:${new URL(b.origin).port}/jmap/`));
    approve(a.origin);
    const { postJmap } = await import('@/lib/stalwart/jmap-api');
    await expect(postJmap(`${a.origin}/jmap`, AUTH, '{}', { trusted: true })).rejects.toThrow(/untrusted host/);
    expect(b.hits).toEqual([]);
  });
});

describe('which hops count', () => {
  beforeEach(() => vi.stubEnv('NEXT_PUBLIC_BULWARK_DESKTOP', '1'));

  async function refused(from: string, to: string, approved = true) {
    const { desktopRedirectRefused } = await import('../server-redirect');
    return desktopRedirectRefused(from, to, approved);
  }

  it('lets the same host move up to https on the standard ports only', async () => {
    expect(await refused('http://mail.lan/x', 'https://mail.lan/x')).toBe(false);
    expect(await refused('http://mail.lan:8080/x', 'https://mail.lan/x')).toBe(true);
    expect(await refused('http://mail.lan/x', 'https://mail.lan:8443/x')).toBe(true);
    expect(await refused('http://mail.lan/x', 'https://other.lan/x')).toBe(true);
    expect(await refused('https://mail.lan/x', 'http://mail.lan/x')).toBe(true);
  });

  it('leaves a public server to the hop-by-hop guard, but not to the policy', async () => {
    expect(await refused('https://a.example/x', 'https://b.example/x', false)).toBe(false);
    holder[POLICY_KEY] = { pluginsMode: 'allowed', pluginAllowlist: [], allowedJmapServers: ['https://a.example'] };
    expect(await refused('https://a.example/x', 'https://b.example/x', false)).toBe(true);
    expect(await refused('https://a.example/x', 'https://a.example/y', false)).toBe(false);
  });
});

describe('a server install', () => {
  it('follows an admin-configured server as it always did', async () => {
    const b = await host();
    const a = await host(redirectTo(`${b.origin}/jmap/session`));
    approve(a.origin);
    await expect(verify(a.origin)).resolves.toBeTruthy();
    expect(b.hits).toEqual([{ url: '/jmap/session', auth: true }]);
  });

  it('other requests too, where fetch takes the credentials off', async () => {
    const b = await host();
    const a = await host(redirectTo(`${b.origin}/x`));
    expect((await fetchVia(`${a.origin}/y`)).status).toBe(200);
    expect(b.hits).toEqual([{ url: '/x', auth: false }]);
  });

  it('has no opinion on any hop', async () => {
    const { desktopRedirectRefused } = await import('../server-redirect');
    approve();
    holder[POLICY_KEY] = { pluginsMode: 'allowed', pluginAllowlist: [], allowedJmapServers: [] };
    expect(desktopRedirectRefused('http://a.lan/', 'http://169.254.169.254/', true)).toBe(false);
  });
});
