// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

// POST /api/auth/reauth/sso/complete: the IdP step-up for "Link mobile app".
// The fresh login becomes the phone's grant, kept server-side, and the
// encrypted pair_reauth cookie remembers which grant for which account. The
// token exchange is mocked; identity verification runs for real against a
// fake /.well-known/jmap.

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

const config: Record<string, unknown> = {};
vi.mock('@/lib/admin/config-manager', () => ({
  configManager: {
    ensureLoaded: async () => {},
    get: (key: string, fallback: unknown) => (key in config ? config[key] : fallback),
  },
}));

const exchangeCodeForTokens = vi.fn();
let confidential = false;
vi.mock('@/lib/oauth/token-exchange', () => ({
  exchangeCodeForTokens: (...args: unknown[]) => exchangeCodeForTokens(...args),
  getTokenEndpoint: async (serverId?: string | null) =>
    (serverId ? `https://idp.example.net/${serverId}/token` : 'https://idp.example.net/token'),
  getRequiredConfig: (serverId?: string | null) => ({
    clientId: serverId ? `client-${serverId}` : 'webmail-client',
    serverUrl: 'https://mail.example.org',
    discoveryUrl: 'https://idp.example.net',
  }),
  hasClientSecret: () => confidential,
  getClientSecret: () => (confidential ? 'webmail-client-secret' : ''),
  DEFAULT_CLIENT_ID: 'bulwark-webmail',
}));

import { encryptPayload } from '@/lib/auth/crypto';
import { setStalwartAuthContextInStore } from '@/lib/stalwart/auth-context';
import { readPairReauthFromStore } from '@/lib/auth/pair-reauth';
import {
  createPairingCode,
  isGrantAvailable,
  redeemPairingCode,
  resetPairingStoreForTests,
} from '@/lib/auth/pairing-store';
import { openPhoneRefreshToken } from '@/lib/auth/pair-bundle';
import { POST as completePOST } from '@/app/api/auth/reauth/sso/complete/route';
import { POST as createPOST } from '@/app/api/auth/pair/create/route';
import { POST as redeemPOST } from '@/app/api/auth/pair/redeem/route';

const SERVER = 'https://mail.example.org';
const WEBMAIL = 'https://webmail.example';
const USER = 'alice@example.org';
const FRESH = { access_token: 'fresh-access', refresh_token: 'fresh-refresh', expires_in: 300 };

/** Username the fake JMAP server reports for the fresh token. */
let sessionUser = USER;
const jmapCalls: Array<{ url: string; authorization: string | null }> = [];

function pending(overrides: Record<string, unknown> = {}) {
  jar.set('sso_pending', encryptPayload({
    state: 'state-1',
    code_verifier: 'verifier-1',
    redirect_uri: `${WEBMAIL}/auth/callback`,
    created_at: Date.now(),
    purpose: 'reauth',
    slot: 0,
    ...overrides,
  }, 'sso-pending'));
}

function signIn(slot: number, username = USER) {
  setStalwartAuthContextInStore(cookieStore as never, slot, { serverUrl: SERVER, username, authHeader: 'Bearer desktop' });
}

async function complete(body: Record<string, unknown> = { code: 'code-1', state: 'state-1' }) {
  const res = await completePOST(new NextRequest(`${WEBMAIL}/api/auth/reauth/sso/complete`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'sec-fetch-site': 'same-origin' },
    body: JSON.stringify(body),
  }));
  return { status: res.status, body: await res.json() };
}

function grantCount(): number {
  return (globalThis as unknown as { __bulwarkPairingStore: { grants: Map<string, unknown> } })
    .__bulwarkPairingStore.grants.size;
}

beforeEach(() => {
  jar.clear();
  for (const key of Object.keys(config)) delete config[key];
  config.jmapServerUrl = SERVER;
  confidential = false;
  sessionUser = USER;
  jmapCalls.length = 0;
  resetPairingStoreForTests();
  exchangeCodeForTokens.mockReset().mockResolvedValue({ ...FRESH });
  vi.stubGlobal('fetch', vi.fn(async (input: unknown, init: RequestInit = {}) => {
    const url = String(input);
    jmapCalls.push({ url, authorization: new Headers(init.headers).get('authorization') });
    if (url === `${SERVER}/.well-known/jmap`) {
      return new Response(JSON.stringify({ apiUrl: `${SERVER}/jmap/`, username: sessionUser, accounts: {} }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }
    return new Response('not found', { status: 404 });
  }));
  signIn(0);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('reauth/sso/complete', () => {
  it('stores the fresh login as a grant and sets the pairing proof for the slot', async () => {
    signIn(2);
    pending({ slot: 2 });
    const res = await complete();
    expect(res).toEqual({ status: 200, body: { ok: true } });
    expect(jar.has('sso_pending')).toBe(false);

    expect(exchangeCodeForTokens).toHaveBeenCalledWith('code-1', 'verifier-1', `${WEBMAIL}/auth/callback`, null);
    // The fresh token was checked against the account being paired.
    expect(jmapCalls).toEqual([{ url: `${SERVER}/.well-known/jmap`, authorization: 'Bearer fresh-access' }]);

    const proof = readPairReauthFromStore(cookieStore as never);
    expect(proof?.owner).toBe(`2:${USER}`);
    expect(isGrantAvailable(proof!.grantId, `2:${USER}`)).toBe(true);

    const pairing = createPairingCode(proof!.grantId, `2:${USER}`, WEBMAIL)!;
    const redeemed = redeemPairingCode(pairing.code);
    expect(redeemed).toMatchObject({
      ok: true,
      grant: {
        flow: 'oauth',
        serverUrl: SERVER,
        serverId: null,
        accessToken: 'fresh-access',
        refreshToken: 'fresh-refresh',
        expiresIn: 300,
        tokenEndpoint: 'https://idp.example.net/token',
        clientId: 'webmail-client',
        confidential: false,
        trusted: true,
      },
    });
  });

  it('uses the server entry the re-auth was started for', async () => {
    confidential = true;
    pending({ server_id: 'corp' });
    expect((await complete()).status).toBe(200);
    expect(exchangeCodeForTokens).toHaveBeenCalledWith('code-1', 'verifier-1', `${WEBMAIL}/auth/callback`, 'corp');
    const proof = readPairReauthFromStore(cookieStore as never)!;
    const pairing = createPairingCode(proof.grantId, proof.owner, WEBMAIL)!;
    expect(redeemPairingCode(pairing.code)).toMatchObject({
      ok: true,
      grant: { serverId: 'corp', tokenEndpoint: 'https://idp.example.net/corp/token', clientId: 'client-corp', confidential: true },
    });
  });

  it('lets pair/create show a QR for the grant, which the phone renews through the proxy', async () => {
    pending();
    await complete();

    const create = await createPOST(new NextRequest(`${WEBMAIL}/api/auth/pair/create`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'sec-fetch-site': 'same-origin', origin: WEBMAIL },
      body: JSON.stringify({ slot: 0, webmail_base: `${WEBMAIL}/` }),
    }));
    expect(create.status).toBe(200);
    const { pairing_code: code } = await create.json();

    const redeem = await redeemPOST(new NextRequest(`${WEBMAIL}/api/auth/pair/redeem`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ pairing_code: code }),
    }));
    const bundle = await redeem.json();
    // The IdP lives on a host the app refuses: the webmail proxies renewals.
    expect(bundle).toMatchObject({
      flow: 'oauth',
      server_url: SERVER,
      access_token: 'fresh-access',
      token_endpoint: `${WEBMAIL}/api/auth/pair/token`,
      client_id: 'webmail-client',
    });
    expect(openPhoneRefreshToken(bundle.refresh_token)).toEqual({
      refreshToken: 'fresh-refresh',
      serverId: null,
      clientId: 'webmail-client',
      tokenEndpoint: 'https://idp.example.net/token',
      trusted: true,
    });
  });

  it('refuses a fresh login as another account', async () => {
    sessionUser = 'mallory@example.org';
    pending();
    const res = await complete();
    expect(res).toEqual({ status: 403, body: { error: 'account_mismatch' } });
    expect(jar.has('pair_reauth')).toBe(false);
    expect(grantCount()).toBe(0);
  });

  it('refuses a fresh token the mail server rejects', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('unauthorized', { status: 401 })));
    pending();
    expect(await complete()).toEqual({ status: 403, body: { error: 'account_mismatch' } });
    expect(jar.has('pair_reauth')).toBe(false);
  });

  it('fails without a refresh token instead of pairing a phone that signs out in minutes', async () => {
    exchangeCodeForTokens.mockResolvedValue({ access_token: 'fresh-access', expires_in: 300 });
    pending();
    const res = await complete();
    expect(res).toEqual({ status: 502, body: { error: 'no_refresh_token' } });
    expect(jar.has('pair_reauth')).toBe(false);
    expect(grantCount()).toBe(0);
  });

  it('treats a pending state from before slots existed as slot 0', async () => {
    pending({ slot: undefined });
    expect((await complete()).status).toBe(200);
    expect(readPairReauthFromStore(cookieStore as never)?.owner).toBe(`0:${USER}`);
  });

  it('uses slot 0 for a pending state without slot even when another slot is signed in', async () => {
    jar.clear();
    signIn(1);
    pending({ slot: undefined });
    expect(await complete()).toEqual({ status: 401, body: { error: 'not_signed_in' } });
    expect(exchangeCodeForTokens).not.toHaveBeenCalled();
  });

  it('falls back to slot 0 for an out-of-range slot', async () => {
    pending({ slot: 999 });
    expect((await complete()).status).toBe(200);
    expect(readPairReauthFromStore(cookieStore as never)?.owner).toBe(`0:${USER}`);
  });

  it('refuses a pending state from a normal login', async () => {
    pending({ purpose: undefined, slot: undefined });
    const res = await complete();
    expect(res).toEqual({ status: 400, body: { error: 'Not a re-auth session' } });
    expect(exchangeCodeForTokens).not.toHaveBeenCalled();
    expect(jar.has('sso_pending')).toBe(false);
    expect(jar.has('pair_reauth')).toBe(false);
  });

  it('refuses a state mismatch', async () => {
    pending();
    expect((await complete({ code: 'code-1', state: 'other' })).status).toBe(400);
    expect(exchangeCodeForTokens).not.toHaveBeenCalled();
    expect(jar.has('pair_reauth')).toBe(false);
  });

  it('refuses an expired pending state', async () => {
    pending({ created_at: Date.now() - 6 * 60 * 1000 });
    expect(await complete()).toEqual({ status: 400, body: { error: 'Re-auth session expired' } });
    expect(exchangeCodeForTokens).not.toHaveBeenCalled();
  });

  it('refuses without a pending cookie, or with one minted for another purpose', async () => {
    expect((await complete()).status).toBe(400);
    jar.set('sso_pending', encryptPayload({ state: 'state-1', purpose: 'reauth', created_at: Date.now() }, 'pair-reauth'));
    expect(await complete()).toEqual({ status: 400, body: { error: 'Invalid re-auth session' } });
    expect(exchangeCodeForTokens).not.toHaveBeenCalled();
  });

  it('needs the slot to be signed in', async () => {
    jar.clear();
    pending();
    expect(await complete()).toEqual({ status: 401, body: { error: 'not_signed_in' } });
    expect(exchangeCodeForTokens).not.toHaveBeenCalled();
  });

  it('reports a failed code exchange without setting a proof', async () => {
    exchangeCodeForTokens.mockRejectedValue(new Error('Token exchange failed'));
    pending();
    expect(await complete()).toEqual({ status: 401, body: { error: 'Re-authentication failed' } });
    expect(jar.has('pair_reauth')).toBe(false);
    expect(jar.has('sso_pending')).toBe(false);
  });

  it('replaces the previous grant, so its QR stops working', async () => {
    pending();
    await complete();
    const first = readPairReauthFromStore(cookieStore as never)!;
    const firstCode = createPairingCode(first.grantId, first.owner, WEBMAIL)!;

    pending();
    await complete();
    const second = readPairReauthFromStore(cookieStore as never)!;
    expect(second.grantId).not.toBe(first.grantId);
    expect(redeemPairingCode(firstCode.code)).toEqual({ ok: false, reason: 'expired' });
  });
});

describe('reauth/sso/complete freshness', () => {
  const idToken = (claims: Record<string, unknown>) =>
    `h.${Buffer.from(JSON.stringify(claims)).toString('base64url')}.s`;

  it('refuses a login the provider did not make fresh (old auth_time)', async () => {
    signIn(0);
    pending({ created_at: Date.now() });
    exchangeCodeForTokens.mockResolvedValue({ ...FRESH, id_token: idToken({ auth_time: Math.floor(Date.now() / 1000) - 3600 }) });
    const res = await complete();
    expect(res).toEqual({ status: 401, body: { error: 'reauth_not_fresh' } });
    expect(readPairReauthFromStore(cookieStore as never)).toBeNull();
  });

  it('accepts a fresh auth_time, and an ID token without one', async () => {
    signIn(0);
    pending({ created_at: Date.now() });
    exchangeCodeForTokens.mockResolvedValue({ ...FRESH, id_token: idToken({ auth_time: Math.floor(Date.now() / 1000) }) });
    expect((await complete()).status).toBe(200);
    pending({ created_at: Date.now() });
    exchangeCodeForTokens.mockResolvedValue({ ...FRESH, id_token: idToken({ sub: 'x' }) });
    expect((await complete()).status).toBe(200);
  });
});
