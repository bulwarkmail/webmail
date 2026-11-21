// @vitest-environment node
//
// GET /api/admin/policy checks a Bearer token at the mail server. A token the
// server refuses can count there as a failed login from the webmail's own
// address, and the client address the webmail keys its budget on can be made
// up (X-Forwarded-For on an instance without a proxy in front) or rotated. So
// refused tokens stop being checked past a ceiling across all addresses: 20
// per 15 minutes, as for stored credentials. Past it a token that can't be
// checked gets 503 with Retry-After, without asking the mail server: the app
// keeps its cached full policy on an error, where a public answer would
// replace it. A token that checked out before is remembered (up to its
// lifetime or an hour) and still answered in full. A valid token is never
// counted. A value that can't be a token is not asked about at all.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

vi.mock('@/lib/auth/session-secret', () => ({ getSessionSecret: () => 's'.repeat(64), hasSessionSecret: () => true }));
vi.mock('@/lib/auth/instance-details', () => ({
  canSeeInstanceDetails: async () => false,
  signedInIdentity: async () => null,
}));
const config = vi.hoisted(() => ({ values: {} as Record<string, unknown> }));
vi.mock('@/lib/admin/config-manager', () => ({
  configManager: {
    ensureLoaded: async () => {},
    get: (key: string, fallback: unknown) => (key in config.values ? config.values[key] : fallback),
    getPolicy: () => ({
      restrictions: {}, features: {}, defaults: {}, themePolicy: {},
      forceEnabledPlugins: ['acme-crm'], approvedPlugins: [], forceEnabledThemes: [], scopes: [],
    }),
    getPolicyWithVersion() { return { policy: this.getPolicy(), version: 'v1' }; },
  },
}));
vi.mock('@/lib/logger', () => ({ logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() } }));
vi.mock('@/lib/admin/session', () => ({
  requireAdminAuth: vi.fn(),
  getClientIP: (request: Request) => request.headers.get('x-forwarded-for') ?? '0.0.0.0',
}));
vi.mock('@/lib/admin/audit', () => ({ auditLog: vi.fn() }));

type Route = typeof import('@/app/api/admin/policy/route');
let GET: Route['GET'];
let resetBearerIdentityCacheForTests: () => void;

const SERVER = 'https://mail.example.org';
const GOOD_TOKEN = 'good-token-abc-0123456789';
const fetchMock = vi.fn();

/** A made-up token long enough to be one, that the mail server refuses. */
const wrong = (i: number) => `wrong-token-${i}-0123456789`;

async function get(address: string, token: string) {
  const res = await GET(new NextRequest('https://webmail.example/api/admin/policy', {
    headers: { 'x-forwarded-for': address, authorization: `Bearer ${token}` },
  }));
  return {
    status: res.status,
    scope: res.headers.get('x-bulwark-policy-scope'),
    retryAfter: res.headers.get('retry-after'),
    body: await res.json(),
  };
}

const address = (i: number) => `203.0.${Math.floor(i / 250)}.${i % 250}`;

beforeEach(async () => {
  // A fresh module each time: the refused-token budget lives in its memory.
  vi.resetModules();
  ({ GET } = await import('@/app/api/admin/policy/route'));
  ({ resetBearerIdentityCacheForTests } = await import('@/lib/auth/bearer-identity'));
  (await import('@/lib/shared-store/local')).resetLocalStoreForTests();
  config.values = { jmapServerUrl: SERVER, jmapServers: [] };
  fetchMock.mockReset().mockImplementation(async (_url: string, init: RequestInit) => {
    const auth = new Headers(init.headers).get('authorization');
    if (auth !== `Bearer ${GOOD_TOKEN}`) return new Response('', { status: 401 });
    return new Response(JSON.stringify({
      apiUrl: `${SERVER}/jmap/`, username: 'alice@example.org',
      primaryAccounts: { 'urn:ietf:params:jmap:mail': 'a1' }, accounts: { a1: { name: 'alice@example.org' } },
    }), { status: 200, headers: { 'content-type': 'application/json' } });
  });
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('refused Bearer tokens on GET /api/admin/policy', () => {
  it('stops trying refused tokens at the mail server, however many addresses they come from', async () => {
    for (let i = 0; i < 300; i++) await get(address(i), wrong(i));
    expect(fetchMock.mock.calls.length).toBeLessThanOrEqual(100);
  });

  it('tries at most 20 refused tokens per window across all addresses', async () => {
    for (let i = 0; i < 60; i++) await get(address(i), wrong(i));
    expect(fetchMock).toHaveBeenCalledTimes(20);
  });

  it('still answers a valid token from a client that sent none of the refused ones', async () => {
    for (let i = 0; i < 5; i++) await get(`203.0.113.${i}`, wrong(i));
    const res = await get('198.51.100.77', GOOD_TOKEN);
    expect(res.status).toBe(200);
    expect(res.scope).not.toBe('public');
    expect(res.body.forceEnabledPlugins).toEqual(['acme-crm']);
  });

  it('answers 503 with Retry-After for a token it can no longer check, never the public policy', async () => {
    for (let i = 0; i < 20; i++) await get(address(i), wrong(i));
    fetchMock.mockClear();
    const res = await get('198.51.100.78', GOOD_TOKEN);
    expect(res.status).toBe(503);
    expect(res.scope).toBeNull();
    expect(res.body.forceEnabledPlugins).toBeUndefined();
    expect(Number(res.retryAfter)).toBeGreaterThan(0);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('still answers a request without a token with the public policy (the login page)', async () => {
    for (let i = 0; i < 20; i++) await get(address(i), wrong(i));
    const res = await GET(new NextRequest('https://webmail.example/api/admin/policy', { headers: { 'x-forwarded-for': '198.51.100.80' } }));
    expect(res.status).toBe(200);
    expect(res.headers.get('x-bulwark-policy-scope')).toBe('public');
  });

  it('answers a token that checked out before in full past the ceiling, without asking the mail server', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      expect((await get('198.51.100.81', GOOD_TOKEN)).scope).toBeNull();
      // Past the minute the check is kept for, and past the ceiling.
      vi.setSystemTime(Date.now() + 5 * 60_000);
      for (let i = 0; i < 20; i++) await get(address(i), wrong(i));
      fetchMock.mockClear();
      const res = await get('198.51.100.81', GOOD_TOKEN);
      expect(res.status).toBe(200);
      expect(res.body.forceEnabledPlugins).toEqual(['acme-crm']);
      expect(fetchMock).not.toHaveBeenCalled();
      // Not past an hour.
      vi.setSystemTime(Date.now() + 61 * 60_000);
      for (let i = 0; i < 20; i++) await get(address(100 + i), wrong(100 + i));
      expect((await get('198.51.100.81', GOOD_TOKEN)).status).toBe(503);
    } finally {
      vi.useRealTimers();
    }
  });

  it('remembers a token no longer than the end it names', async () => {
    const b64 = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');
    const jwt = `${b64({ alg: 'none' })}.${b64({ exp: Math.floor(Date.now() / 1000) + 120 })}.c2lnbmF0dXJl`;
    fetchMock.mockImplementation(async (_url: string, init: RequestInit) => {
      if (new Headers(init.headers).get('authorization') !== `Bearer ${jwt}`) return new Response('', { status: 401 });
      return new Response(JSON.stringify({
        apiUrl: `${SERVER}/jmap/`, username: 'alice@example.org',
        primaryAccounts: { 'urn:ietf:params:jmap:mail': 'a1' }, accounts: { a1: { name: 'alice@example.org' } },
      }), { status: 200, headers: { 'content-type': 'application/json' } });
    });
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      expect((await get('198.51.100.82', jwt)).status).toBe(200);
      vi.setSystemTime(Date.now() + 3 * 60_000);
      for (let i = 0; i < 20; i++) await get(address(i), wrong(i));
      expect((await get('198.51.100.82', jwt)).status).toBe(503);
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not count valid tokens against the ceiling', async () => {
    for (let i = 0; i < 50; i++) {
      resetBearerIdentityCacheForTests();
      expect((await get(address(i), GOOD_TOKEN)).scope).toBeNull();
    }
    fetchMock.mockClear();
    for (let i = 0; i < 30; i++) await get(address(100 + i), wrong(i));
    expect(fetchMock).toHaveBeenCalledTimes(20);
  });

  it('does not ask the mail server about a value that cannot be a token, nor count it', async () => {
    const junk = ['x', 'null', 'undefined', 'short-token', 'has spaces? no: has"quotes"-and-more', 'ümlaut-token-0123456789', 'a'.repeat(15)];
    for (let i = 0; i < 100; i++) {
      const res = await get(address(i), junk[i % junk.length]);
      expect(res.scope).toBe('public');
      expect(res.retryAfter).toBeNull();
    }
    expect(fetchMock).not.toHaveBeenCalled();
    expect((await get('198.51.100.79', GOOD_TOKEN)).scope).toBeNull();
  });
});
