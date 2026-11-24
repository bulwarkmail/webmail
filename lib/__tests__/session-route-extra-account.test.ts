// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest';

// POST /api/auth/session for a server that is only an extra account (#1687):
// no remembered sign-in without a sign-in to another server here.

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
const contexts = vi.hoisted(() => new Map<number, { serverUrl: string; username: string; authHeader: string }>());
vi.mock('@/lib/stalwart/auth-context', () => ({
  setStalwartAuthContextInStore: vi.fn(),
  clearStalwartAuthContextInStore: vi.fn(),
  readCurrentStalwartAuthContext: async (_store: unknown, slot: number) => contexts.get(slot) ?? null,
}));
const resolved = vi.hoisted(() => [] as string[]);
vi.mock('@/lib/auth/verify-jmap-auth', () => ({
  JmapAuthVerificationError: class extends Error { status = 401; },
  resolveJmapIdentity: async (serverUrl: string, _auth: string, username: string) => {
    resolved.push(serverUrl);
    return { serverUrl, accountName: username };
  },
  fetchJmapSessionIdentity: async (serverUrl: string) => ({ serverUrl, addresses: ['bob@family.test'] }),
}));
const MAIN = 'https://mail.family.test';
const PROXY = 'https://proxy.family.test';
vi.mock('@/lib/admin/config-manager', () => ({
  configManager: {
    ensureLoaded: async () => {},
    get: (key: string, fallback: unknown) => key === 'jmapServerUrl' ? MAIN
      : key === 'jmapServers' ? [{ id: 'extern', label: 'External', url: PROXY, extraAccountOnly: true }]
        : fallback,
  },
}));
const written = new Map<string, unknown>();
vi.mock('next/headers', () => ({
  cookies: async () => ({
    get: () => undefined,
    set: (name: string, value: unknown) => { written.set(name, value); },
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

async function signIn(serverUrl: string) {
  const { POST } = await import('@/app/api/auth/session/route');
  const request = {
    method: 'POST',
    json: async () => ({ serverUrl, username: 'bob@gmx.test', password: 'secret', slot: 1 }),
    headers: { get: (key: string) => HEADERS[key.toLowerCase()] ?? null },
    nextUrl: { searchParams: new URLSearchParams(), origin: 'https://webmail.example' },
  };
  const res = await POST(request as unknown as Parameters<typeof POST>[0]) as unknown as { status: number; json: () => Promise<unknown> };
  return { status: res.status, body: await res.json() };
}

beforeEach(() => {
  written.clear();
  contexts.clear();
  resolved.length = 0;
});

describe('POST /api/auth/session for a server that is only an extra account', () => {
  it('is refused without a sign-in to another server, and keeps nothing', async () => {
    const { status, body } = await signIn(PROXY);
    expect(status).toBe(403);
    expect(body).toEqual({ error: 'primary_sign_in_required' });
    expect(resolved).toEqual([]);
    expect(written.size).toBe(0);
  });

  it('is kept next to a sign-in to the main server', async () => {
    contexts.set(0, { serverUrl: MAIN, username: 'bob@family.test', authHeader: 'Bearer good' });
    const { status } = await signIn(PROXY);
    expect(status).toBe(200);
    expect(resolved).toEqual([PROXY]);
  });
});
