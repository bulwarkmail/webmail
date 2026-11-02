// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

// The mobile app has no webmail session, only a JMAP access token for the
// configured mail server. GET /api/admin/policy checks that token against the
// server's JMAP session and answers what a signed-in user of that account
// gets; anything else gets the public subset, as before.

vi.mock('@/lib/auth/instance-details', () => ({
  canSeeInstanceDetails: async () => false,
  signedInIdentity: async () => null,
}));

const config = vi.hoisted(() => ({ values: {} as Record<string, unknown> }));
const SCOPES = [
  { id: 'two', label: 'Two', match: { domains: ['org-two.test'] }, policy: { features: { calendarEnabled: false } } },
  { id: 'acme', label: 'Acme', match: { domains: ['example.org'] }, policy: {} },
];
vi.mock('@/lib/admin/config-manager', () => ({
  configManager: {
    ensureLoaded: async () => {},
    get: (key: string, fallback: unknown) => (key in config.values ? config.values[key] : fallback),
    getPolicy: () => ({
      restrictions: {}, features: {}, defaults: {}, themePolicy: {},
      forceEnabledPlugins: ['acme-crm'], approvedPlugins: [], forceEnabledThemes: [],
      pushRelays: [{ url: 'https://relay.example.org' }],
      organisation: { disclaimer: { html: '<p>Acme GmbH</p>', text: 'Acme GmbH' } },
      scopes: SCOPES,
    }),
    getPolicyWithVersion() { return { policy: this.getPolicy(), version: 'v1' }; },
  },
}));
const logs = vi.hoisted(() => ({ calls: [] as unknown[][] }));
vi.mock('@/lib/logger', () => {
  const record = (...args: unknown[]) => { logs.calls.push(args); };
  return { logger: { error: record, warn: record, info: record, debug: record } };
});
vi.mock('@/lib/admin/session', () => ({
  requireAdminAuth: vi.fn(),
  getClientIP: (request: Request) => request.headers.get('x-forwarded-for') ?? '0.0.0.0',
}));
vi.mock('@/lib/admin/audit', () => ({ auditLog: vi.fn() }));

import { GET } from '@/app/api/admin/policy/route';
import { resetBearerIdentityCacheForTests } from '@/lib/auth/bearer-identity';
import { setStoreForTests } from '@/lib/shared-store';
import { resetLocalStoreForTests } from '@/lib/shared-store/local';
import { switchableSharedStore } from '@/lib/__tests__/helpers/shared-store-down';

const SERVER = 'https://mail.example.org';
const GOOD_TOKEN = 'good-token-abc';

const fetchMock = vi.fn();

function sessionResponse(username: string, accountName = username): Response {
  return new Response(JSON.stringify({
    apiUrl: `${SERVER}/jmap/`,
    username,
    primaryAccounts: { 'urn:ietf:params:jmap:mail': 'a1' },
    accounts: { a1: { name: accountName }, shared: { name: 'boss@org-two.test' } },
  }), { status: 200, headers: { 'content-type': 'application/json' } });
}

let ip = 0;
let clientIp = '';

async function get(headers: Record<string, string> = {}) {
  const res = await GET(new NextRequest('https://webmail.example/api/admin/policy', {
    headers: { 'x-forwarded-for': clientIp, ...headers },
  }));
  return { status: res.status, body: await res.json(), domains: res.headers.get('x-bulwark-policy-domains'), scope: res.headers.get('x-bulwark-policy-scope') };
}

beforeEach(() => {
  resetBearerIdentityCacheForTests();
  config.values = { jmapServerUrl: SERVER, jmapServers: [] };
  logs.calls = [];
  ip += 1;
  clientIp = `198.51.100.${ip}`;
  fetchMock.mockReset().mockImplementation(async (_url: string, init: RequestInit) => {
    const auth = new Headers(init.headers).get('authorization');
    return auth === `Bearer ${GOOD_TOKEN}` ? sessionResponse('alice@example.org') : new Response('', { status: 401 });
  });
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('GET /api/admin/policy with a Bearer token', () => {
  it('answers a valid token like a signed-in user of its account', async () => {
    const res = await get({ authorization: `Bearer ${GOOD_TOKEN}` });
    expect(res.status).toBe(200);
    expect(res.body.organisation.disclaimer.text).toBe('Acme GmbH');
    expect(res.body.scopes.map((s: { id: string }) => s.id)).toEqual(['acme']);
    expect(res.body.forceEnabledPlugins).toEqual(['acme-crm']);
    expect(res.body.pushRelays).toHaveLength(1);
    expect(res.domains).toBe('example.org');
    expect(res.scope).toBeNull();

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe(`${SERVER}/.well-known/jmap`);
    expect(new Headers(init.headers).get('authorization')).toBe(`Bearer ${GOOD_TOKEN}`);
    expect(new Headers(init.headers).get('x-forwarded-for')).toBe(clientIp);
  });

  it('takes the primary mail account name as an address too, but not shared accounts', async () => {
    fetchMock.mockResolvedValueOnce(sessionResponse('alice', 'alice@org-two.test'));
    const res = await get({ authorization: `Bearer ${GOOD_TOKEN}` });
    expect(res.body.scopes.map((s: { id: string }) => s.id)).toEqual(['two']);
    expect(res.domains).toBe('org-two.test');
  });

  it('answers a token the server refuses with the public subset', async () => {
    const res = await get({ authorization: 'Bearer stolen-or-expired' });
    expect(res.status).toBe(200);
    expect(res.body.organisation).toBeUndefined();
    expect(res.body.scopes).toEqual([]);
    expect(res.body.forceEnabledPlugins).toEqual([]);
    expect(res.scope).toBe('public');
  });

  it('does not accept Basic credentials', async () => {
    const basic = Buffer.from('alice@example.org:secret').toString('base64');
    const res = await get({ authorization: `Basic ${basic}` });
    expect(res.body.organisation).toBeUndefined();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('checks a token once and answers from the cache after that', async () => {
    await get({ authorization: `Bearer ${GOOD_TOKEN}` });
    const again = await get({ authorization: `Bearer ${GOOD_TOKEN}` });
    expect(again.body.organisation.disclaimer.text).toBe('Acme GmbH');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('checks the token again once the cached answer is old', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      await get({ authorization: `Bearer ${GOOD_TOKEN}` });
      vi.setSystemTime(Date.now() + 61_000);
      await get({ authorization: `Bearer ${GOOD_TOKEN}` });
      expect(fetchMock).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it('never sends the token to a server the request names', async () => {
    const res = await get({ authorization: `Bearer ${GOOD_TOKEN}`, 'x-jmap-server-url': 'https://evil.example' });
    expect(res.body.organisation).toBeUndefined();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('lets the request pick one of the configured servers', async () => {
    config.values = {
      jmapServerUrl: '',
      jmapServers: [
        { id: 'a', label: 'A', url: 'https://a.example.org' },
        { id: 'b', label: 'B', url: 'https://b.example.org' },
      ],
    };
    const res = await get({ authorization: `Bearer ${GOOD_TOKEN}`, 'x-jmap-server-url': 'https://B.example.org/' });
    expect(res.body.organisation.disclaimer.text).toBe('Acme GmbH');
    expect(fetchMock.mock.calls[0][0]).toBe('https://b.example.org/.well-known/jmap');
  });

  it('does not guess between several configured servers', async () => {
    config.values = {
      jmapServerUrl: '',
      jmapServers: [
        { id: 'a', label: 'A', url: 'https://a.example.org' },
        { id: 'b', label: 'B', url: 'https://b.example.org' },
      ],
    };
    const res = await get({ authorization: `Bearer ${GOOD_TOKEN}` });
    expect(res.body.organisation).toBeUndefined();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('stops checking tokens from a client after ten refused ones', async () => {
    for (let i = 0; i < 10; i++) await get({ authorization: `Bearer wrong-${i}` });
    expect(fetchMock).toHaveBeenCalledTimes(10);
    const res = await get({ authorization: `Bearer ${GOOD_TOKEN}` });
    expect(res.body.organisation).toBeUndefined();
    expect(fetchMock).toHaveBeenCalledTimes(10);
  });

  it('answers the public subset when the server is unreachable, and logs no token', async () => {
    fetchMock.mockRejectedValueOnce(Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' }));
    const res = await get({ authorization: `Bearer ${GOOD_TOKEN}` });
    expect(res.status).toBe(200);
    expect(res.body.organisation).toBeUndefined();
    expect(logs.calls.length).toBeGreaterThan(0);
    expect(JSON.stringify(logs.calls)).not.toContain(GOOD_TOKEN);
  });
});

describe('GET /api/admin/policy with a Bearer token while the shared store is down (#1066)', () => {
  afterEach(() => {
    setStoreForTests(null);
    resetLocalStoreForTests();
  });

  it('answers 503: the refused-token budget can not be counted, so the token is not checked', async () => {
    const store = switchableSharedStore();
    store.down = true;
    setStoreForTests(store);
    const res = await get({ authorization: `Bearer ${GOOD_TOKEN}` });
    expect(res.status).toBe(503);
    expect(fetchMock).not.toHaveBeenCalled();
    // Without a token the public subset needs no store.
    expect((await get()).status).toBe(200);
  });
});
