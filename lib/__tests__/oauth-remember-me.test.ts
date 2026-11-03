// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

// "Remember me" on provider sign-ins (#1437). With the box offered and left
// unticked, the refresh token and its companions must end with the browser
// session on every path that writes them: the browser's own code exchange,
// the server-side SSO flow (manual and automatic), and token rotation.

vi.mock('@/lib/auth/session-secret', () => ({
  getSessionSecret: () => 's'.repeat(64),
  hasSessionSecret: () => true,
}));
vi.mock('@/lib/logger', () => ({
  logger: { warn: () => {}, error: () => {}, info: () => {}, debug: () => {} },
}));
vi.mock('@/lib/admin/config-manager', () => ({
  configManager: {
    ensureLoaded: async () => {},
    get: (_key: string, fallback: unknown) => fallback,
    getPolicy: () => ({}),
  },
}));

const jar = new Map<string, { value: string; options?: { maxAge?: number } }>();
const cookieStore = {
  get: (name: string) => (jar.has(name) ? { name, value: jar.get(name)!.value } : undefined),
  set: (name: string, value: string, options?: { maxAge?: number }) => { jar.set(name, { value, options }); },
  delete: (arg: string | { name: string }) => { jar.delete(typeof arg === 'string' ? arg : arg.name); },
  getAll: () => [...jar].map(([name, { value }]) => ({ name, value })),
};
vi.mock('next/headers', () => ({ cookies: async () => cookieStore }));

const exchangeCodeForTokens = vi.fn();
vi.mock('@/lib/oauth/token-exchange', () => ({
  exchangeCodeForTokens: (...args: unknown[]) => exchangeCodeForTokens(...args),
  getTokenEndpoint: async () => 'https://idp.example.net/token',
  getRequiredConfig: () => ({ clientId: 'webmail', serverUrl: 'https://mail.example.org', discoveryUrl: 'https://idp.example.net' }),
  hasClientSecret: () => false,
  getDiscoveryValidator: () => undefined,
  buildOAuthParams: (params: Record<string, string>) => new URLSearchParams(params),
  defaultClientOptions: async () => ({}),
  DEFAULT_CLIENT_ID: 'webmail',
}));
vi.mock('@/lib/oauth/discovery', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  discoverOAuth: async () => ({ authorization_endpoint: 'https://idp.example.net/authorize', token_endpoint: 'https://idp.example.net/token' }),
}));

import { POST as exchange, PUT as renew } from '@/app/api/auth/token/route';
import { POST as ssoStart } from '@/app/api/auth/sso/start/route';
import { POST as ssoComplete } from '@/app/api/auth/sso/complete/route';

const THIRTY_DAYS = 30 * 24 * 60 * 60;

function post(path: string, body: Record<string, unknown>) {
  return new NextRequest(`https://webmail.example${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'sec-fetch-site': 'same-origin', origin: 'https://webmail.example' },
    body: JSON.stringify(body),
  });
}

const maxAge = (name: string) => jar.get(name)?.options?.maxAge;

beforeEach(() => {
  jar.clear();
  exchangeCodeForTokens.mockReset().mockResolvedValue({ access_token: 'at', refresh_token: 'rt', expires_in: 3600, id_token: 'idt' });
});

describe('browser code exchange', () => {
  const code = { code: 'c', code_verifier: 'v', redirect_uri: 'https://webmail.example/en/auth/callback' };

  it('writes browser-session cookies when the box is left unticked', async () => {
    expect((await exchange(post('/api/auth/token', { ...code, remember: false }))).status).toBe(200);
    expect(jar.get('jmap_rt')?.value).toBe('rt');
    for (const name of ['jmap_rt', 'jmap_signed_in', 'jmap_at', 'jmap_idt']) {
      expect(jar.has(name), name).toBe(true);
      expect(maxAge(name), name).toBeUndefined();
    }
  });

  it('remembers the sign-in for clients that send no choice', async () => {
    await exchange(post('/api/auth/token', code));
    expect(maxAge('jmap_rt')).toBe(THIRTY_DAYS);
  });

  it('keeps a rotated refresh token a browser-session cookie', async () => {
    await exchange(post('/api/auth/token', { ...code, remember: false }));
    vi.stubGlobal('fetch', vi.fn(async () => Response.json({ access_token: 'at2', refresh_token: 'rt2', expires_in: 3600 })));
    try {
      const res = await renew(new NextRequest('https://webmail.example/api/auth/token?slot=0&force=true&remember=false', {
        method: 'PUT',
        headers: { 'sec-fetch-site': 'same-origin' },
      }));
      expect(res.status).toBe(200);
    } finally {
      vi.unstubAllGlobals();
    }
    expect(jar.get('jmap_rt')?.value).toBe('rt2');
    expect(maxAge('jmap_rt')).toBeUndefined();
    expect(maxAge('jmap_signed_in')).toBeUndefined();
  });
});

describe('server-side SSO', () => {
  async function signIn(start: Record<string, unknown>) {
    const started = await ssoStart(post('/api/auth/sso/start', { redirect_uri: 'https://webmail.example/en/auth/callback', ...start }));
    expect(started.status).toBe(200);
    const { state } = await started.json();
    const res = await ssoComplete(post('/api/auth/sso/complete', { code: 'c', state }));
    expect(res.status).toBe(200);
    return res.json();
  }

  it('asks the provider for a real login after a forgotten app lock PIN, and only then', async () => {
    const authorize = async (extra: Record<string, unknown>) => {
      const started = await ssoStart(post('/api/auth/sso/start', { redirect_uri: 'https://webmail.example/en/auth/callback', ...extra }));
      return new URL((await started.json()).authorize_url).searchParams.get('prompt');
    };
    expect(await authorize({})).toBeNull();
    expect(await authorize({ fresh_login: true })).toBe('login');
    expect(await authorize({ fresh_login: 'yes' }), 'only the page\'s own true').toBeNull();
  });

  it('carries an unticked box from start to complete', async () => {
    const body = await signIn({ remember: false });
    expect(body.remember).toBe(false);
    expect(jar.get('jmap_rt')?.value).toBe('rt');
    expect(maxAge('jmap_rt')).toBeUndefined();
    expect(maxAge('jmap_signed_in')).toBeUndefined();
    expect(maxAge('jmap_idt')).toBeUndefined();
  });

  it('remembers the sign-in when the start names no choice', async () => {
    const body = await signIn({});
    expect(body.remember).toBe(true);
    expect(maxAge('jmap_rt')).toBe(THIRTY_DAYS);
  });
});
