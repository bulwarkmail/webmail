// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

// The sign-in and session routes that read a JSON body and act with or write
// the browser's cookies take only a JSON content type. An HTML form, even on
// a page of the same origin, can send form encodings or text/plain only, and
// request.json() would read a text/plain body that happens to be JSON.

vi.mock('@/lib/logger', () => ({
  logger: { warn: vi.fn(), error: vi.fn(), debug: vi.fn(), info: vi.fn() },
}));
vi.mock('@/lib/auth/session-secret', () => ({
  getSessionSecret: () => 's'.repeat(64),
  hasSessionSecret: () => true,
}));
vi.mock('@/lib/telemetry/login-tracker', () => ({ recordLogin: () => {} }));
vi.mock('@/lib/admin/config-manager', () => ({
  configManager: {
    ensureLoaded: async () => {},
    get: (key: string, fallback?: unknown) => (key === 'jmapServerUrl' ? 'https://mail.example.org' : fallback),
    getPolicy: () => ({}),
  },
}));

let jar = new Map<string, string>();
vi.mock('next/headers', () => ({
  cookies: async () => ({
    get: (name: string) => (jar.has(name) ? { name, value: jar.get(name)! } : undefined),
    set: (name: string, value: string) => { jar.set(name, value); },
    delete: (name: string | { name: string }) => { jar.delete(typeof name === 'string' ? name : name.name); },
    getAll: () => [...jar].map(([name, value]) => ({ name, value })),
  }),
}));

const SAME_ORIGIN = { 'sec-fetch-site': 'same-origin', 'sec-fetch-mode': 'navigate', 'sec-fetch-dest': 'document', origin: 'https://webmail.example' };

const ROUTES: Array<[string, Record<string, unknown>]> = [
  ['session', { serverUrl: 'https://mail.example.org', username: 'u@example.org', password: 'pw' }],
  ['stalwart-context', { serverUrl: 'https://mail.example.org', username: 'u@example.org', authHeader: 'Basic dTpwdw==' }],
  ['token', { code: 'c', code_verifier: 'v'.repeat(43), redirect_uri: 'https://webmail.example/en/auth/callback' }],
  ['totp-token-exchange', { serverUrl: 'https://mail.example.org', username: 'u@example.org', password: 'pw', totp: '123456' }],
  ['sso/start', { redirect_uri: 'https://webmail.example/en/auth/callback' }],
  ['sso/complete', { code: 'c', state: 's' }],
  ['reauth/sso/complete', { code: 'c', state: 's' }],
  ['pair/create', { webmail_base: 'https://webmail.example' }],
  ['desktop-handoff/redeem', { code: 'c'.repeat(64), code_verifier: 'v'.repeat(64) }],
];

async function post(route: string, body: Record<string, unknown>, contentType: string) {
  const { POST } = await import(`@/app/api/auth/${route}/route`);
  return POST(new NextRequest(`https://webmail.example/api/auth/${route}`, {
    method: 'POST',
    headers: { ...SAME_ORIGIN, 'content-type': contentType },
    body: JSON.stringify(body),
  }));
}

describe('a body that is not sent as JSON', () => {
  const upstream = vi.fn(async () => new Response('{}', { status: 500 }));
  beforeEach(() => {
    jar = new Map();
    upstream.mockClear();
    vi.stubGlobal('fetch', upstream);
  });
  afterEach(() => vi.unstubAllGlobals());

  for (const [route, body] of ROUTES) {
    it(`is refused by POST /api/auth/${route} before anything happens`, async () => {
      for (const type of ['text/plain', 'text/plain;charset=UTF-8', 'application/x-www-form-urlencoded', 'multipart/form-data; boundary=x']) {
        const res = await post(route, body, type);
        expect(res.status, type).toBe(415);
      }
      expect(upstream).not.toHaveBeenCalled();
      expect([...jar.keys()]).toEqual([]);
    }, 30_000);

    it(`still reaches POST /api/auth/${route} with a JSON content type (control)`, async () => {
      expect((await post(route, body, 'application/json; charset=UTF-8')).status).not.toBe(415);
    }, 30_000);
  }
});
