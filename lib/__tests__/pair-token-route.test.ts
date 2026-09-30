// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

// POST /api/auth/pair/token: the refresh proxy for paired phones that cannot
// renew at the provider themselves. It only renews refresh tokens this
// webmail sealed for a phone, at the endpoint sealed with them, adding the
// client secret server-side.

let sessionSecret = 's'.repeat(64);
vi.mock('@/lib/auth/session-secret', () => ({
  getSessionSecret: () => sessionSecret,
  hasSessionSecret: () => sessionSecret.length > 0,
}));
vi.mock('@/lib/logger', () => ({
  logger: { warn: () => {}, error: () => {}, info: () => {}, debug: () => {} },
}));

const config: Record<string, unknown> = {};
vi.mock('@/lib/admin/config-manager', () => ({
  configManager: {
    ensureLoaded: async () => {},
    get: (key: string, fallback: unknown) => (key in config ? config[key] : fallback),
  },
}));

const publicFetch = vi.fn();
vi.mock('@/lib/security/url-guard', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/security/url-guard')>();
  return {
    ...actual,
    isPublicHttpUrl: async () => true,
    fetchPublicUrl: (...args: unknown[]) => publicFetch(...args),
  };
});

// The provider's token endpoint as configured now; the proxy only trusts a
// sealed endpoint (secret, unguarded fetch) while it is still this one.
let configuredEndpoint: string | null = 'https://idp.example.net/realms/acme/protocol/openid-connect/token';
vi.mock('@/lib/oauth/token-exchange', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/oauth/token-exchange')>();
  return {
    ...actual,
    getTokenEndpoint: async () => {
      if (!configuredEndpoint) throw new Error('OAuth not configured');
      return configuredEndpoint;
    },
  };
});

import { encryptPayload } from '@/lib/auth/crypto';
import { openPhoneRefreshToken, sealPhoneRefreshToken, type SealedRefresh } from '@/lib/auth/pair-bundle';
import { POST } from '@/app/api/auth/pair/token/route';

const PROVIDER = 'https://idp.example.net/realms/acme/protocol/openid-connect/token';
const SEALED: SealedRefresh = {
  refreshToken: 'refresh-1',
  serverId: null,
  clientId: 'webmail-client',
  tokenEndpoint: PROVIDER,
  trusted: true,
};

const upstream = vi.fn();

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

async function refresh(params: Record<string, string>, headers: Record<string, string> = {}) {
  const res = await POST(new NextRequest('https://webmail.example/api/auth/pair/token', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', ...headers },
    body: new URLSearchParams(params).toString(),
  }));
  return {
    status: res.status,
    body: await res.json(),
    cacheControl: res.headers.get('cache-control'),
    pragma: res.headers.get('pragma'),
  };
}

function refreshWith(value: SealedRefresh = SEALED) {
  return refresh({ grant_type: 'refresh_token', refresh_token: sealPhoneRefreshToken(value), client_id: value.clientId });
}

function upstreamParams(mock = upstream) {
  const [, init] = mock.mock.calls[0] as [string, RequestInit];
  return Object.fromEntries(new URLSearchParams(String(init.body)));
}

beforeEach(() => {
  sessionSecret = 's'.repeat(64);
  configuredEndpoint = PROVIDER;
  for (const key of Object.keys(config)) delete config[key];
  config.oauthClientSecret = 'webmail-client-secret';
  vi.stubEnv('OAUTH_CLIENT_SECRET', '');
  vi.stubEnv('OAUTH_CLIENT_SECRET_FILE', '');
  // A fresh Response per call: a body can only be read once.
  upstream.mockReset().mockImplementation(async () => json({ access_token: 'access-2', expires_in: 300, token_type: 'Bearer' }));
  vi.stubGlobal('fetch', upstream);
  publicFetch.mockReset().mockImplementation(async () => json({ access_token: 'access-2', expires_in: 300 }));
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe('pair/token request checks', () => {
  it.each([
    ['authorization_code', { grant_type: 'authorization_code', code: 'x' }],
    ['password', { grant_type: 'password', username: 'a', password: 'b' }],
    ['client_credentials', { grant_type: 'client_credentials' }],
    ['no grant_type', {}],
  ])('refuses the %s grant', async (_label, params) => {
    const res = await refresh({ ...params, refresh_token: sealPhoneRefreshToken(SEALED) });
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: 'unsupported_grant_type' });
    expect(res.cacheControl).toBe('no-store');
    expect(upstream).not.toHaveBeenCalled();
  });

  it.each([
    ['no refresh token', undefined],
    ['a raw provider refresh token', 'refresh-1'],
    ['garbage', 'not-even-base64!'],
    ['a pairing proof cookie', 'PROOF'],
    ['a session context blob', 'CONTEXT'],
  ])('refuses %s with invalid_grant, without calling the provider', async (_label, token) => {
    const fields = { r: 'refresh-1', s: null, c: 'webmail-client', e: PROVIDER, t: true };
    const value = token === 'PROOF'
      ? encryptPayload({ ...fields, purpose: 'pair', grant_id: 'g', owner: '0:a' }, 'pair-reauth')
      : token === 'CONTEXT'
        ? encryptPayload(fields, 'session-context')
        : token;
    const res = await refresh({ grant_type: 'refresh_token', ...(value !== undefined ? { refresh_token: value } : {}) });
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: 'invalid_grant' });
    expect(upstream).not.toHaveBeenCalled();
    expect(publicFetch).not.toHaveBeenCalled();
  });

  it('refuses a token sealed under another SESSION_SECRET', async () => {
    const sealed = sealPhoneRefreshToken(SEALED);
    sessionSecret = 't'.repeat(64);
    const res = await refresh({ grant_type: 'refresh_token', refresh_token: sealed });
    expect(res.body).toEqual({ error: 'invalid_grant' });
    expect(upstream).not.toHaveBeenCalled();
  });

  it('refuses a cross-site browser request', async () => {
    const res = await refresh(
      { grant_type: 'refresh_token', refresh_token: sealPhoneRefreshToken(SEALED) },
      { 'sec-fetch-site': 'cross-site', origin: 'https://evil.example' },
    );
    expect(res.status).toBe(403);
    expect(upstream).not.toHaveBeenCalled();
  });
});

describe('pair/token renewal', () => {
  it('renews at the sealed endpoint with the raw refresh token and the client secret', async () => {
    const res = await refreshWith();
    expect(res.status).toBe(200);
    expect(res.cacheControl).toBe('no-store');
    expect(res.pragma).toBe('no-cache');

    expect(upstream).toHaveBeenCalledTimes(1);
    const [url, init] = upstream.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(PROVIDER);
    expect(init.method).toBe('POST');
    // The body carries the secret: a redirect must not re-send it elsewhere.
    expect(init.redirect).toBe('error');
    expect(new Headers(init.headers).get('content-type')).toBe('application/x-www-form-urlencoded');
    expect(upstreamParams()).toEqual({
      grant_type: 'refresh_token',
      refresh_token: 'refresh-1',
      client_id: 'webmail-client',
      client_secret: 'webmail-client-secret',
    });
    expect(publicFetch).not.toHaveBeenCalled();
  });

  it('ignores a client_id or endpoint the phone sends', async () => {
    await refresh({
      grant_type: 'refresh_token',
      refresh_token: sealPhoneRefreshToken(SEALED),
      client_id: 'attacker-client',
      token_endpoint: 'https://evil.example/token',
    });
    expect(upstream.mock.calls[0][0]).toBe(PROVIDER);
    expect(upstreamParams().client_id).toBe('webmail-client');
  });

  it('uses the secret of the server the grant was minted for', async () => {
    config.jmapServers = [{ id: 'main', label: 'Main', url: 'https://mail.example.org', oauth: { clientSecret: 'per-server-secret' } }];
    await refreshWith({ ...SEALED, serverId: 'main' });
    expect(upstreamParams().client_secret).toBe('per-server-secret');
  });

  it('sends no client_secret when none is configured', async () => {
    delete config.oauthClientSecret;
    await refreshWith();
    expect(upstreamParams()).not.toHaveProperty('client_secret');
  });

  it('re-seals a rotated refresh token', async () => {
    upstream.mockResolvedValue(json({ access_token: 'access-2', refresh_token: 'refresh-2', expires_in: 300 }));
    const res = await refreshWith();
    expect(res.body.access_token).toBe('access-2');
    expect(res.body.token_type).toBe('Bearer');
    expect(res.body.expires_in).toBe(300);
    expect(res.body.refresh_token).not.toContain('refresh-2');
    expect(openPhoneRefreshToken(res.body.refresh_token)).toEqual({ ...SEALED, refreshToken: 'refresh-2' });
  });

  it('re-seals the same refresh token when the provider does not rotate', async () => {
    const res = await refreshWith();
    expect(openPhoneRefreshToken(res.body.refresh_token)).toEqual(SEALED);
    // The renewed token works on the proxy again.
    upstream.mockClear();
    const again = await refresh({ grant_type: 'refresh_token', refresh_token: res.body.refresh_token });
    expect(again.status).toBe(200);
    expect(upstreamParams().refresh_token).toBe('refresh-1');
  });

  it('never returns the provider refresh token in the clear', async () => {
    upstream.mockResolvedValue(json({ access_token: 'access-2', refresh_token: 'refresh-2' }));
    const res = await refreshWith();
    expect(JSON.stringify(res.body)).not.toContain('refresh-2');
    expect(JSON.stringify(res.body)).not.toContain('refresh-1');
    expect(JSON.stringify(res.body)).not.toContain('webmail-client-secret');
    expect(res.body).not.toHaveProperty('expires_in');
  });

  it.each([400, 401, 403])('reports a dead grant (upstream %i) as invalid_grant', async (code) => {
    upstream.mockResolvedValue(json({ error: 'invalid_grant' }, code));
    const res = await refreshWith();
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: 'invalid_grant' });
    expect(res.cacheControl).toBe('no-store');
  });

  it.each([500, 502, 503, 429])('reports an upstream %i as temporarily_unavailable', async (code) => {
    upstream.mockResolvedValue(new Response('down', { status: code }));
    const res = await refreshWith();
    expect(res.status).toBe(503);
    expect(res.body).toEqual({ error: 'temporarily_unavailable' });
  });

  it('reports a network error or a refused redirect as temporarily_unavailable', async () => {
    upstream.mockRejectedValue(new TypeError('fetch failed'));
    expect(await refreshWith()).toMatchObject({ status: 503, body: { error: 'temporarily_unavailable' } });
  });

  it('reports a malformed provider answer as temporarily_unavailable', async () => {
    upstream.mockResolvedValue(new Response('<html>', { status: 200 }));
    expect(await refreshWith()).toMatchObject({ status: 503, body: { error: 'temporarily_unavailable' } });
    upstream.mockResolvedValue(json({ token_type: 'Bearer' }));
    expect(await refreshWith()).toMatchObject({ status: 503, body: { error: 'temporarily_unavailable' } });
  });

  it('renews a grant from a user-chosen server only through the rebinding-safe fetch', async () => {
    const untrusted = { ...SEALED, tokenEndpoint: 'https://custom.example/auth/token', trusted: false };
    const res = await refreshWith(untrusted);
    expect(res.status).toBe(200);
    expect(upstream).not.toHaveBeenCalled();
    expect(publicFetch).toHaveBeenCalledTimes(1);
    expect(publicFetch.mock.calls[0][0]).toBe('https://custom.example/auth/token');
    expect(openPhoneRefreshToken(res.body.refresh_token)).toEqual(untrusted);
  });

  // A grant minted at a user-chosen (untrusted) server is renewed without the
  // webmail's own client secret.
  it('does not send the webmail client secret to a user-chosen server', async () => {
    const untrusted = { ...SEALED, tokenEndpoint: 'https://custom.example/auth/token', trusted: false };
    await refreshWith(untrusted);
    expect(upstreamParams(publicFetch)).not.toHaveProperty('client_secret');
  });
});

describe('pair/token trust at renewal time', () => {
  it('stops trusting a sealed endpoint the webmail is no longer configured for', async () => {
    configuredEndpoint = 'https://idp.example.net/realms/other/token';
    const res = await refreshWith();
    expect(res.status).toBe(200);
    expect(upstream).not.toHaveBeenCalled();
    expect(publicFetch).toHaveBeenCalledOnce();
    expect(upstreamParams(publicFetch)).not.toHaveProperty('client_secret');
  });

  it('keeps trusting the structured-login endpoint of a configured JMAP server', async () => {
    configuredEndpoint = null;
    config.jmapServerUrl = 'https://mail.example.org';
    const res = await refreshWith({ ...SEALED, tokenEndpoint: 'https://mail.example.org/auth/token' });
    expect(res.status).toBe(200);
    expect(upstream).toHaveBeenCalledOnce();
    expect(upstreamParams()).toMatchObject({ client_secret: 'webmail-client-secret' });
  });
});
