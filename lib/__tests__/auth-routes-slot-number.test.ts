// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

// The sign-in routes take the cookie slot from the body only as a whole number
// from 0 up to MAX_ACCOUNT_SLOTS. Cookie names carry the slot as written, and
// readers and sign-outs walk whole numbers: a slot like 1.5 would leave a
// sealed credential behind that signing out everywhere doesn't clear.

vi.mock('@/lib/logger', () => ({
  logger: { warn: vi.fn(), error: vi.fn(), debug: vi.fn(), info: vi.fn() },
}));
vi.mock('@/lib/auth/session-secret', () => ({
  getSessionSecret: () => 's'.repeat(64),
  hasSessionSecret: () => true,
}));
vi.mock('@/lib/telemetry/login-tracker', () => ({ recordLogin: () => {} }));
vi.mock('@/lib/oauth/token-exchange', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/oauth/token-exchange')>()),
  exchangeCodeForTokens: async () => ({ access_token: 'AT', refresh_token: 'RT', expires_in: 3600 }),
}));
vi.mock('@/lib/auth/stalwart-password-login', () => ({
  STALWART_LOOPBACK_REDIRECT_URI: 'http://127.0.0.1/bulwark-webmail/callback',
  stalwartPasswordLogin: async () => ({
    ok: true,
    tokens: { access_token: 'AT', refresh_token: 'RT', expires_in: 3600 },
    tokenEndpoint: 'https://mail.example.org/auth/token',
    clientId: 'bulwark-webmail',
  }),
  stalwartDefaultClientId: async (_serverUrl: string, clientId: string) => clientId,
}));

const SERVER = 'https://mail.example.org';
vi.mock('@/lib/admin/config-manager', () => ({
  configManager: {
    ensureLoaded: async () => {},
    get: (key: string, fallback?: unknown) => (key === 'jmapServerUrl' ? SERVER : key === 'oauthClientId' ? 'webmail' : fallback),
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
const USER = 'user@example.org';
const BASIC = `Basic ${Buffer.from(`${USER}:pw`).toString('base64')}`;

function mailServer(): Promise<Response> {
  return Promise.resolve(Response.json({
    apiUrl: `${SERVER}/jmap/`,
    username: USER,
    accounts: { acc: { name: USER } },
    primaryAccounts: { 'urn:ietf:params:jmap:mail': 'acc' },
  }));
}

async function signOutEverywhere() {
  const { DELETE } = await import('@/app/api/auth/session/route');
  await DELETE(new NextRequest('https://webmail.example/api/auth/session?all=true', { method: 'DELETE', headers: SAME_ORIGIN }));
  const { DELETE: dropTokens } = await import('@/app/api/auth/token/route');
  await dropTokens(new NextRequest('https://webmail.example/api/auth/token?all=true', { method: 'DELETE', headers: SAME_ORIGIN }));
}

/** A sign-in body with `slot` spliced in as raw JSON, so values like -0 and 1e0 arrive as written. */
function withSlot(fields: Record<string, unknown>, slot: string): string {
  return `${JSON.stringify(fields).slice(0, -1)},"slot":${slot}}`;
}

const ROUTES: Array<[string, string, Record<string, unknown>]> = [
  ['POST /api/auth/session', '@/app/api/auth/session/route', { serverUrl: SERVER, username: USER, password: 'pw' }],
  ['POST /api/auth/stalwart-context', '@/app/api/auth/stalwart-context/route', { serverUrl: SERVER, username: USER, authHeader: BASIC }],
  ['POST /api/auth/token', '@/app/api/auth/token/route', { code: 'c', code_verifier: 'v'.repeat(43), redirect_uri: 'https://webmail.example/en/auth/callback' }],
  ['POST /api/auth/totp-token-exchange', '@/app/api/auth/totp-token-exchange/route', { serverUrl: SERVER, username: USER, password: 'pw', totp: '123456' }],
];

async function signIn(module: string, body: string) {
  const { POST } = await import(module);
  const res = await POST(new NextRequest(`https://webmail.example/api/auth/x`, { method: 'POST', headers: SAME_ORIGIN, body }));
  expect(res.status).toBe(200);
}

describe('a slot that is not a whole number', () => {
  beforeEach(() => {
    jar = new Map();
    vi.stubGlobal('fetch', vi.fn(mailServer));
  });
  afterEach(() => vi.unstubAllGlobals());

  it('POST /api/auth/session leaves no cookie that signing out everywhere does not clear', async () => {
    const { POST } = await import('@/app/api/auth/session/route');
    await POST(new NextRequest('https://webmail.example/api/auth/session', {
      method: 'POST',
      headers: SAME_ORIGIN,
      body: JSON.stringify({ serverUrl: SERVER, username: USER, password: 'pw', slot: 1.5 }),
    }));
    await signOutEverywhere();
    expect([...jar.keys()]).toEqual([]);
  });

  it('POST /api/auth/stalwart-context leaves no cookie that signing out everywhere does not clear', async () => {
    const { POST } = await import('@/app/api/auth/stalwart-context/route');
    await POST(new NextRequest('https://webmail.example/api/auth/stalwart-context', {
      method: 'POST',
      headers: SAME_ORIGIN,
      body: JSON.stringify({ serverUrl: SERVER, username: USER, authHeader: BASIC, slot: 2.25 }),
    }));
    await signOutEverywhere();
    expect([...jar.keys()]).toEqual([]);
  });

  for (const [name, module, fields] of ROUTES) {
    it(`${name} writes only whole-number slots, whatever the body says`, async () => {
      for (const slot of ['1.5', '2.25', '-0', '1e0', '"1"', '50', 'null']) {
        jar = new Map();
        await signIn(module, withSlot(fields, slot));
        const names = [...jar.keys()];
        // A slot suffix is a whole number from 1 to 49; slot 0 has none.
        const badSlot = (cookie: string) => /_[^_]*\d[^_]*$/.test(cookie) && !/_(?:[1-9]|[1-4]\d)$/.test(cookie);
        expect(names.filter(badSlot), slot).toEqual([]);
        if (slot === '1e0') expect(names.some((cookie) => cookie.endsWith('_1')), slot).toBe(true);
        await signOutEverywhere();
        expect([...jar.keys()], slot).toEqual([]);
      }
    });
  }

  it('the shared parser takes whole numbers in range only', async () => {
    const { accountSlotFromBody } = await import('@/lib/stalwart/credentials');
    expect(accountSlotFromBody(0)).toBe(0);
    expect(Object.is(accountSlotFromBody(-0), 0)).toBe(true);
    expect(accountSlotFromBody(1e0)).toBe(1);
    expect(accountSlotFromBody(49)).toBe(49);
    for (const value of [Number.NaN, Number.POSITIVE_INFINITY, 1.5, -1, 50, '1', null, undefined, true]) {
      expect(accountSlotFromBody(value), String(value)).toBeNull();
    }
  });
});
