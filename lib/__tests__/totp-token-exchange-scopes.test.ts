// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

// #1550: the password + TOTP sign-in sent a fixed scope, so on Stalwart
// 1.0.3 its token never reached Account security, whatever Stalwart scopes
// the admin configured for the webmail's client.

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

const scopes: string[] = [];
function stalwart(url: unknown, init?: RequestInit) {
  if (String(url).endsWith('/api/auth')) {
    const body = JSON.parse(String(init?.body));
    scopes.push(new URLSearchParams(body.query).get('scope') ?? '');
    return Response.json({ type: 'authenticated', client_code: 'code-1' });
  }
  return Response.json({ access_token: 'at', refresh_token: 'rt', expires_in: 3600 });
}
vi.mock('@/lib/security/url-guard', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/security/url-guard')>();
  return { ...actual, isPublicHttpUrl: async () => true, fetchPublicUrl: async (url: unknown, init?: RequestInit) => stalwart(url, init) };
});

function login() {
  return new NextRequest('https://webmail.example/api/auth/totp-token-exchange', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'sec-fetch-site': 'same-origin' },
    body: JSON.stringify({ serverUrl: 'https://mail.example.org', username: 'u', password: 'p', totp: '123456' }),
  });
}

async function signIn(): Promise<string[]> {
  const { POST } = await import('@/app/api/auth/totp-token-exchange/route');
  expect((await POST(login())).status).toBe(200);
  return scopes[0].split(' ');
}

beforeEach(() => {
  for (const key of Object.keys(config)) delete config[key];
  config.jmapServerUrl = 'https://mail.example.org';
  scopes.length = 0;
  vi.stubGlobal('fetch', vi.fn(async (url: unknown, init?: RequestInit) => stalwart(url, init)));
});

describe('password + TOTP sign-in scope', () => {
  it('asks for the Stalwart scopes configured for the admin\'s client', async () => {
    config.oauthClientId = 'bulwark-webmail';
    config.oauthExtraScopes = 'urn:stalwart:oauth:scope:security urn:stalwart:oauth:scope:settings';
    const scope = await signIn();
    expect(scope).toEqual(expect.arrayContaining([
      'urn:ietf:params:oauth:scope:mail',
      'urn:stalwart:oauth:scope:security',
      'urn:stalwart:oauth:scope:settings',
    ]));
    expect(scope).not.toContain('urn:stalwart:oauth:scope:full');
  });

  it('takes them from an explicit scope list too, without its other scopes', async () => {
    config.oauthClientId = 'bulwark-webmail';
    config.oauthScopes = 'openid email profile urn:stalwart:oauth:scope:full';
    const scope = await signIn();
    expect(scope).toContain('urn:stalwart:oauth:scope:full');
    expect(scope).not.toContain('email');
  });

  it('asks for the data scopes only when none are configured', async () => {
    config.oauthClientId = 'bulwark-webmail';
    expect((await signIn()).some((s) => s.startsWith('urn:stalwart:'))).toBe(false);
  });

  it('never asks for them with the built-in default client', async () => {
    config.oauthExtraScopes = 'urn:stalwart:oauth:scope:security';
    expect((await signIn()).some((s) => s.startsWith('urn:stalwart:'))).toBe(false);
  });
});
