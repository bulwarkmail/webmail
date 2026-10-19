import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The sign-in routes forward the credential to the mail server from this
 * host's address, exactly like the /api/auth/verify pre-check, but had no
 * failure budget: a script posting wrong passwords could trip the mail
 * server's per-address limiter against the webmail and lock everyone out,
 * and use the routes as an unthrottled password oracle. Each client now gets
 * the pre-check's budget, and the client's own address is forwarded upstream
 * so a mail server that trusts this host blames the right party.
 */

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

const cookieSet = vi.fn();
vi.mock('next/headers', () => ({
  cookies: async () => ({ get: () => undefined, set: cookieSet, delete: vi.fn(), getAll: () => [] }),
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

const SERVER = 'https://mail.example.org';
const HOST = 'webmail.example';
const PASSWORD = 'alice-secret';

function json(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json' } });
}

let fetchSpy: ReturnType<typeof vi.spyOn>;
let upstreamCalls: { url: string; init?: RequestInit }[];

/** A mail server with one user; Basic auth for the session routes, the structured login for TOTP. */
function installFakeServer() {
  upstreamCalls = [];
  fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    const url = String(input);
    upstreamCalls.push({ url, init });
    if (url === `${SERVER}/api/auth`) {
      const body = JSON.parse(String(init?.body)) as { accountSecret: string; mfaToken?: string };
      if (body.accountSecret !== PASSWORD) return json({ type: 'failure' });
      if (!body.mfaToken) return json({ type: 'mfaRequired' });
      return json({ type: 'authenticated', client_code: 'code-1' });
    }
    if (url === `${SERVER}/auth/token`) {
      return json({ access_token: 'at', expires_in: 3600, refresh_token: 'rt' });
    }
    const auth = new Headers(init?.headers).get('authorization') || '';
    const [, pass = ''] = Buffer.from(auth.replace(/^Basic\s+/i, ''), 'base64').toString('utf8').split(':');
    if (pass !== PASSWORD) return json({ status: 401 }, 401);
    if (url === `${SERVER}/.well-known/jmap`) {
      return json({ apiUrl: `${SERVER}/jmap/`, username: 'alice@example.org', primaryAccounts: {}, accounts: {} });
    }
    return json({ error: `unexpected ${url}` }, 404);
  });
}

function mockRequest(body: unknown, clientIp?: string) {
  const headers: Record<string, string> = {
    host: HOST,
    origin: `https://${HOST}`,
    'content-type': 'application/json',
    'sec-fetch-site': 'same-origin',
  };
  if (clientIp) headers['x-forwarded-for'] = clientIp;
  return {
    method: 'POST',
    json: async () => body,
    headers: { get: (k: string) => headers[k.toLowerCase()] ?? null },
    nextUrl: { searchParams: new URLSearchParams(), origin: `https://${HOST}` },
  };
}

type RouteResponse = { status: number; headers: Headers; json: () => Promise<{ error?: string; ok?: boolean }> };

async function post(route: string, body: unknown, clientIp?: string) {
  const mod = (await import(/* @vite-ignore */ route)) as { POST: (r: unknown) => Promise<unknown> };
  const res = (await mod.POST(mockRequest(body, clientIp))) as RouteResponse;
  return { status: res.status, retryAfter: res.headers.get('retry-after'), body: await res.json() };
}

const SESSION = '@/app/api/auth/session/route';
const CONTEXT = '@/app/api/auth/stalwart-context/route';
const TOTP = '@/app/api/auth/totp-token-exchange/route';

const basic = (pass: string) => `Basic ${Buffer.from(`alice@example.org:${pass}`).toString('base64')}`;
const sessionBody = (password: string) => ({ serverUrl: SERVER, username: 'alice@example.org', password });
const contextBody = (password: string) => ({ serverUrl: SERVER, username: 'alice@example.org', authHeader: basic(password) });
const totpBody = (password: string, totp?: string) => ({ serverUrl: SERVER, username: 'alice@example.org', password, totp });

beforeEach(() => {
  for (const k of Object.keys(config)) delete config[k];
  config.jmapServerUrl = SERVER;
  cookieSet.mockClear();
  vi.resetModules();
  installFakeServer();
});

afterEach(() => {
  fetchSpy.mockRestore();
});

describe.each([
  ['/api/auth/session', SESSION, sessionBody],
  ['/api/auth/stalwart-context', CONTEXT, contextBody],
])('%s failure budget', (_name, route, body) => {
  it('stops forwarding passwords upstream after five wrong ones from one client', async () => {
    for (let i = 0; i < 5; i++) {
      expect((await post(route, body('wrong'), '198.51.100.7')).status).toBe(401);
    }
    const calls = upstreamCalls.length;
    const over = await post(route, body('wrong'), '198.51.100.7');
    expect(over.status).toBe(429);
    expect(over.body.error).toBe('too_many_attempts');
    expect(Number(over.retryAfter)).toBeGreaterThan(0);
    expect(upstreamCalls.length).toBe(calls);

    // The right password from that client is refused too until the window passes...
    expect((await post(route, body(PASSWORD), '198.51.100.7')).status).toBe(429);
    expect(cookieSet).not.toHaveBeenCalled();
    // ...while another client still signs in.
    expect((await post(route, body(PASSWORD), '198.51.100.8')).status).toBe(200);
  });

  it('does not count right passwords or outages against the budget', async () => {
    for (let i = 0; i < 8; i++) {
      expect((await post(route, body(PASSWORD), '198.51.100.9')).status).toBe(200);
    }
    fetchSpy.mockImplementation(async () => {
      throw new TypeError('fetch failed');
    });
    for (let i = 0; i < 8; i++) {
      expect((await post(route, body('wrong'), '198.51.100.9')).status).not.toBe(429);
    }
  });

  it('forwards the client address upstream, and only a real one', async () => {
    await post(route, body(PASSWORD), '198.51.100.10');
    expect(new Headers(upstreamCalls[0].init?.headers).get('x-forwarded-for')).toBe('198.51.100.10');

    upstreamCalls = [];
    await post(route, body(PASSWORD), 'evil\u0000, not an address');
    expect(new Headers(upstreamCalls[0].init?.headers).get('x-forwarded-for')).toBeNull();

    upstreamCalls = [];
    await post(route, body(PASSWORD));
    expect(new Headers(upstreamCalls[0].init?.headers).get('x-forwarded-for')).toBeNull();
  });
});

describe('/api/auth/totp-token-exchange failure budget', () => {
  it('stops forwarding passwords upstream after five wrong ones from one client', async () => {
    for (let i = 0; i < 5; i++) {
      expect((await post(TOTP, totpBody('wrong'), '198.51.100.7')).body.error).toBe('invalid_credentials');
    }
    const calls = upstreamCalls.length;
    const over = await post(TOTP, totpBody('wrong'), '198.51.100.7');
    expect(over.status).toBe(429);
    expect(over.body.error).toBe('too_many_attempts');
    expect(upstreamCalls.length).toBe(calls);
    expect((await post(TOTP, totpBody(PASSWORD, '123456'), '198.51.100.8')).status).toBe(200);
  });

  it('does not count the TOTP prompt, a successful login or an outage', async () => {
    for (let i = 0; i < 8; i++) {
      expect((await post(TOTP, totpBody(PASSWORD), '198.51.100.9')).body.error).toBe('totp_required');
      expect((await post(TOTP, totpBody(PASSWORD, '123456'), '198.51.100.9')).status).toBe(200);
    }
    fetchSpy.mockImplementation(async () => {
      throw new TypeError('fetch failed');
    });
    for (let i = 0; i < 8; i++) {
      expect((await post(TOTP, totpBody('wrong'), '198.51.100.9')).body.error).toBe('login_unreachable');
    }
  });

  it('forwards the client address on both login steps', async () => {
    await post(TOTP, totpBody(PASSWORD, '123456'), '198.51.100.10');
    expect(upstreamCalls.map((c) => new Headers(c.init?.headers).get('x-forwarded-for'))).toEqual([
      '198.51.100.10',
      '198.51.100.10',
    ]);
  });
});

describe.each([
  ['/api/auth/session', SESSION, sessionBody, sessionBody(PASSWORD)],
  ['/api/auth/stalwart-context', CONTEXT, contextBody, contextBody(PASSWORD)],
  ['/api/auth/totp-token-exchange', TOTP, totpBody, totpBody(PASSWORD, '123456')],
])('%s with LOGIN_RATE_LIMIT_ALLOWLIST', (_name, route, body, rightBody) => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('keeps checking passwords from an allowlisted network past the cap', async () => {
    vi.stubEnv('LOGIN_RATE_LIMIT_ALLOWLIST', '203.0.113.0/24, 2001:db8:1::/48');
    for (let i = 0; i < 8; i++) {
      expect((await post(route, body('wrong'), '203.0.113.40')).status).toBe(401);
      expect((await post(route, body('wrong'), '2001:db8:1::7')).status).toBe(401);
    }
    expect((await post(route, rightBody, '203.0.113.40')).status).toBe(200);
  });

  it('still caps a client outside the allowlist', async () => {
    vi.stubEnv('LOGIN_RATE_LIMIT_ALLOWLIST', '203.0.113.0/24');
    for (let i = 0; i < 5; i++) {
      expect((await post(route, body('wrong'), '198.51.100.7')).status).toBe(401);
    }
    expect((await post(route, body('wrong'), '198.51.100.7')).status).toBe(429);
    expect((await post(route, rightBody, '198.51.100.7')).status).toBe(429);
    expect((await post(route, rightBody, '203.0.113.40')).status).toBe(200);
  });
});
