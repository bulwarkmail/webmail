import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// /api/admin/auth with accounts listed in `adminAccounts`: mail accounts
// that get what a Stalwart superuser gets, without an admin role in
// Stalwart, each on one configured server. The mocked Stalwart below
// refuses x:Tenant/query, so only the list can let anyone in.

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

const MAIL = 'https://mail.example.com';
const OTHER = 'https://other.example.com';

const state = {
  config: {} as Record<string, unknown>,
  adminPasswordConfigured: false,
};

vi.mock('@/lib/admin/config-manager', () => ({
  configManager: {
    ensureLoaded: vi.fn().mockResolvedValue(undefined),
    get: (key: string, defaultValue?: unknown) =>
      key in state.config ? state.config[key] : defaultValue,
  },
}));

vi.mock('@/lib/admin/password', () => ({
  initAdminPassword: vi.fn().mockResolvedValue(true),
  isAdminEnabled: () => state.adminPasswordConfigured,
  verifyAdminPassword: vi.fn(),
  updateLastLogin: vi.fn().mockResolvedValue(undefined),
  getAdminMeta: () => null,
}));

const setAdminSessionCookie = vi.fn();
vi.mock('@/lib/admin/session', () => ({
  setAdminSessionCookie: (...args: unknown[]) => setAdminSessionCookie(...args),
  clearAdminSessionCookie: vi.fn(),
  requireAdminAuth: async () => ({ error: 'unauthorized' }),
  getClientIP: () => '127.0.0.1',
  isSameOriginRequest: () => true,
  getAdminDeviceId: async () => null,
  setAdminDeviceCookie: vi.fn(),
}));

vi.mock('@/lib/admin/rate-limit', () => ({
  checkRateLimit: () => ({ allowed: true, retryAfterMs: 0 }),
  checkDeviceRateLimit: () => ({ allowed: true, retryAfterMs: 0 }),
}));

const auditLog = vi.fn();
vi.mock('@/lib/admin/audit', () => ({
  auditLog: (...args: unknown[]) => auditLog(...args),
}));

// The sign-in context: `username` is what the cookie claims.
const creds = { serverUrl: MAIL, username: 'alice@example.com', trusted: true };
vi.mock('@/lib/stalwart/credentials', () => ({
  getStalwartCredentials: async () => ({
    serverUrl: creds.serverUrl,
    authHeader: 'Bearer alice',
    username: creds.username,
    trusted: creds.trusted,
  }),
}));

// What the mail server says about the credential.
const session = { username: 'alice@example.com', accountName: 'alice@example.com' };
const fetchMock = vi.fn(async (url: string, init?: { body?: string }) => {
  if (url.endsWith('/.well-known/jmap')) {
    return {
      ok: true,
      json: async () => ({
        username: session.username,
        primaryAccounts: { 'urn:ietf:params:jmap:mail': 'm1', 'urn:stalwart:jmap': 'm1' },
        accounts: { m1: { name: session.accountName } },
      }),
    };
  }
  const [method] = JSON.parse(init?.body ?? '{}').methodCalls[0];
  return {
    ok: true,
    json: async () => ({
      methodResponses: [['error', { type: 'forbidden', description: `Not allowed: ${method}` }, '0']],
    }),
  };
});

type RouteResponse = { status: number; json: () => Promise<Record<string, unknown>> };
let route: typeof import('@/app/api/admin/auth/route');

async function callGet() {
  const res = (await route.GET({} as Parameters<typeof route.GET>[0])) as unknown as RouteResponse;
  return { status: res.status, body: await res.json() };
}

async function callPost(body: Record<string, unknown>) {
  const request = { json: async () => body } as Parameters<typeof route.POST>[0];
  const res = (await route.POST(request)) as unknown as RouteResponse;
  return { status: res.status, body: await res.json() };
}

describe('admin auth route - listed admin accounts', () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    state.config = {
      jmapServerUrl: MAIL,
      jmapServers: [{ id: 'other', label: 'Other', url: OTHER }],
      adminAccounts: [{ serverUrl: MAIL, account: 'alice@example.com' }],
    };
    state.adminPasswordConfigured = false;
    Object.assign(creds, { serverUrl: MAIL, username: 'alice@example.com', trusted: true });
    Object.assign(session, { username: 'alice@example.com', accountName: 'alice@example.com' });
    vi.stubGlobal('fetch', fetchMock);
    // A fresh module per test, so its check cache starts empty.
    vi.resetModules();
    route = await import('@/app/api/admin/auth/route');
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('is not an admin when not listed (the server refuses the superuser probe)', async () => {
    state.config.adminAccounts = [];
    const { body } = await callGet();
    expect(body).toMatchObject({ stalwartAdmin: false, stalwartAutoLogin: false });
    expect(fetchMock).toHaveBeenCalled();
  });

  it('auto: shows the shield and signs in without the password, even with none configured', async () => {
    const { body } = await callGet();
    expect(body).toMatchObject({ enabled: false, stalwartAdmin: true, stalwartAutoLogin: true });

    const login = await callPost({ stalwartAuth: true });
    expect(login.status).toBe(200);
    expect(setAdminSessionCookie).toHaveBeenCalledTimes(1);
    expect(auditLog).toHaveBeenCalledWith('admin.login', { method: 'stalwart', via: 'account_list' }, '127.0.0.1');
  });

  it('password: shows the shield but refuses the password-free sign-in', async () => {
    state.config.stalwartAdminAccess = 'password';
    state.adminPasswordConfigured = true;
    const { body } = await callGet();
    expect(body).toMatchObject({ enabled: true, stalwartAdmin: true, stalwartAutoLogin: false });

    const login = await callPost({ stalwartAuth: true });
    expect(login.status).toBe(403);
    expect(setAdminSessionCookie).not.toHaveBeenCalled();
  });

  it('off: ignores the list', async () => {
    state.config.stalwartAdminAccess = 'off';
    state.adminPasswordConfigured = true;
    const { body } = await callGet();
    expect(body).toMatchObject({ stalwartAdmin: false, stalwartAutoLogin: false });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('ties an entry to its server: the same account on another configured server does not match', async () => {
    creds.serverUrl = OTHER;
    const { body } = await callGet();
    expect(body).toMatchObject({ stalwartAdmin: false });

    const login = await callPost({ stalwartAuth: true });
    expect(login.status).toBe(403);
    expect(setAdminSessionCookie).not.toHaveBeenCalled();
  });

  it('matches the account name and server URL regardless of case', async () => {
    state.config.adminAccounts = [{ serverUrl: MAIL, account: 'Alice@Example.COM' }];
    creds.serverUrl = 'https://MAIL.example.com/';
    const { body } = await callGet();
    expect(body).toMatchObject({ stalwartAdmin: true, stalwartAutoLogin: true });
  });

  it('matches the name of the primary mail account', async () => {
    session.username = 'alice';
    state.config.adminAccounts = [{ serverUrl: MAIL, account: 'alice@example.com' }];
    const { body } = await callGet();
    expect(body).toMatchObject({ stalwartAdmin: true });
  });

  it('does not trust the username the cookie claims', async () => {
    state.config.adminAccounts = [{ serverUrl: MAIL, account: 'boss@example.com' }];
    creds.username = 'boss@example.com';
    const { body } = await callGet();
    expect(body).toMatchObject({ stalwartAdmin: false, stalwartAutoLogin: false });

    const login = await callPost({ stalwartAuth: true });
    expect(login.status).toBe(403);
    expect(setAdminSessionCookie).not.toHaveBeenCalled();
  });

  it('does not match while custom JMAP endpoints are allowed', async () => {
    state.config.allowCustomJmapEndpoint = true;
    const { body } = await callGet();
    expect(body).toMatchObject({ stalwartAdmin: false });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('does not match on a server URL that is not trusted', async () => {
    creds.trusted = false;
    const { body } = await callGet();
    expect(body).toMatchObject({ stalwartAdmin: false });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('ignores an entry whose server is no longer configured', async () => {
    state.config.jmapServers = [];
    state.config.adminAccounts = [{ serverUrl: OTHER, account: 'alice@example.com' }];
    creds.serverUrl = OTHER;
    const { body } = await callGet();
    expect(body).toMatchObject({ stalwartAdmin: false });
  });

  it('applies a list change at once, despite the cached answer', async () => {
    expect((await callGet()).body).toMatchObject({ stalwartAdmin: true });

    state.config.adminAccounts = [];
    expect((await callGet()).body).toMatchObject({ stalwartAdmin: false });

    state.config.adminAccounts = [{ serverUrl: MAIL, account: 'alice@example.com' }];
    expect((await callGet()).body).toMatchObject({ stalwartAdmin: true });

    // One session fetch and one probe served all three.
    expect(fetchMock.mock.calls.filter(([url]) => url.endsWith('/.well-known/jmap'))).toHaveLength(1);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});
