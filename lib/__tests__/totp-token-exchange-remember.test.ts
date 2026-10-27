// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

// A password + TOTP sign-in keeps its refresh token in a cookie. Without
// "Remember me" that cookie was still written for 30 days, so the session
// outlived the browser like a remembered one.

vi.mock('@/lib/logger', () => ({
  logger: { warn: () => {}, error: () => {}, info: () => {}, debug: () => {} },
}));
const written: Array<{ name: string; value: string; options?: { maxAge?: number } }> = [];
vi.mock('next/headers', () => ({
  cookies: async () => ({
    get: () => undefined,
    set: (name: string, value: string, options?: { maxAge?: number }) => { written.push({ name, value, options }); },
    delete: () => {},
  }),
}));
vi.mock('@/lib/telemetry/login-tracker', () => ({ recordLogin: () => {} }));
vi.mock('@/lib/admin/config-manager', () => ({
  configManager: {
    ensureLoaded: async () => {},
    get: (key: string, fallback: unknown) => (key === 'jmapServerUrl' ? 'https://mail.example.org' : fallback),
  },
}));

function login(rememberMe?: boolean) {
  return new NextRequest('https://webmail.example/api/auth/totp-token-exchange', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'sec-fetch-site': 'same-origin' },
    body: JSON.stringify({
      serverUrl: 'https://mail.example.org', username: 'u', password: 'p', totp: '123456',
      ...(rememberMe === undefined ? {} : { rememberMe }),
    }),
  });
}

beforeEach(() => {
  written.length = 0;
  vi.stubGlobal('fetch', vi.fn(async (url: unknown) => (String(url).endsWith('/api/auth')
    ? Response.json({ type: 'authenticated', client_code: 'code-1' })
    : Response.json({ access_token: 'at', refresh_token: 'rt', expires_in: 3600 }))));
});

describe('totp-token-exchange refresh-token cookie', () => {
  it('ends with the browser session without Remember me', async () => {
    const { POST } = await import('@/app/api/auth/totp-token-exchange/route');
    expect((await POST(login(false))).status).toBe(200);
    const cookie = written.find((c) => c.name === 'jmap_rt');
    expect(cookie?.value).toBe('rt');
    expect(cookie?.options?.maxAge).toBeUndefined();
  });

  it('keeps the refresh token for 30 days with Remember me', async () => {
    const { POST } = await import('@/app/api/auth/totp-token-exchange/route');
    expect((await POST(login(true))).status).toBe(200);
    expect(written.find((c) => c.name === 'jmap_rt')?.options?.maxAge).toBe(30 * 24 * 60 * 60);
  });
});
