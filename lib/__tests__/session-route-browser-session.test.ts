// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * POST /api/auth/session with `remember: false` (#1559): a sign-in made with
 * "Remember me" unticked, kept until the browser closes when the admin turns
 * on BROWSER_SESSION_SIGN_IN. Its cookie gets no Max-Age or Expires, so the
 * browser drops it with its session. A client that sends no flag keeps
 * today's 30-day cookie.
 */

vi.mock('next/server', () => ({
  NextResponse: {
    json: (data: unknown, init?: { status?: number }) => ({ json: async () => data, status: init?.status ?? 200 }),
  },
}));
vi.mock('@/lib/logger', () => ({ logger: { warn: vi.fn(), error: vi.fn(), debug: vi.fn(), info: vi.fn() } }));
vi.mock('@/lib/telemetry/login-tracker', () => ({ recordLogin: vi.fn() }));
vi.mock('@/lib/auth/crypto', () => ({
  encryptSession: () => 'sealed-session',
  decryptSession: () => null,
  sessionAuthHeader: () => '',
}));
vi.mock('@/lib/stalwart/auth-context', () => ({
  setStalwartAuthContextInStore: vi.fn(),
  clearStalwartAuthContextInStore: vi.fn(),
}));
vi.mock('@/lib/auth/verify-jmap-auth', () => ({
  JmapAuthVerificationError: class extends Error { status = 401; },
  resolveJmapIdentity: async (serverUrl: string, _auth: string, username: string) => ({ serverUrl, accountName: username }),
}));
vi.mock('@/lib/admin/config-manager', () => ({
  configManager: {
    ensureLoaded: async () => {},
    get: (key: string, fallback: unknown) => (key === 'jmapServerUrl' ? 'https://mail.example.org' : fallback),
  },
}));

type CookieOptions = { maxAge?: number; expires?: unknown; httpOnly?: boolean; path?: string };
const written = new Map<string, CookieOptions>();
vi.mock('next/headers', () => ({
  cookies: async () => ({
    get: () => undefined,
    set: (name: string, _value: string, options: CookieOptions) => { written.set(name, options); },
    delete: vi.fn(),
    getAll: () => [],
  }),
}));

const HEADERS: Record<string, string> = {
  host: 'webmail.example',
  origin: 'https://webmail.example',
  'content-type': 'application/json',
  'sec-fetch-site': 'same-origin',
  'sec-fetch-mode': 'cors',
  'sec-fetch-dest': 'empty',
};

async function signIn(extra: Record<string, unknown>) {
  const { POST } = await import('@/app/api/auth/session/route');
  const request = {
    method: 'POST',
    json: async () => ({ serverUrl: 'https://mail.example.org', username: 'alice@example.org', password: 'secret', slot: 0, ...extra }),
    headers: { get: (key: string) => HEADERS[key.toLowerCase()] ?? null },
    nextUrl: { searchParams: new URLSearchParams(), origin: 'https://webmail.example' },
  };
  const res = await POST(request as unknown as Parameters<typeof POST>[0]) as unknown as { status: number };
  expect(res.status).toBe(200);
  const options = written.get('jmap_session');
  expect(options).toBeDefined();
  return options!;
}

beforeEach(() => {
  written.clear();
});

describe('POST /api/auth/session', () => {
  it('keeps an unticked sign-in in a cookie that ends with the browser session', async () => {
    const options = await signIn({ remember: false });
    expect(options.maxAge).toBeUndefined();
    expect(options.expires).toBeUndefined();
    expect(options.httpOnly).toBe(true);
    expect(options.path).toBe('/');
  });

  it('keeps a remembered sign-in for 30 days', async () => {
    expect((await signIn({ remember: true })).maxAge).toBe(30 * 24 * 60 * 60);
  });

  it('keeps 30 days for a client that sends no flag', async () => {
    expect((await signIn({})).maxAge).toBe(30 * 24 * 60 * 60);
  });
});
