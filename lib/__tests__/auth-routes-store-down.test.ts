// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// With a shared store (#1066) the sign-in limits live in the store. When it
// can't be reached the limits can't be counted, and a limit that can't be
// counted must refuse, never let the attempt through to the mail server.

vi.mock('next/server', () => ({
  NextResponse: {
    json: (data: unknown, init?: { status?: number; headers?: Record<string, string> }) => ({
      json: async () => data,
      status: init?.status ?? 200,
      headers: new Headers(init?.headers),
    }),
  },
}));

vi.mock('@/lib/logger', () => ({
  logger: { warn: vi.fn(), error: vi.fn(), debug: vi.fn(), info: vi.fn() },
}));

vi.mock('next/headers', () => ({
  cookies: async () => ({ get: () => undefined, set: vi.fn(), delete: vi.fn(), getAll: () => [] }),
}));

const config: Record<string, unknown> = {};
vi.mock('@/lib/admin/config-manager', () => ({
  configManager: {
    ensureLoaded: async () => {},
    get: (key: string, fallback: unknown) => (key in config ? config[key] : fallback),
  },
}));

vi.mock('@/lib/auth/crypto', () => ({
  encryptSession: () => 'encrypted-session',
  decryptSession: () => null,
  decryptPayload: () => null,
  encryptPayload: () => 'encrypted',
}));

vi.mock('@/lib/stalwart/auth-context', () => ({
  setStalwartAuthContext: vi.fn(),
  setStalwartAuthContextInStore: vi.fn(),
  clearStalwartAuthContextInStore: vi.fn(),
  readStalwartAuthContextFromStore: () => null,
}));

vi.mock('@/lib/telemetry/login-tracker', () => ({ recordLogin: vi.fn() }));

import { setStoreForTests } from '@/lib/shared-store';
import { resetLocalStoreForTests } from '@/lib/shared-store/local';
import { switchableSharedStore } from './helpers/shared-store-down';

const SERVER = 'https://mail.example.org';
const HOST = 'webmail.example';
const CHALLENGE = 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM';

function request(body: unknown) {
  const headers: Record<string, string> = {
    host: HOST,
    origin: `https://${HOST}`,
    'content-type': 'application/json',
    'sec-fetch-site': 'same-origin',
    'x-forwarded-for': '198.51.100.7',
  };
  return {
    method: 'POST',
    json: async () => body,
    headers: { get: (k: string) => headers[k.toLowerCase()] ?? null },
    nextUrl: { searchParams: new URLSearchParams(), origin: `https://${HOST}` },
  };
}

type RouteResponse = { status: number; headers: Headers; json: () => Promise<Record<string, unknown>> };

async function post(route: string, body: unknown) {
  const mod = (await import(/* @vite-ignore */ route)) as { POST: (r: unknown) => Promise<unknown> };
  const res = (await mod.POST(request(body))) as RouteResponse;
  return { status: res.status, retryAfter: res.headers.get('retry-after'), body: await res.json() };
}

let store: ReturnType<typeof switchableSharedStore>;
let fetchSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  for (const k of Object.keys(config)) delete config[k];
  config.jmapServerUrl = SERVER;
  vi.resetModules();
  resetLocalStoreForTests();
  store = switchableSharedStore();
  store.down = true;
  setStoreForTests(store);
  fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => new Response('{}', { status: 401 }));
});

afterEach(() => {
  fetchSpy.mockRestore();
  setStoreForTests(null);
  resetLocalStoreForTests();
});

const basic = `Basic ${Buffer.from('alice@example.org:secret').toString('base64')}`;

describe('sign-in routes while the shared store is down', () => {
  it.each([
    ['/api/auth/session', '@/app/api/auth/session/route', { serverUrl: SERVER, username: 'alice@example.org', password: 'secret' }],
    ['/api/auth/stalwart-context', '@/app/api/auth/stalwart-context/route', { serverUrl: SERVER, username: 'alice@example.org', authHeader: basic }],
    ['/api/auth/totp-token-exchange', '@/app/api/auth/totp-token-exchange/route', { serverUrl: SERVER, username: 'alice@example.org', password: 'secret' }],
  ])('%s refuses with 503 and sends nothing upstream', async (_name, route, body) => {
    const res = await post(route, body);
    expect(res.status).toBe(503);
    expect(res.retryAfter).toBe('10');
    expect(res.body.error).toBe('temporarily_unavailable');
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('the login pre-check answers inconclusive and sends nothing upstream', async () => {
    const res = await post('@/app/api/auth/verify/route', { serverUrl: SERVER, username: 'alice', password: 'secret' });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ result: 'inconclusive' });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('the mobile hand-off neither parks nor redeems a sign-in', async () => {
    const created = await post('@/app/api/auth/handoff/create/route', {
      code_challenge: CHALLENGE,
      state: 's',
      server_url: SERVER,
      username: 'alice@example.org',
      password: 'secret',
    });
    expect(created.status).toBe(503);
    const redeemed = await post('@/app/api/auth/handoff/redeem/route', { code: 'a'.repeat(64), code_verifier: 'v'.repeat(43) });
    expect(redeemed.status).toBe(503);
  });

  it('QR pairing answers 503 to the phone and the desktop, not an expired code', async () => {
    vi.stubEnv('SESSION_SECRET', 'a-test-session-secret-of-at-least-32-chars');
    const redeemed = await post('@/app/api/auth/pair/redeem/route', { pairing_code: 'a'.repeat(64) });
    expect(redeemed.status).toBe(503);
    const { GET } = await import('@/app/api/auth/pair/status/route');
    const status = (await GET({ nextUrl: { searchParams: new URLSearchParams({ id: 'b'.repeat(32) }) } } as never)) as unknown as RouteResponse;
    expect(status.status).toBe(503);
    vi.unstubAllEnvs();
  });

  it('signs in again once the store is back', async () => {
    store.down = false;
    const res = await post('@/app/api/auth/session/route', { serverUrl: SERVER, username: 'alice@example.org', password: 'secret' });
    // The fake mail server refuses every password: the attempt got through to it.
    expect(res.status).toBe(401);
    expect(fetchSpy).toHaveBeenCalled();
  });
});

describe('mobile hand-off redeem when the store fails after the budget was counted', () => {
  it('gives the attempt back, so outages do not lock the app out', async () => {
    store.down = false;
    vi.stubEnv('SESSION_SECRET', 'a-test-session-secret-of-at-least-32-chars');
    const take = vi.spyOn(store.kv, 'take').mockRejectedValue(Object.assign(new Error('down (test)'), { name: 'StoreUnavailableError' }));
    for (let i = 0; i < 12; i++) {
      expect((await post('@/app/api/auth/handoff/redeem/route', { code: 'a'.repeat(64), code_verifier: 'v'.repeat(43) })).status).toBe(503);
    }
    take.mockRestore();
    const res = await post('@/app/api/auth/handoff/redeem/route', { code: 'a'.repeat(64), code_verifier: 'v'.repeat(43) });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('invalid_code');
    vi.unstubAllEnvs();
  });
});
