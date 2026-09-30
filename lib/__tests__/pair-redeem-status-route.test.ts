// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

// POST /api/auth/pair/redeem (the phone) and GET /api/auth/pair/status (the
// desktop polling its QR), against a seeded pairing store and real crypto.

vi.mock('@/lib/auth/session-secret', () => ({
  getSessionSecret: () => 's'.repeat(64),
  hasSessionSecret: () => true,
}));
vi.mock('@/lib/logger', () => ({
  logger: { warn: () => {}, error: () => {}, info: () => {}, debug: () => {} },
}));

import {
  CODE_TTL_MS,
  createPairingCode,
  resetPairingStoreForTests,
  stashGrant,
  type PairingGrant,
} from '@/lib/auth/pairing-store';
import { openPhoneRefreshToken } from '@/lib/auth/pair-bundle';
import { POST as redeemPOST } from '@/app/api/auth/pair/redeem/route';
import { GET as statusGET } from '@/app/api/auth/pair/status/route';

const SERVER = 'https://mail.example.org';
const WEBMAIL = 'https://webmail.example/mail';
const OWNER = '0:alice@example.org';

function oauthGrant(overrides: Partial<Extract<PairingGrant, { flow: 'oauth' }>> = {}): PairingGrant {
  return {
    flow: 'oauth',
    serverUrl: SERVER,
    serverId: null,
    accessToken: 'access-1',
    refreshToken: 'refresh-1',
    expiresIn: 3600,
    issuedAt: Date.now(),
    tokenEndpoint: `${SERVER}/auth/token`,
    clientId: 'bulwark-webmail',
    confidential: false,
    trusted: true,
    ...overrides,
  };
}

function seed(grant: PairingGrant = oauthGrant(), now = Date.now(), base: string | null = WEBMAIL) {
  const grantId = stashGrant(grant, OWNER, now);
  const pairing = createPairingCode(grantId, OWNER, base, now);
  if (!pairing) throw new Error('expected a code');
  return { grantId, ...pairing };
}

async function redeem(body: unknown, headers: Record<string, string> = {}) {
  const res = await redeemPOST(new NextRequest(`${WEBMAIL}/api/auth/pair/redeem`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  }));
  return { status: res.status, body: await res.json(), cacheControl: res.headers.get('cache-control') };
}

async function status(query: string) {
  const res = await statusGET(new NextRequest(`${WEBMAIL}/api/auth/pair/status${query}`));
  return { status: (await res.json()).status as string, cacheControl: res.headers.get('cache-control') };
}

beforeEach(() => {
  resetPairingStoreForTests();
});

describe('pair/redeem', () => {
  it.each([
    ['no code', {}],
    ['a number', { pairing_code: 42 }],
    ['too short', { pairing_code: 'ab'.repeat(16) }],
    ['uppercase hex', { pairing_code: 'AB'.repeat(32) }],
    ['not hex', { pairing_code: 'zz'.repeat(32) }],
    ['a body that is not JSON', 'pairing_code=abc'],
  ])('rejects %s as invalid_code', async (_label, body) => {
    const res = await redeem(body);
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: 'invalid_code' });
    expect(res.cacheControl).toBe('no-store');
  });

  it('rejects a well-formed code nobody issued', async () => {
    const res = await redeem({ pairing_code: '0'.repeat(64) });
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: 'invalid_code' });
    expect(res.cacheControl).toBe('no-store');
  });

  it('rejects an expired code with 410 expired_code', async () => {
    const { code } = seed(oauthGrant(), Date.now() - CODE_TTL_MS - 1000);
    const res = await redeem({ pairing_code: code });
    expect(res.status).toBe(410);
    expect(res.body).toEqual({ error: 'expired_code' });
    expect(res.cacheControl).toBe('no-store');
  });

  it('hands the grant out once, then answers 410 used_code', async () => {
    const { code } = seed();
    const first = await redeem({ pairing_code: code });
    expect(first.status).toBe(200);
    expect(first.cacheControl).toBe('no-store');

    const again = await redeem({ pairing_code: code });
    expect(again.status).toBe(410);
    expect(again.body).toEqual({ error: 'used_code' });
    expect(again.cacheControl).toBe('no-store');
  });

  it('is open to the phone, which sends no browser headers', async () => {
    const { code } = seed();
    expect((await redeem({ pairing_code: code })).status).toBe(200);
  });

  it('refuses a cross-site browser request', async () => {
    const { code } = seed();
    const res = await redeem({ pairing_code: code }, { 'sec-fetch-site': 'cross-site', origin: 'https://evil.example' });
    expect(res.status).toBe(403);
    // ...without burning the code.
    expect((await redeem({ pairing_code: code })).status).toBe(200);
  });

  it('points a public client at the provider with the raw refresh token', async () => {
    const { code } = seed();
    const res = await redeem({ pairing_code: code });
    expect(res.body).toMatchObject({
      flow: 'oauth',
      server_url: SERVER,
      access_token: 'access-1',
      refresh_token: 'refresh-1',
      token_endpoint: `${SERVER}/auth/token`,
      client_id: 'bulwark-webmail',
    });
  });

  it('proxies a confidential client through the webmail with a sealed refresh token', async () => {
    const { code } = seed(oauthGrant({ confidential: true, serverId: 'main' }));
    const res = await redeem({ pairing_code: code });
    expect(res.status).toBe(200);
    expect(res.body.token_endpoint).toBe(`${WEBMAIL}/api/auth/pair/token`);
    expect(res.body.refresh_token).not.toBe('refresh-1');
    expect(res.body.refresh_token).not.toContain('refresh-1');
    expect(openPhoneRefreshToken(res.body.refresh_token)).toEqual({
      refreshToken: 'refresh-1',
      serverId: 'main',
      clientId: 'bulwark-webmail',
      tokenEndpoint: `${SERVER}/auth/token`,
      trusted: true,
    });
  });

  it('proxies an external IdP on another host', async () => {
    const endpoint = 'https://login.idp-vendor.example/realms/acme/protocol/openid-connect/token';
    const { code } = seed(oauthGrant({ tokenEndpoint: endpoint, clientId: 'webmail', confidential: false }));
    const res = await redeem({ pairing_code: code });
    expect(res.body.token_endpoint).toBe(`${WEBMAIL}/api/auth/pair/token`);
    expect(res.body.client_id).toBe('webmail');
    expect(openPhoneRefreshToken(res.body.refresh_token)).toMatchObject({ refreshToken: 'refresh-1', tokenEndpoint: endpoint });
  });

  it('counts the access token lifetime from when it was issued', async () => {
    const { code } = seed(oauthGrant({ issuedAt: Date.now() - 90_000, expiresIn: 300 }));
    const res = await redeem({ pairing_code: code });
    expect(res.body.expires_in).toBeGreaterThanOrEqual(209);
    expect(res.body.expires_in).toBeLessThanOrEqual(210);
  });

  it('hands out a password grant as username and password', async () => {
    const { code } = seed({
      flow: 'password',
      serverUrl: SERVER,
      username: 'alice@example.org',
      password: 'app_secret',
      credential: 'app-password',
    });
    const res = await redeem({ pairing_code: code });
    expect(res.body).toEqual({ flow: 'password', server_url: SERVER, username: 'alice@example.org', password: 'app_secret' });
    expect(res.cacheControl).toBe('no-store');
  });
});

describe('pair/status', () => {
  it('reports pending, then redeemed', async () => {
    const { code, statusId } = seed();
    expect(await status(`?id=${statusId}`)).toEqual({ status: 'pending', cacheControl: 'no-store' });
    await redeem({ pairing_code: code });
    expect((await status(`?id=${statusId}`)).status).toBe('redeemed');
  });

  it('reports a code replaced by a newer QR as expired', async () => {
    const first = seed();
    createPairingCode(first.grantId, OWNER, WEBMAIL);
    expect((await status(`?id=${first.statusId}`)).status).toBe('expired');
  });

  it('does not accept the pairing code itself as a status id', async () => {
    const { code } = seed();
    expect((await status(`?id=${code}`)).status).toBe('unknown');
    expect((await status(`?id=${code.slice(0, 32)}`)).status).toBe('unknown');
  });

  it.each([
    ['no id', ''],
    ['an empty id', '?id='],
    ['a malformed id', '?id=not-hex'],
    ['an unknown id', `?id=${'0'.repeat(32)}`],
    ['an uppercase id', `?id=${'A'.repeat(32)}`],
  ])('answers unknown for %s', async (_label, query) => {
    expect(await status(query)).toEqual({ status: 'unknown', cacheControl: 'no-store' });
  });
});
