import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * What the login routes do with a private server, with and without the desktop
 * build, and whose budget a wrong password spends.
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

vi.mock('next/headers', () => ({
  cookies: async () => ({ get: () => undefined, set: vi.fn(), delete: vi.fn(), getAll: () => [] }),
}));

const config: Record<string, unknown> = { allowCustomJmapEndpoint: true };
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

const resolveJmapIdentity = vi.hoisted(() => vi.fn());
vi.mock('@/lib/auth/verify-jmap-auth', async (original) => ({
  ...(await original<object>()),
  resolveJmapIdentity,
}));

const reserveLoginAttempt = vi.hoisted(() => vi.fn());
vi.mock('@/lib/auth/verify-budget', async (original) => ({
  ...(await original<object>()),
  reserveLoginAttempt,
}));

// The route's first import compiles a good part of the app.
vi.setConfig({ testTimeout: 60_000 });

const TRUST_KEY = Symbol.for('bulwark.desktop.trustedJmapOrigins');
const LAN_SERVER = 'http://192.168.1.5:8080';

function loginRequest(serverUrl: string): unknown {
  const headers = new Headers({ 'sec-fetch-site': 'same-origin', host: 'app.bulwark.localhost', 'content-type': 'application/json' });
  return {
    method: 'POST',
    headers,
    nextUrl: { searchParams: new URLSearchParams(), basePath: '' },
    json: async () => ({ serverUrl, username: 'ent-alice@example.org', password: 'pw' }),
  };
}

async function postSession(serverUrl: string) {
  vi.resetModules();
  const { POST } = await import('@/app/api/auth/session/route');
  const res = (await POST(loginRequest(serverUrl) as Parameters<typeof POST>[0])) as unknown as {
    status: number;
    json: () => Promise<Record<string, unknown>>;
  };
  return { status: res.status, body: await res.json() };
}

beforeEach(() => {
  resolveJmapIdentity.mockReset();
  resolveJmapIdentity.mockImplementation(async (url: string) => ({ serverUrl: url, accountName: 'ent-alice@example.org' }));
  reserveLoginAttempt.mockReset();
  reserveLoginAttempt.mockImplementation(async () => async () => {});
  (globalThis as unknown as Record<symbol, ReadonlySet<string>>)[TRUST_KEY] = new Set([LAN_SERVER]);
});

afterEach(() => {
  vi.unstubAllEnvs();
  delete (globalThis as unknown as Record<symbol, unknown>)[TRUST_KEY];
});

describe('POST /api/auth/session', () => {
  it('a server build refuses a private URL, even with the set present', async () => {
    const { status, body } = await postSession(LAN_SERVER);
    expect(status).toBe(400);
    expect(body.error).toBe('Server URL is not allowed');
    expect(resolveJmapIdentity).not.toHaveBeenCalled();
  });

  it('a desktop build still refuses a private server the user did not approve', async () => {
    vi.stubEnv('NEXT_PUBLIC_BULWARK_DESKTOP', '1');
    const { status } = await postSession('http://192.168.1.6:8080');
    expect(status).toBe(400);
    expect(resolveJmapIdentity).not.toHaveBeenCalled();
  });

  it('a desktop build reaches an approved private server, and marks it trusted', async () => {
    vi.stubEnv('NEXT_PUBLIC_BULWARK_DESKTOP', '1');
    const { status } = await postSession(LAN_SERVER);
    expect(status).toBe(200);
    expect(resolveJmapIdentity).toHaveBeenCalledTimes(1);
    expect(resolveJmapIdentity.mock.calls[0][3]).toMatchObject({ trusted: true });
  });
});

describe('the login budget', () => {
  it('a server build budgets by client address', async () => {
    config.jmapServers = [{ id: 'a', url: LAN_SERVER }];
    await postSession(LAN_SERVER);
    delete config.jmapServers;
    expect(reserveLoginAttempt).toHaveBeenCalledWith('0.0.0.0');
  });

  it('a desktop build budgets per mail server, so two servers do not share one', async () => {
    vi.stubEnv('NEXT_PUBLIC_BULWARK_DESKTOP', '1');
    (globalThis as unknown as Record<symbol, ReadonlySet<string>>)[TRUST_KEY] = new Set([LAN_SERVER, 'http://192.168.1.6:8080']);
    await postSession(LAN_SERVER);
    await postSession('http://192.168.1.6:8080/');
    expect(reserveLoginAttempt.mock.calls.map((c) => c[0])).toEqual([
      'server:http://192.168.1.5:8080',
      'server:http://192.168.1.6:8080',
    ]);
  });

  it('the key is no address, so nothing is forwarded upstream as the client', async () => {
    const { forwardedClientHeaders } = await import('@/lib/auth/client-address');
    expect(forwardedClientHeaders('server:http://192.168.1.5:8080')).toEqual({});
  });
});
