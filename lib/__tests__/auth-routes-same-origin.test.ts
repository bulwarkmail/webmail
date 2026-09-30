import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

/**
 * GHSA-qvr9-m8cq-7wvg: the unauthenticated /api/auth/* routes write
 * SameSite=Lax identity cookies from the request body. A cross-site
 * `<form enctype="text/plain">` auto-submitted by an attacker page reaches
 * them with a body `request.json()` accepts, so every mutating handler has
 * to refuse requests that do not come from our own origin.
 */

vi.mock('next/server', () => ({
  NextResponse: {
    json: (data: unknown, init?: { status?: number }) => ({
      json: async () => data,
      status: init?.status ?? 200,
    }),
  },
}));

vi.mock('@/lib/logger', () => ({
  logger: { warn: vi.fn(), error: vi.fn(), debug: vi.fn(), info: vi.fn() },
}));

const cookieSet = vi.fn();
const cookieDelete = vi.fn();
vi.mock('next/headers', () => ({
  cookies: async () => ({
    get: () => undefined,
    set: cookieSet,
    delete: cookieDelete,
    getAll: () => [],
  }),
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

const setStalwartAuthContextInStore = vi.fn();
vi.mock('@/lib/stalwart/auth-context', () => ({
  setStalwartAuthContextInStore: (...args: unknown[]) => setStalwartAuthContextInStore(...args),
  clearStalwartAuthContextInStore: vi.fn(),
}));

vi.mock('@/lib/telemetry/login-tracker', () => ({
  recordLogin: vi.fn(),
}));

const TRUSTED = 'https://mail.example.org';
const HOST = 'victim.example';

type HeaderMap = Record<string, string>;

/** Headers a browser attaches to a top-level cross-site form submission. */
const CROSS_SITE_FORM: HeaderMap = {
  host: HOST,
  origin: 'https://attacker.test',
  'content-type': 'text/plain;charset=UTF-8',
  'sec-fetch-site': 'cross-site',
  'sec-fetch-mode': 'navigate',
  'sec-fetch-dest': 'document',
};

/** Headers a same-origin fetch() from the webmail SPA carries. */
const SAME_ORIGIN_FETCH: HeaderMap = {
  host: HOST,
  origin: `https://${HOST}`,
  'content-type': 'application/json',
  'sec-fetch-site': 'same-origin',
  'sec-fetch-mode': 'cors',
  'sec-fetch-dest': 'empty',
};

function mockRequest(method: string, headers: HeaderMap, body: unknown) {
  const lower: HeaderMap = {};
  for (const [k, v] of Object.entries(headers)) lower[k.toLowerCase()] = v;
  const json = vi.fn(async () => body);
  return {
    request: {
      method,
      json,
      headers: { get: (k: string) => lower[k.toLowerCase()] ?? null },
      nextUrl: { searchParams: new URLSearchParams(), origin: `https://${HOST}` },
    },
    json,
  };
}

type RouteResponse = { status: number; json: () => Promise<{ error?: string; ok?: boolean }> };

const SESSION_BODY = {
  serverUrl: TRUSTED,
  username: 'mallory@evil.test',
  password: 'x',
  slot: 0,
};

async function postSession(headers: HeaderMap) {
  const { POST } = await import('@/app/api/auth/session/route');
  const { request, json } = mockRequest('POST', headers, SESSION_BODY);
  const res = (await POST(request as unknown as Parameters<typeof POST>[0])) as unknown as RouteResponse;
  return { status: res.status, body: await res.json(), json };
}

describe('isSameOriginRequest', () => {
  async function check(method: string, headers: HeaderMap) {
    const { isSameOriginRequest } = await import('@/lib/security/same-origin');
    return isSameOriginRequest(mockRequest(method, headers, {}).request as unknown as Request);
  }

  it('rejects a top-level cross-site form POST', async () => {
    expect(await check('POST', CROSS_SITE_FORM)).toBe(false);
  });

  it('rejects same-site (sibling subdomain) requests', async () => {
    expect(await check('POST', { ...CROSS_SITE_FORM, 'sec-fetch-site': 'same-site' })).toBe(false);
  });

  it('accepts a same-origin fetch()', async () => {
    expect(await check('POST', SAME_ORIGIN_FETCH)).toBe(true);
  });

  it('falls back to Origin vs Host for browsers without Sec-Fetch-Site', async () => {
    expect(await check('POST', { host: HOST, origin: `https://${HOST}` })).toBe(true);
    expect(await check('POST', { host: HOST, origin: 'https://attacker.test' })).toBe(false);
    expect(await check('POST', { host: HOST, 'x-forwarded-host': 'mail.example.org', origin: 'https://mail.example.org' })).toBe(true);
    expect(await check('POST', { origin: 'not a url' })).toBe(false);
  });

  it('accepts non-browser clients that send neither header', async () => {
    expect(await check('POST', { host: HOST })).toBe(true);
  });

  it('never blocks safe methods', async () => {
    expect(await check('GET', CROSS_SITE_FORM)).toBe(true);
    expect(await check('HEAD', CROSS_SITE_FORM)).toBe(true);
    expect(await check('OPTIONS', CROSS_SITE_FORM)).toBe(true);
  });
});

describe('POST /api/auth/session (GHSA-qvr9-m8cq-7wvg session fixation)', () => {
  let fetchSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    for (const k of Object.keys(config)) delete config[k];
    config.jmapServerUrl = TRUSTED;
    cookieSet.mockClear();
    setStalwartAuthContextInStore.mockClear();
    vi.resetModules();
    // The route now verifies the credential upstream even for the configured
    // server (GHSA-wxcm-j4jc-9fxq); stand in for a server that accepts it.
    fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(
        JSON.stringify({ apiUrl: `${TRUSTED}/jmap/`, username: SESSION_BODY.username, accounts: {} }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      ),
    );
  });

  afterEach(() => {
    fetchSpy.mockRestore();
  });

  it('refuses a cross-site form POST before reading the body and writes no cookie', async () => {
    const { status, body, json } = await postSession(CROSS_SITE_FORM);
    expect(status).toBe(403);
    expect(body.error).toMatch(/cross-origin/i);
    expect(json).not.toHaveBeenCalled();
    expect(cookieSet).not.toHaveBeenCalled();
    expect(setStalwartAuthContextInStore).not.toHaveBeenCalled();
  });

  it('refuses a legacy-browser POST whose Origin does not match Host', async () => {
    const { status } = await postSession({ host: HOST, origin: 'https://attacker.test' });
    expect(status).toBe(403);
    expect(cookieSet).not.toHaveBeenCalled();
  });

  it('still serves the same-origin login fetch from the SPA', async () => {
    const { status, body } = await postSession(SAME_ORIGIN_FETCH);
    expect(status).toBe(200);
    expect(body.ok).toBe(true);
    expect(cookieSet).toHaveBeenCalledTimes(1);
    expect(setStalwartAuthContextInStore).toHaveBeenCalledTimes(1);
  });

  it('still serves native clients that send no browser headers', async () => {
    const { status } = await postSession({ host: HOST, 'content-type': 'application/json' });
    expect(status).toBe(200);
    expect(cookieSet).toHaveBeenCalledTimes(1);
  });
});

/**
 * Every mutating handler under /api/auth must short-circuit with 403 for a
 * cross-site request without touching the body. The list is the full set of
 * non-GET exports under app/api/auth at the time of the fix; add new routes
 * here as they appear.
 */
const MUTATING_HANDLERS: Array<[string, string]> = [
  ['@/app/api/auth/session/route', 'POST'],
  ['@/app/api/auth/session/route', 'DELETE'],
  ['@/app/api/auth/stalwart-context/route', 'POST'],
  ['@/app/api/auth/totp-token-exchange/route', 'POST'],
  ['@/app/api/auth/token/route', 'POST'],
  ['@/app/api/auth/token/route', 'PUT'],
  ['@/app/api/auth/token/route', 'DELETE'],
  ['@/app/api/auth/pair/create/route', 'POST'],
  ['@/app/api/auth/pair/redeem/route', 'POST'],
  ['@/app/api/auth/pair/token/route', 'POST'],
  ['@/app/api/auth/sso/start/route', 'POST'],
  ['@/app/api/auth/sso/complete/route', 'POST'],
  ['@/app/api/auth/reauth/sso/complete/route', 'POST'],
  ['@/app/api/auth/verify/route', 'POST'],
];

describe('every mutating /api/auth handler rejects cross-site requests', () => {
  beforeEach(() => {
    cookieSet.mockClear();
    cookieDelete.mockClear();
    vi.resetModules();
  });

  for (const [modulePath, method] of MUTATING_HANDLERS) {
    it(`${method} ${modulePath.replace('@/app', '')}`, async () => {
      const mod = (await import(modulePath)) as Record<string, (req: unknown) => Promise<RouteResponse>>;
      const handler = mod[method];
      expect(typeof handler).toBe('function');
      const { request, json } = mockRequest(method, CROSS_SITE_FORM, { anything: 'goes' });
      const res = await handler(request);
      expect(res.status).toBe(403);
      expect(json).not.toHaveBeenCalled();
      expect(cookieSet).not.toHaveBeenCalled();
      expect(cookieDelete).not.toHaveBeenCalled();
    });
  }
});
