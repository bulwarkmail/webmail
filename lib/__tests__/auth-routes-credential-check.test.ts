import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * GHSA-wxcm-j4jc-9fxq: /api/auth/session and /api/auth/stalwart-context used
 * to mint the encrypted identity cookies for any username when the requested
 * server was the admin-configured one, without checking the credential
 * upstream. Routes that trust the cookie's username claim without contacting
 * the mail server (settings sync, plugin-approval attribution) then accepted
 * the forged identity. Both routes must now verify upstream and bind the
 * username to the credential before writing anything.
 */

vi.mock('next/server', () => ({
  NextResponse: {
    json: (data: unknown, init?: { status?: number }) => ({
      json: async () => data,
      status: init?.status ?? 200,
    }),
  },
}));

const loggerWarn = vi.hoisted(() => vi.fn());
vi.mock('@/lib/logger', () => ({
  logger: { warn: loggerWarn, error: vi.fn(), debug: vi.fn(), info: vi.fn() },
}));

const cookieSet = vi.fn();
vi.mock('next/headers', () => ({
  cookies: async () => ({
    get: () => undefined,
    set: cookieSet,
    delete: vi.fn(),
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

const encryptSession = vi.fn((..._args: unknown[]) => 'encrypted-session');
vi.mock('@/lib/auth/crypto', () => ({
  encryptSession: (...args: unknown[]) => encryptSession(...args),
  decryptSession: () => null,
  decryptPayload: () => null,
  encryptPayload: () => 'encrypted',
}));

const setStalwartAuthContext = vi.fn();
const setStalwartAuthContextInStore = vi.fn();
vi.mock('@/lib/stalwart/auth-context', () => ({
  setStalwartAuthContext: (...args: unknown[]) => setStalwartAuthContext(...args),
  setStalwartAuthContextInStore: (...args: unknown[]) => setStalwartAuthContextInStore(...args),
  clearStalwartAuthContextInStore: vi.fn(),
}));

const recordLogin = vi.fn();
vi.mock('@/lib/telemetry/login-tracker', () => ({
  recordLogin: (...args: unknown[]) => recordLogin(...args),
}));

const SERVER = 'https://mail.example.org';
const HOST = 'webmail.example';

/** The mail server as the routes see it: who exists, and which token is whose. */
const PASSWORDS: Record<string, string> = {
  'alice@example.org': 'alice-secret',
  'mallory@example.org': 'mallory-secret',
  // OAuth/SSO login name that differs from the primary identity e-mail.
  'lrath': 'linus-secret',
};
const TOKENS: Record<string, string> = {
  'tok-mallory': 'mallory@example.org',
  'tok-linus': 'lrath',
};
const IDENTITY_EMAILS: Record<string, string[]> = {
  'mallory@example.org': ['mallory@example.org'],
  'lrath': ['linus@example.org'],
};

function json(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json' } });
}

function authenticate(init?: RequestInit): string | null {
  const auth = new Headers(init?.headers).get('authorization') || '';
  const basic = /^Basic\s+(\S+)$/i.exec(auth);
  if (basic) {
    const [user, pass] = Buffer.from(basic[1], 'base64').toString('utf8').split(':');
    return PASSWORDS[user] === pass ? user : null;
  }
  const bearer = /^Bearer\s+(\S+)$/i.exec(auth);
  if (bearer) return TOKENS[bearer[1]] ?? null;
  return null;
}

let fetchSpy: ReturnType<typeof vi.spyOn>;
let identityGetCalls: number;

function installFakeServer() {
  identityGetCalls = 0;
  fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    const url = String(input);
    const user = authenticate(init);
    if (!user) {
      return json({ type: 'about:blank', status: 401, title: 'Unauthorized' }, 401);
    }
    if (url === `${SERVER}/.well-known/jmap`) {
      return json({
        // Advertised on a hostname this process cannot resolve, like Stalwart does.
        apiUrl: 'https://stwtest.local/jmap/',
        username: user,
        primaryAccounts: { 'urn:ietf:params:jmap:mail': 'c' },
        accounts: { c: { name: user } },
      });
    }
    if (url === `${SERVER}/jmap/` && init?.method === 'POST') {
      identityGetCalls++;
      const list = (IDENTITY_EMAILS[user] ?? []).map((email, i) => ({ id: `i${i}`, email, name: user }));
      return json({ methodResponses: [['Identity/get', { accountId: 'c', list, notFound: [] }, '0']] });
    }
    return json({ error: `unexpected ${init?.method ?? 'GET'} ${url}` }, 404);
  });
}

type HeaderMap = Record<string, string>;
const SAME_ORIGIN_FETCH: HeaderMap = {
  host: HOST,
  origin: `https://${HOST}`,
  'content-type': 'application/json',
  'sec-fetch-site': 'same-origin',
  'sec-fetch-mode': 'cors',
  'sec-fetch-dest': 'empty',
};

function mockRequest(body: unknown) {
  return {
    method: 'POST',
    json: async () => body,
    headers: { get: (k: string) => SAME_ORIGIN_FETCH[k.toLowerCase()] ?? null },
    nextUrl: { searchParams: new URLSearchParams(), origin: `https://${HOST}` },
  };
}

type RouteResponse = {
  status: number;
  json: () => Promise<{ error?: string; ok?: boolean; code?: string; hint?: string; warning?: string }>;
};

async function postSession(body: unknown) {
  const { POST } = await import('@/app/api/auth/session/route');
  const res = (await POST(mockRequest(body) as unknown as Parameters<typeof POST>[0])) as unknown as RouteResponse;
  return { status: res.status, body: await res.json() };
}

async function postContext(body: unknown) {
  const { POST } = await import('@/app/api/auth/stalwart-context/route');
  const res = (await POST(mockRequest(body) as unknown as Parameters<typeof POST>[0])) as unknown as RouteResponse;
  return { status: res.status, body: await res.json() };
}

function basic(user: string, pass: string): string {
  return `Basic ${Buffer.from(`${user}:${pass}`).toString('base64')}`;
}

beforeEach(() => {
  for (const k of Object.keys(config)) delete config[k];
  config.jmapServerUrl = SERVER;
  cookieSet.mockClear();
  encryptSession.mockClear();
  setStalwartAuthContext.mockClear();
  setStalwartAuthContextInStore.mockClear();
  recordLogin.mockClear();
  loggerWarn.mockClear();
  vi.resetModules();
  installFakeServer();
});

afterEach(() => {
  fetchSpy.mockRestore();
});

describe('POST /api/auth/session (GHSA-wxcm-j4jc-9fxq)', () => {
  it('refuses to mint cookies for a wrong password on the configured server', async () => {
    const { status, body } = await postSession({
      serverUrl: SERVER, username: 'alice@example.org', password: 'TOTALLY-WRONG', slot: 0,
    });
    expect(status).toBe(401);
    expect(body.error).toMatch(/authentication failed/i);
    expect(cookieSet).not.toHaveBeenCalled();
    expect(setStalwartAuthContextInStore).not.toHaveBeenCalled();
    expect(recordLogin).not.toHaveBeenCalled();
  });

  it('refuses to mint cookies for a user that does not exist upstream', async () => {
    const { status } = await postSession({
      serverUrl: SERVER, username: 'nobody@example.org', password: 'x', slot: 0,
    });
    expect(status).toBe(401);
    expect(cookieSet).not.toHaveBeenCalled();
    expect(setStalwartAuthContextInStore).not.toHaveBeenCalled();
  });

  it('writes no cookie when the upstream server cannot be reached', async () => {
    fetchSpy.mockRejectedValue(new TypeError('fetch failed'));
    const { status } = await postSession({
      serverUrl: SERVER, username: 'alice@example.org', password: 'alice-secret', slot: 0,
    });
    expect(status).toBe(502);
    expect(cookieSet).not.toHaveBeenCalled();
    expect(setStalwartAuthContextInStore).not.toHaveBeenCalled();
  });

  it('still mints cookies for the right password after checking upstream', async () => {
    const { status, body } = await postSession({
      serverUrl: SERVER, username: 'alice@example.org', password: 'alice-secret', slot: 0,
    });
    expect(status).toBe(200);
    expect(body.ok).toBe(true);
    expect(fetchSpy).toHaveBeenCalledWith(
      `${SERVER}/.well-known/jmap`,
      expect.objectContaining({ headers: { Authorization: basic('alice@example.org', 'alice-secret') } }),
    );
    expect(cookieSet).toHaveBeenCalledTimes(1);
    expect(setStalwartAuthContextInStore).toHaveBeenCalledWith(
      expect.anything(), 0, expect.objectContaining({ username: 'alice@example.org', serverUrl: SERVER }),
    );
  });
});

describe('POST /api/auth/stalwart-context (GHSA-wxcm-j4jc-9fxq)', () => {
  it('refuses a Basic credential the server rejects', async () => {
    const { status } = await postContext({
      serverUrl: SERVER, username: 'alice@example.org', authHeader: basic('alice@example.org', 'nope'), slot: 0,
    });
    expect(status).toBe(401);
    expect(setStalwartAuthContext).not.toHaveBeenCalled();
  });

  it('refuses a Basic credential whose user part differs from the claimed username, before any fetch', async () => {
    const { status, body } = await postContext({
      serverUrl: SERVER, username: 'alice@example.org', authHeader: basic('mallory@example.org', 'mallory-secret'), slot: 0,
    });
    expect(status).toBe(400);
    expect(body.error).toMatch(/does not match/i);
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(setStalwartAuthContext).not.toHaveBeenCalled();
  });

  it('refuses a valid Bearer token whose owner is not the claimed username', async () => {
    const { status, body } = await postContext({
      serverUrl: SERVER, username: 'alice@example.org', authHeader: 'Bearer tok-mallory', slot: 0,
    });
    expect(status).toBe(403);
    expect(body.error).toMatch(/does not match/i);
    expect(identityGetCalls).toBe(1);
    expect(setStalwartAuthContext).not.toHaveBeenCalled();
  });

  it('refuses a Bearer token when the identity lookup fails, rather than trusting the claim', async () => {
    fetchSpy.mockImplementation(async (input: RequestInfo | URL) => {
      if (String(input).endsWith('/.well-known/jmap')) {
        return json({ apiUrl: `${SERVER}/jmap/`, username: 'lrath', primaryAccounts: { 'urn:ietf:params:jmap:mail': 'c' }, accounts: {} });
      }
      return json({ error: 'boom' }, 500);
    });
    const { status } = await postContext({
      serverUrl: SERVER, username: 'linus@example.org', authHeader: 'Bearer tok-linus', slot: 0,
    });
    expect(status).toBe(502);
    expect(setStalwartAuthContext).not.toHaveBeenCalled();
  });

  it('accepts a Bearer token whose session username is the claim, without an identity lookup', async () => {
    const { status } = await postContext({
      serverUrl: SERVER, username: 'mallory@example.org', authHeader: 'Bearer tok-mallory', slot: 1,
    });
    expect(status).toBe(200);
    expect(identityGetCalls).toBe(0);
    expect(setStalwartAuthContext).toHaveBeenCalledWith(1, expect.objectContaining({ username: 'mallory@example.org' }));
  });

  it('accepts an OAuth login registered under the primary identity e-mail via Identity/get on the reachable host', async () => {
    const { status } = await postContext({
      serverUrl: SERVER, username: 'linus@example.org', authHeader: 'Bearer tok-linus', slot: 0,
    });
    expect(status).toBe(200);
    expect(identityGetCalls).toBe(1);
    // apiUrl was advertised on stwtest.local; the lookup must go to the verified origin.
    expect(fetchSpy).toHaveBeenCalledWith(`${SERVER}/jmap/`, expect.objectContaining({ method: 'POST' }));
    expect(setStalwartAuthContext).toHaveBeenCalledWith(0, expect.objectContaining({ username: 'linus@example.org' }));
  });

  it('accepts the bare local part of the session username (Stalwart canonicalizes it)', async () => {
    const { status } = await postContext({
      serverUrl: SERVER, username: 'lrath@corp.example', authHeader: 'Bearer tok-linus', slot: 0,
    });
    expect(status).toBe(200);
    expect(identityGetCalls).toBe(0);
  });

  it('still mints the context for a Basic credential the server accepts', async () => {
    const { status } = await postContext({
      serverUrl: SERVER, username: 'alice@example.org', authHeader: basic('alice@example.org', 'alice-secret'), slot: 2,
    });
    expect(status).toBe(200);
    expect(setStalwartAuthContext).toHaveBeenCalledWith(2, expect.objectContaining({ username: 'alice@example.org', serverUrl: SERVER }));
  });
});

/** What undici throws when the TLS handshake rejects a self-signed certificate. */
function selfSignedFetchError(): TypeError {
  const cause = Object.assign(new Error('self-signed certificate'), { code: 'DEPTH_ZERO_SELF_SIGNED_CERT' });
  return Object.assign(new TypeError('fetch failed'), { cause });
}

describe('unreachable or untrusted mail server (#1073)', () => {
  it('stalwart-context logs the TLS cause and tells the browser how to fix it', async () => {
    fetchSpy.mockRejectedValue(selfSignedFetchError());
    const { status, body } = await postContext({
      serverUrl: SERVER, username: 'alice@example.org', authHeader: basic('alice@example.org', 'alice-secret'), slot: 0,
    });
    expect(status).toBe(502);
    expect(body.code).toBe('DEPTH_ZERO_SELF_SIGNED_CERT');
    expect(body.hint).toMatch(/NODE_EXTRA_CA_CERTS/);
    expect(setStalwartAuthContext).not.toHaveBeenCalled();
    expect(loggerWarn).toHaveBeenCalledWith(
      expect.stringContaining('could not verify the sign-in'),
      expect.objectContaining({ serverUrl: SERVER, code: 'DEPTH_ZERO_SELF_SIGNED_CERT' }),
    );
  });

  it('session reports a DNS failure with its cause', async () => {
    const cause = Object.assign(new Error('getaddrinfo ENOTFOUND mail.example.org'), { code: 'ENOTFOUND' });
    fetchSpy.mockRejectedValue(Object.assign(new TypeError('fetch failed'), { cause }));
    const { status, body } = await postSession({
      serverUrl: SERVER, username: 'alice@example.org', password: 'alice-secret', slot: 0,
    });
    expect(status).toBe(502);
    expect(body.code).toBe('ENOTFOUND');
    expect(body.hint).toMatch(/resolve/);
    expect(cookieSet).not.toHaveBeenCalled();
    expect(loggerWarn).toHaveBeenCalled();
  });

  it('does not log a wrong password as a server problem', async () => {
    const { status, body } = await postContext({
      serverUrl: SERVER, username: 'alice@example.org', authHeader: basic('alice@example.org', 'nope'), slot: 0,
    });
    expect(status).toBe(401);
    expect(body.code).toBeUndefined();
    expect(loggerWarn).not.toHaveBeenCalled();
  });
});
