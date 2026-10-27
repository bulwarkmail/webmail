// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

// With custom JMAP endpoints allowed and a default server configured, a
// password + TOTP sign-in to a server the user typed went to the default
// server instead: the password for one server was sent to another, and the
// browser then used that server's token against the one the user picked.

vi.mock('@/lib/logger', () => ({
  logger: { warn: () => {}, error: () => {}, info: () => {}, debug: () => {} },
}));
vi.mock('next/headers', () => ({
  cookies: async () => ({ get: () => undefined, set: () => {}, delete: () => {} }),
}));
vi.mock('@/lib/telemetry/login-tracker', () => ({ recordLogin: () => {} }));

const config: Record<string, unknown> = {};
vi.mock('@/lib/admin/config-manager', () => ({
  configManager: {
    ensureLoaded: async () => {},
    get: (key: string, fallback: unknown) => (key in config ? config[key] : fallback),
  },
}));

const contacted: string[] = [];
function stalwart(url: unknown) {
  contacted.push(new URL(String(url)).origin);
  return String(url).endsWith('/api/auth')
    ? Response.json({ type: 'authenticated', client_code: 'code-1' })
    : Response.json({ access_token: 'at', refresh_token: 'rt', expires_in: 3600 });
}
vi.mock('@/lib/security/url-guard', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/security/url-guard')>();
  return { ...actual, isPublicHttpUrl: async () => true, fetchPublicUrl: async (url: unknown) => stalwart(url) };
});

function login(serverUrl: string) {
  return new NextRequest('https://webmail.example/api/auth/totp-token-exchange', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'sec-fetch-site': 'same-origin' },
    body: JSON.stringify({ serverUrl, username: 'u', password: 'p', totp: '123456' }),
  });
}

beforeEach(() => {
  for (const key of Object.keys(config)) delete config[key];
  config.jmapServerUrl = 'https://mail.example.org';
  contacted.length = 0;
  vi.stubGlobal('fetch', vi.fn(async (url: unknown) => stalwart(url)));
});

describe('totp-token-exchange upstream', () => {
  it('signs in at the server the user typed when custom endpoints are allowed', async () => {
    config.allowCustomJmapEndpoint = true;
    const { POST } = await import('@/app/api/auth/totp-token-exchange/route');
    expect((await POST(login('https://custom.example'))).status).toBe(200);
    expect(contacted).toEqual(['https://custom.example', 'https://custom.example']);
  });

  it('still signs in at the configured server when the user picked it', async () => {
    config.allowCustomJmapEndpoint = true;
    const { POST } = await import('@/app/api/auth/totp-token-exchange/route');
    expect((await POST(login('https://mail.example.org/'))).status).toBe(200);
    expect(contacted).toEqual(['https://mail.example.org', 'https://mail.example.org']);
  });

  it('uses the configured server when custom endpoints are off', async () => {
    const { POST } = await import('@/app/api/auth/totp-token-exchange/route');
    expect((await POST(login('https://custom.example'))).status).toBe(200);
    expect(contacted).toEqual(['https://mail.example.org', 'https://mail.example.org']);
  });
});
