import { createHmac } from 'crypto';
import { describe, it, expect, vi, beforeEach, afterEach, type MockInstance } from 'vitest';

// #1687: a server entry that is only an extra account. The login pre-check
// refuses it without a sign-in to another configured server in this browser,
// and with one sends the legacy-proxy a login grant signed with
// LOGIN_GRANT_SECRET (checked the way legacy-proxy src/auth/loginGrant.ts does).

vi.mock('next/server', () => ({
  NextResponse: {
    json: (data: unknown, init?: { status?: number }) => ({ json: async () => data, status: init?.status ?? 200 }),
  },
}));
vi.mock('next/headers', () => ({ cookies: async () => ({}) }));
vi.mock('@/lib/logger', () => ({ logger: { warn: vi.fn(), error: vi.fn(), debug: vi.fn(), info: vi.fn() } }));

const config: Record<string, unknown> = {};
vi.mock('@/lib/admin/config-manager', () => ({
  configManager: {
    ensureLoaded: async () => {},
    get: (key: string, fallback: unknown) => (key in config ? config[key] : fallback),
  },
}));

const contexts = new Map<number, { serverUrl: string; username: string; authHeader: string; accountName?: string }>();
vi.mock('@/lib/stalwart/auth-context', () => ({
  readCurrentStalwartAuthContext: async (_store: unknown, slot: number) => contexts.get(slot) ?? null,
}));

const MAIN = 'https://mail.family.test';
const PROXY = 'https://proxy.family.test';
const SECRET = 'a-shared-secret-of-at-least-32-characters!';

function mockRequest(body: unknown): unknown {
  return { json: async () => body, headers: { get: () => null }, nextUrl: { searchParams: new URLSearchParams() } };
}

async function verify(body: unknown) {
  const { POST } = await import('@/app/api/auth/verify/route');
  const res = (await POST(mockRequest(body) as Parameters<typeof POST>[0])) as unknown as { json: () => Promise<Record<string, unknown>>; status: number };
  return { status: res.status, body: await res.json() };
}

const session = (username: string) => new Response(JSON.stringify({ apiUrl: '/jmap/', accounts: {}, primaryAccounts: {}, username }), { status: 200 });

/** The grant's claims after checking it like the proxy: HMAC-SHA-256 over `bwg1.<payload>`. */
function checkGrant(token: string, secret: string) {
  const [prefix, payload, signature] = token.split('.');
  expect(prefix).toBe('bwg1');
  const expected = createHmac('sha256', Buffer.from(secret, 'utf8')).update(`${prefix}.${payload}`).digest('base64url');
  expect(signature).toBe(expected);
  return JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as Record<string, unknown>;
}

let fetchSpy: MockInstance<typeof fetch>;
type Fetched = { url: string; headers: Record<string, string> };
const fetched = (): Fetched[] => fetchSpy.mock.calls.map(([url, init]) => ({ url: String(url), headers: (init as RequestInit).headers as Record<string, string> }));

beforeEach(() => {
  for (const k of Object.keys(config)) delete config[k];
  config.jmapServerUrl = MAIN;
  config.jmapServers = [
    { id: 'main', label: 'Family', url: MAIN },
    { id: 'extern', label: 'External account', url: PROXY, extraAccountOnly: true },
  ];
  config.loginGrantSecret = SECRET;
  contexts.clear();
  vi.resetModules();
  fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async (url) =>
    String(url).startsWith(MAIN) ? session('bob@family.test') : session('bob@gmx.test'));
});

afterEach(() => {
  fetchSpy.mockRestore();
});

describe('login pre-check for a server that is only an extra account (#1687)', () => {
  it('is refused without another sign-in, before the proxy hears of it', async () => {
    const { status, body } = await verify({ serverUrl: PROXY, username: 'bob@gmx.test', password: 'pw' });
    expect(status).toBe(403);
    expect(body).toEqual({ error: 'primary_sign_in_required' });
    expect(fetched().some((c) => c.url.startsWith(PROXY))).toBe(false);
  });

  it('does not count a sign-in to another extra-only server', async () => {
    contexts.set(0, { serverUrl: PROXY, username: 'old@gmx.test', authHeader: 'Basic eDp5' });
    const { status } = await verify({ serverUrl: PROXY, username: 'bob@gmx.test', password: 'pw' });
    expect(status).toBe(403);
  });

  it('does not count a main sign-in the main server no longer accepts', async () => {
    contexts.set(0, { serverUrl: MAIN, username: 'bob@family.test', authHeader: 'Bearer expired' });
    fetchSpy.mockImplementation(async (url: Parameters<typeof fetch>[0]) => (String(url).startsWith(MAIN) ? new Response('', { status: 401 }) : session('x')));
    const { status } = await verify({ serverUrl: PROXY, username: 'bob@gmx.test', password: 'pw' });
    expect(status).toBe(403);
  });

  it('with a main sign-in, sends the proxy a grant for this address', async () => {
    contexts.set(1, { serverUrl: MAIN, username: 'bob@family.test', authHeader: 'Bearer good' });
    const before = Math.floor(Date.now() / 1000);
    const { status, body } = await verify({ serverUrl: PROXY, username: 'Bob@GMX.test', password: 'pw' });
    expect(status).toBe(200);
    expect(body).toEqual({ result: 'ok' });
    const toProxy = fetched().find((c) => c.url.startsWith(PROXY))!;
    const claims = checkGrant(toProxy.headers['X-Bulwark-Login-Grant'], SECRET);
    expect(claims).toMatchObject({ aud: PROXY, sub: 'bob@gmx.test', pri: 'bob@family.test' });
    expect(claims.iat as number).toBeGreaterThanOrEqual(before);
    expect((claims.exp as number) - (claims.iat as number)).toBe(60);
    expect(String(claims.jti).length).toBeGreaterThanOrEqual(16);
    // The main server's own check carries no grant.
    expect(fetched().filter((c) => c.url.startsWith(MAIN)).every((c) => !c.headers['X-Bulwark-Login-Grant'])).toBe(true);
  });

  it('without a secret, still needs the main sign-in but sends no grant', async () => {
    delete config.loginGrantSecret;
    contexts.set(0, { serverUrl: MAIN, username: 'bob@family.test', authHeader: 'Bearer good' });
    const { status } = await verify({ serverUrl: PROXY, username: 'bob@gmx.test', password: 'pw' });
    expect(status).toBe(200);
    expect(fetched().find((c) => c.url.startsWith(PROXY))!.headers['X-Bulwark-Login-Grant']).toBeUndefined();
  });

  it('leaves the main server as it was', async () => {
    const { status, body } = await verify({ serverUrl: MAIN, username: 'bob@family.test', password: 'pw' });
    expect(status).toBe(200);
    expect(body).toEqual({ result: 'ok' });
    expect(fetched().every((c) => !c.headers['X-Bulwark-Login-Grant'])).toBe(true);
  });
});

describe('server list', () => {
  it('tells the browser which entries are only an extra account', async () => {
    const { parseJmapServers, redactJmapServers } = await import('@/lib/admin/jmap-servers');
    const servers = parseJmapServers(config.jmapServers);
    expect(redactJmapServers(servers).map((s) => s.extraAccountOnly ?? false)).toEqual([false, true]);
    expect(parseJmapServers([{ id: 'x', label: 'X', url: PROXY, extraAccountOnly: 'yes' }])[0]).not.toHaveProperty('extraAccountOnly');
  });
});
