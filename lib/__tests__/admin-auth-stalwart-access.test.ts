import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// /api/admin/auth under the three `stalwartAdminAccess` modes (#870):
//   auto     - Stalwart admins are auto-signed-in (legacy behaviour)
//   password - shield stays, but the Bulwark admin password is required
//   off      - Stalwart admin status is ignored entirely

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

const state = {
  config: {} as Record<string, unknown>,
  adminPasswordConfigured: false,
  hasAdminSession: false,
};

vi.mock('@/lib/admin/config-manager', () => ({
  configManager: {
    ensureLoaded: vi.fn().mockResolvedValue(undefined),
    get: (key: string, defaultValue?: unknown) =>
      key in state.config ? state.config[key] : defaultValue,
  },
}));

const verifyAdminPassword = vi.fn();
vi.mock('@/lib/admin/password', () => ({
  initAdminPassword: vi.fn().mockResolvedValue(true),
  isAdminEnabled: () => state.adminPasswordConfigured,
  verifyAdminPassword: (...args: unknown[]) => verifyAdminPassword(...args),
  updateLastLogin: vi.fn().mockResolvedValue(undefined),
  getAdminMeta: () => null,
}));

const setAdminSessionCookie = vi.fn();
vi.mock('@/lib/admin/session', () => ({
  setAdminSessionCookie: (...args: unknown[]) => setAdminSessionCookie(...args),
  clearAdminSessionCookie: vi.fn(),
  requireAdminAuth: async () => (state.hasAdminSession ? { role: 'admin' } : { error: 'unauthorized' }),
  getClientIP: () => '127.0.0.1',
  isSameOriginRequest: () => true,
}));

vi.mock('@/lib/admin/rate-limit', () => ({
  checkRateLimit: () => ({ allowed: true, retryAfterMs: 0 }),
}));

const auditLog = vi.fn();
vi.mock('@/lib/admin/audit', () => ({
  auditLog: (...args: unknown[]) => auditLog(...args),
}));

const creds = { trusted: true };
vi.mock('@/lib/stalwart/credentials', () => ({
  getStalwartCredentials: async () => ({
    serverUrl: 'https://mail.example.com',
    authHeader: 'Bearer token',
    username: 'admin@example.com',
    trusted: creds.trusted,
  }),
}));

// A Stalwart where this account is the server-wide superuser: it may list
// tenants. A tenant admin may list accounts but not tenants.
const role = { current: 'superuser' as 'superuser' | 'tenant-admin' };
const fetchMock = vi.fn(async (url: string, init?: { body?: string }) => {
  if (url.endsWith('/.well-known/jmap')) {
    return {
      ok: true,
      json: async () => ({ primaryAccounts: { 'urn:stalwart:jmap': 'a' } }),
    };
  }
  const [method] = JSON.parse(init?.body ?? '{}').methodCalls[0];
  const allowed = method === 'x:Account/query' || role.current === 'superuser';
  return {
    ok: true,
    json: async () => ({
      methodResponses: [allowed
        ? [method, { ids: [] }, '0']
        : ['error', { type: 'forbidden', description: 'You are not authorized to perform this action' }, '0']],
    }),
  };
});

type RouteResponse = { status: number; json: () => Promise<Record<string, unknown>> };

async function loadRoute() {
  // Fresh module per test so the per-credential admin-check cache can't leak
  // an "is admin" verdict from one mode into the next.
  vi.resetModules();
  return import('@/app/api/admin/auth/route');
}

async function callGet() {
  const { GET } = await loadRoute();
  const res = (await GET({} as Parameters<typeof GET>[0])) as unknown as RouteResponse;
  return { status: res.status, body: await res.json() };
}

async function callPost(body: Record<string, unknown>) {
  const { POST } = await loadRoute();
  const request = { json: async () => body } as Parameters<typeof POST>[0];
  const res = (await POST(request)) as unknown as RouteResponse;
  return { status: res.status, body: await res.json() };
}

describe('admin auth route - stalwartAdminAccess modes (#870)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    state.config = {};
    state.adminPasswordConfigured = false;
    state.hasAdminSession = false;
    role.current = 'superuser';
    creds.trusted = true;
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  describe('auto (default)', () => {
    it('reports the Stalwart admin and allows auto-login even without an admin password', async () => {
      const { body } = await callGet();
      expect(body).toMatchObject({ enabled: false, authenticated: false, stalwartAdmin: true, stalwartAutoLogin: true });

      const login = await callPost({ stalwartAuth: true });
      expect(login.status).toBe(200);
      expect(setAdminSessionCookie).toHaveBeenCalledTimes(1);
      expect(auditLog).toHaveBeenCalledWith('admin.login', { method: 'stalwart' }, '127.0.0.1');
    });
  });

  describe('tenant admin (GHSA-v6hr)', () => {
    beforeEach(() => {
      role.current = 'tenant-admin';
    });

    it('is not a Stalwart admin for the dashboard, even in auto mode', async () => {
      const { body } = await callGet();
      expect(body).toMatchObject({ stalwartAdmin: false, stalwartAutoLogin: false });

      const login = await callPost({ stalwartAuth: true });
      expect(login.status).toBe(403);
      expect(setAdminSessionCookie).not.toHaveBeenCalled();
    });
  });

  it('never asks a server the admin did not configure', async () => {
    // A context cookie minted while allowCustomJmapEndpoint was on still
    // names the user-chosen server after the switch is turned off.
    creds.trusted = false;
    const { body } = await callGet();
    expect(body).toMatchObject({ stalwartAdmin: false, stalwartAutoLogin: false });

    const login = await callPost({ stalwartAuth: true });
    expect(login.status).toBe(403);
    expect(setAdminSessionCookie).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  describe('password', () => {
    beforeEach(() => {
      state.config.stalwartAdminAccess = 'password';
      state.adminPasswordConfigured = true;
    });

    it('still flags the Stalwart admin (shield stays) but withholds auto-login', async () => {
      const { body } = await callGet();
      expect(body).toMatchObject({ enabled: true, authenticated: false, stalwartAdmin: true, stalwartAutoLogin: false });
    });

    it('rejects a stalwartAuth login attempt without touching the session cookie', async () => {
      const login = await callPost({ stalwartAuth: true });
      expect(login.status).toBe(403);
      expect(setAdminSessionCookie).not.toHaveBeenCalled();
      expect(auditLog).toHaveBeenCalledWith(
        'admin.login_failed',
        expect.objectContaining({ method: 'stalwart', reason: 'auto_login_disabled', mode: 'password' }),
        '127.0.0.1',
      );
    });

    it('accepts the admin password as usual', async () => {
      verifyAdminPassword.mockResolvedValueOnce(true);
      const login = await callPost({ password: 'correct horse' });
      expect(login.status).toBe(200);
      expect(setAdminSessionCookie).toHaveBeenCalledTimes(1);
    });

    it('reports the dashboard as disabled when no admin password exists (no lock-in via Stalwart)', async () => {
      state.adminPasswordConfigured = false;
      const { body } = await callGet();
      expect(body).toMatchObject({ enabled: false, authenticated: false, stalwartAdmin: false, stalwartAutoLogin: false });
    });
  });

  describe('off', () => {
    beforeEach(() => {
      state.config.stalwartAdminAccess = 'off';
      state.adminPasswordConfigured = true;
    });

    it('ignores Stalwart admin status entirely and never asks Stalwart', async () => {
      const { body } = await callGet();
      expect(body).toMatchObject({ enabled: true, authenticated: false, stalwartAdmin: false, stalwartAutoLogin: false });
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it('rejects stalwartAuth logins', async () => {
      const login = await callPost({ stalwartAuth: true });
      expect(login.status).toBe(403);
      expect(setAdminSessionCookie).not.toHaveBeenCalled();
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it('keeps the password login working', async () => {
      verifyAdminPassword.mockResolvedValueOnce(true);
      const login = await callPost({ password: 'correct horse' });
      expect(login.status).toBe(200);
      expect(setAdminSessionCookie).toHaveBeenCalledTimes(1);
    });
  });

  it('treats an unrecognised mode value as "off" (fail closed)', async () => {
    state.config.stalwartAdminAccess = 'yes-please';
    state.adminPasswordConfigured = true;

    const { body } = await callGet();
    expect(body).toMatchObject({ stalwartAdmin: false, stalwartAutoLogin: false });

    const login = await callPost({ stalwartAuth: true });
    expect(login.status).toBe(403);
    expect(setAdminSessionCookie).not.toHaveBeenCalled();
  });
});
