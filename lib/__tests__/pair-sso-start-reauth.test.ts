// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

// POST /api/auth/sso/start with purpose=reauth: the IdP step-up for "Link
// mobile app". The pending state (real crypto) must name the slot being
// paired, and the phone's grant should outlive the desktop's IdP session
// (offline_access) when the provider supports it.

vi.mock('@/lib/auth/session-secret', () => ({
  getSessionSecret: () => 's'.repeat(64),
  hasSessionSecret: () => true,
}));
vi.mock('@/lib/logger', () => ({
  logger: { warn: () => {}, error: () => {}, info: () => {}, debug: () => {} },
}));

const jar = new Map<string, string>();
const cookieStore = {
  get: (name: string) => (jar.has(name) ? { name, value: jar.get(name)! } : undefined),
  set: (name: string, value: string) => { jar.set(name, value); },
  delete: (arg: string | { name: string }) => { jar.delete(typeof arg === 'string' ? arg : arg.name); },
};
vi.mock('next/headers', () => ({ cookies: async () => cookieStore }));

vi.mock('@/lib/admin/config-manager', () => ({
  configManager: { ensureLoaded: async () => {}, get: (_key: string, fallback: unknown) => fallback },
}));

const getRequiredConfig = vi.fn((_serverId?: string | null) => ({
  clientId: 'webmail-client',
  discoveryUrl: 'https://idp.example.net',
}));
vi.mock('@/lib/oauth/token-exchange', () => ({
  getRequiredConfig: (serverId?: string | null) => getRequiredConfig(serverId),
  getDiscoveryValidator: () => undefined,
}));

let scopesSupported: unknown = undefined;
vi.mock('@/lib/oauth/discovery', () => ({
  discoverOAuth: async () => ({
    issuer: 'https://idp.example.net',
    authorization_endpoint: 'https://idp.example.net/authorize',
    token_endpoint: 'https://idp.example.net/token',
    ...(scopesSupported !== undefined ? { scopes_supported: scopesSupported } : {}),
  }),
}));

let configuredScopes = 'openid email profile';
vi.mock('@/lib/oauth/tokens', () => ({
  getOauthScopes: () => configuredScopes,
  refreshTokenServerCookieName: (slot: number) => (slot === 0 ? 'jmap_rt_server' : `jmap_rt_server_${slot}`),
}));

import { decryptPayload } from '@/lib/auth/crypto';
import { POST } from '@/app/api/auth/sso/start/route';

const WEBMAIL = 'https://webmail.example';

async function start(body: Record<string, unknown>) {
  const res = await POST(new NextRequest(`${WEBMAIL}/api/auth/sso/start`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'sec-fetch-site': 'same-origin', origin: WEBMAIL },
    body: JSON.stringify({ redirect_uri: `${WEBMAIL}/auth/callback`, ...body }),
  }));
  const data = await res.json();
  return {
    status: res.status,
    url: data.authorize_url ? new URL(data.authorize_url) : null,
    pending: jar.has('sso_pending') ? decryptPayload(jar.get('sso_pending')!, 'sso-pending') : null,
  };
}

beforeEach(() => {
  jar.clear();
  getRequiredConfig.mockClear();
  scopesSupported = undefined;
  configuredScopes = 'openid email profile';
});

describe('sso/start pending state for a re-auth', () => {
  it('records the purpose and the slot being paired', async () => {
    const res = await start({ purpose: 'reauth', slot: 3 });
    expect(res.status).toBe(200);
    expect(res.pending).toMatchObject({ purpose: 'reauth', slot: 3, redirect_uri: `${WEBMAIL}/auth/callback` });
    expect(res.pending?.state).toBe(res.url?.searchParams.get('state'));
  });

  it('defaults the slot to 0', async () => {
    expect((await start({ purpose: 'reauth' })).pending).toMatchObject({ purpose: 'reauth', slot: 0 });
  });

  it.each([-1, 1.5, '2', 50, null])('falls back to slot 0 for %s', async (slot) => {
    expect((await start({ purpose: 'reauth', slot })).pending).toMatchObject({ slot: 0 });
  });

  it("uses the slot's server entry for the IdP", async () => {
    jar.set('jmap_rt_server_3', 'corp');
    const res = await start({ purpose: 'reauth', slot: 3 });
    expect(getRequiredConfig).toHaveBeenCalledWith('corp');
    expect(res.pending).toMatchObject({ server_id: 'corp', slot: 3 });
  });

  it('records neither purpose nor slot for a normal login', async () => {
    jar.set('jmap_rt_server_3', 'corp');
    const res = await start({ slot: 3 });
    expect(res.status).toBe(200);
    expect(res.pending).not.toHaveProperty('purpose');
    expect(res.pending).not.toHaveProperty('slot');
    expect(res.pending).not.toHaveProperty('server_id');
    expect(res.url?.searchParams.has('prompt')).toBe(false);
  });

  it('forces a fresh login for a re-auth', async () => {
    expect((await start({ purpose: 'reauth' })).url?.searchParams.get('prompt')).toBe('login');
  });
});

describe('sso/start offline_access for a re-auth', () => {
  it('asks for offline_access when the provider advertises it', async () => {
    scopesSupported = ['openid', 'email', 'profile', 'offline_access'];
    const res = await start({ purpose: 'reauth' });
    expect(res.url?.searchParams.get('scope')).toBe('openid email profile offline_access');
  });

  it('does not ask for it when the provider does not advertise it', async () => {
    scopesSupported = ['openid', 'email', 'profile'];
    expect((await start({ purpose: 'reauth' })).url?.searchParams.get('scope')).toBe('openid email profile');
  });

  it('does not ask for it when the provider publishes no scopes', async () => {
    scopesSupported = undefined;
    expect((await start({ purpose: 'reauth' })).url?.searchParams.get('scope')).toBe('openid email profile');
  });

  it('never asks for it on a normal login', async () => {
    scopesSupported = ['openid', 'offline_access'];
    expect((await start({})).url?.searchParams.get('scope')).toBe('openid email profile');
  });

  it('does not add it twice', async () => {
    scopesSupported = ['openid', 'offline_access'];
    configuredScopes = 'openid offline_access email';
    expect((await start({ purpose: 'reauth' })).url?.searchParams.get('scope')).toBe('openid offline_access email');
  });

  it('normalizes the configured scope list when it appends', async () => {
    scopesSupported = ['offline_access'];
    configuredScopes = '  openid   email ';
    expect((await start({ purpose: 'reauth' })).url?.searchParams.get('scope')).toBe('openid email offline_access');
  });
});
