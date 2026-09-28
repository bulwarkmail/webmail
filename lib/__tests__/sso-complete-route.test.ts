// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

// POST /api/auth/sso/complete. A pairing step-up (purpose `reauth`)
// completes at /api/auth/reauth/sso/complete only: handed to this route, its
// code would sign the browser in as whoever answered the provider's prompt.
// For the mobile app handoff, the phone gets a bundle it can renew.

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
  getAll: () => [...jar].map(([name, value]) => ({ name, value })),
};
vi.mock('next/headers', () => ({ cookies: async () => cookieStore }));

const exchangeCodeForTokens = vi.fn();
let tokenEndpoint = 'https://idp.example.net/token';
let confidential = false;
vi.mock('@/lib/oauth/token-exchange', () => ({
  exchangeCodeForTokens: (...args: unknown[]) => exchangeCodeForTokens(...args),
  getTokenEndpoint: async () => tokenEndpoint,
  getRequiredConfig: () => ({ clientId: 'webmail', serverUrl: 'https://mail.example.org', discoveryUrl: 'https://idp.example.net' }),
  hasClientSecret: () => confidential,
}));

import { encryptPayload } from '@/lib/auth/crypto';
import { openPhoneRefreshToken } from '@/lib/auth/pair-bundle';
import { POST } from '@/app/api/auth/sso/complete/route';

function pending(extra: Record<string, unknown> = {}) {
  jar.set('sso_pending', encryptPayload({
    state: 'state-1',
    code_verifier: 'verifier-1',
    redirect_uri: 'https://webmail.example/en/auth/callback',
    created_at: Date.now(),
    ...extra,
  }, 'sso-pending'));
}

async function complete() {
  const res = await POST(new NextRequest('https://webmail.example/api/auth/sso/complete', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'sec-fetch-site': 'same-origin' },
    body: JSON.stringify({ code: 'code-1', state: 'state-1' }),
  }));
  return { status: res.status, body: await res.json() };
}

beforeEach(() => {
  jar.clear();
  tokenEndpoint = 'https://idp.example.net/token';
  confidential = false;
  exchangeCodeForTokens.mockReset().mockResolvedValue({ access_token: 'at', refresh_token: 'rt', expires_in: 3600 });
});

describe('/api/auth/sso/complete', () => {
  it('refuses a pairing re-auth and spends nothing', async () => {
    pending({ purpose: 'reauth', slot: 0 });
    const res = await complete();
    expect(res.status).toBe(400);
    expect(exchangeCodeForTokens).not.toHaveBeenCalled();
    expect(jar.has('jmap_rt')).toBe(false);
    expect(jar.has('sso_pending')).toBe(false);
  });

  it('still completes an ordinary login', async () => {
    pending();
    const res = await complete();
    expect(res.status).toBe(200);
    expect(exchangeCodeForTokens).toHaveBeenCalledOnce();
    expect(jar.get('jmap_rt')).toBe('rt');
  });
});

describe('/api/auth/sso/complete for the mobile app handoff', () => {
  // The app renews with client_id only, at a token endpoint on the mail
  // server's or the webmail's host. Anything else goes through the webmail.
  const mobile = () => pending({
    redirect_uri: 'https://webmail.example/mail/en/auth/callback',
    mobile_redirect_uri: 'bulwarkmobile://auth/callback',
    mobile_state: 'm-1',
  });

  it('hands a public client on the mail server straight to the app', async () => {
    tokenEndpoint = 'https://mail.example.org/auth/token';
    mobile();
    const res = await complete();
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      refresh_token: 'rt',
      token_endpoint: 'https://mail.example.org/auth/token',
      client_id: 'webmail',
      server_url: 'https://mail.example.org',
      mobile_state: 'm-1',
    });
    expect(jar.has('jmap_rt')).toBe(false);
  });

  it('renews a confidential client through the webmail, with a sealed token', async () => {
    tokenEndpoint = 'https://mail.example.org/auth/token';
    confidential = true;
    mobile();
    const res = await complete();
    expect(res.body.token_endpoint).toBe('https://webmail.example/mail/api/auth/pair/token');
    expect(res.body.refresh_token).not.toBe('rt');
    expect(openPhoneRefreshToken(res.body.refresh_token)).toMatchObject({
      refreshToken: 'rt',
      clientId: 'webmail',
      tokenEndpoint: 'https://mail.example.org/auth/token',
      trusted: true,
    });
  });

  it('renews through the webmail when the provider is on a host the app refuses', async () => {
    mobile();
    const res = await complete();
    expect(res.body.token_endpoint).toBe('https://webmail.example/mail/api/auth/pair/token');
    expect(openPhoneRefreshToken(res.body.refresh_token)?.tokenEndpoint).toBe('https://idp.example.net/token');
  });
});
