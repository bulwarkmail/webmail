/**
 * @vitest-environment node
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Behind a load balancer every replica answers admin logins (#1066). The
// login limits (5 per address, 50 overall, 5 per known device) have to
// count every replica's attempts together, or N replicas allow N times as
// many guesses. When the shared store is down they can't be checked, and
// no password is tried.

vi.mock('next/server', () => ({
  NextResponse: {
    json: (data: unknown, init?: { status?: number; headers?: Record<string, string> }) => ({
      json: async () => data,
      status: init?.status ?? 200,
      headers: new Headers(init?.headers),
    }),
  },
}));
const browser = new Map<string, string>();
vi.mock('next/headers', () => ({
  cookies: async () => ({
    get: (name: string) => (browser.has(name) ? { name, value: browser.get(name)! } : undefined),
    set: (name: string, value: string) => { browser.set(name, value); },
    delete: (name: string) => { browser.delete(name); },
  }),
}));
vi.mock('@/lib/logger', () => ({ logger: { warn: vi.fn(), error: vi.fn(), debug: vi.fn(), info: vi.fn() } }));
vi.mock('@/lib/admin/audit', () => ({ auditLog: vi.fn() }));
vi.mock('@/lib/security/same-origin', () => ({ isSameOriginRequest: () => true }));
vi.mock('@/lib/admin/config-manager', () => ({
  configManager: { ensureLoaded: vi.fn(), get: (_key: string, fallback?: unknown) => fallback },
}));
vi.mock('@/lib/stalwart/credentials', () => ({ getStalwartCredentials: async () => null }));
vi.mock('@/lib/admin/stalwart-admin-access', () => ({ getStalwartAdminAccessMode: async () => 'password' }));
const verify = vi.hoisted(() => ({ calls: 0 }));
vi.mock('@/lib/admin/password', () => ({
  initAdminPassword: vi.fn().mockResolvedValue(true),
  isAdminEnabled: () => true,
  verifyAdminPassword: async (password: string) => {
    verify.calls++;
    return password === 'right-password';
  },
  updateLastLogin: vi.fn(),
  getAdminMeta: () => null,
  getAdminSessionGeneration: async () => 0,
  isAdminSessionRevoked: async () => false,
  revokeAdminSession: vi.fn(),
}));

import { setStoreForTests } from '@/lib/shared-store';
import { resetLocalStoreForTests } from '@/lib/shared-store/local';
import { separateFakeStore } from '@/lib/admin/__tests__/shared-store-fake';

type Route = typeof import('@/app/api/admin/auth/route');
let dir: string;
let store: ReturnType<typeof separateFakeStore>;

/** The login route of one replica: a module copy of its own, limiter and all. */
async function replica(): Promise<Route['POST']> {
  vi.resetModules();
  return (await import('@/app/api/admin/auth/route')).POST;
}

async function login(POST: Route['POST'], password: string, ip: string, device?: string) {
  browser.clear();
  if (device) browser.set('admin_device', device);
  const request = new Request('https://bulwark.example/api/admin/auth', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-forwarded-for': ip },
    body: JSON.stringify({ password }),
  });
  return POST(request as never) as unknown as Promise<{ status: number; json(): Promise<{ error?: string }>; headers: Headers }>;
}

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'bw-admin-limit-'));
  vi.stubEnv('SESSION_SECRET', 'a'.repeat(48));
  resetLocalStoreForTests();
  store = separateFakeStore(dir);
  setStoreForTests(store);
  verify.calls = 0;
});

afterEach(() => {
  setStoreForTests(null);
  resetLocalStoreForTests();
  vi.unstubAllEnvs();
  rmSync(dir, { recursive: true, force: true });
});

describe('admin login limits across replicas', () => {
  it('counts one address\'s failures on every replica together', async () => {
    const replicas = [await replica(), await replica(), await replica()];
    for (let i = 0; i < 5; i++) expect((await login(replicas[i % 3], 'guess', '203.0.113.7')).status).toBe(401);
    for (const POST of replicas) expect((await login(POST, 'right-password', '203.0.113.7')).status).toBe(429);
    expect(verify.calls).toBe(5);
  });

  it('holds the overall ceiling across replicas', async () => {
    const replicas = [await replica(), await replica(), await replica()];
    for (let i = 0; i < 50; i++) expect((await login(replicas[i % 3], 'guess', `198.51.100.${i}`)).status).toBe(401);
    for (const POST of replicas) expect((await login(POST, 'right-password', '192.0.2.1')).status).toBe(429);
  });

  it('counts a known device\'s attempts on every replica together', async () => {
    const first = await replica();
    expect((await login(first, 'right-password', '203.0.113.7')).status).toBe(200);
    const device = browser.get('admin_device')!;
    const replicas = [await replica(), await replica()];
    for (let i = 0; i < 5; i++) expect((await login(replicas[i % 2], 'guess', `192.0.2.${i}`, device)).status).toBe(401);
    expect((await login(first, 'right-password', '192.0.2.50', device)).status).toBe(429);
  });

  it('refuses with 503 and tries no password while the store is down', async () => {
    const POST = await replica();
    store.down = true;
    const res = await login(POST, 'right-password', '203.0.113.7');
    expect(res.status).toBe(503);
    expect((await res.json()).error).toBe('Sign-in is temporarily unavailable');
    expect(res.headers.get('Retry-After')).toBe('10');
    expect(verify.calls).toBe(0);
  });
});
