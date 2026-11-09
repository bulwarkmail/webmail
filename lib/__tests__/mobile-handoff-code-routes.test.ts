// @vitest-environment node
import { createHash } from 'crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

// The code hand-off to the mobile app (bulwarkmail.org/docs/development/mobile-handoff): the browser
// parks the sign-in (/api/auth/handoff/create, or /api/auth/sso/complete plus
// /api/auth/handoff/confirm), the app link carries only a code, and the app
// redeems it with its PKCE verifier (/api/auth/handoff/redeem). Wrong
// verifier, reuse and expiry are 400s, and every attempt spends the code.

vi.mock('@/lib/logger', () => ({
  logger: { warn: () => {}, error: () => {}, info: () => {}, debug: () => {} },
}));

import { HANDOFF_CONFIRM_TTL_MS, HANDOFF_TTL_MS, resetHandoffStoreForTests, stashHandoff } from '@/lib/auth/handoff-store';
import { POST as createPOST } from '@/app/api/auth/handoff/create/route';
import { POST as confirmPOST } from '@/app/api/auth/handoff/confirm/route';
import { POST as redeemPOST } from '@/app/api/auth/handoff/redeem/route';

const WEBMAIL = 'https://webmail.example';
const VERIFIER = 'v'.repeat(43) + '-._~0123456789';
const CHALLENGE = createHash('sha256').update(VERIFIER).digest('base64url');
const OTHER_VERIFIER = 'w'.repeat(64);

// Each test talks from its own address, so the per-client limits of one test
// don't leak into the next.
let ip = 0;
let clientIp = '';

async function call(handler: (req: NextRequest) => Promise<Response>, path: string, body: unknown) {
  const res = await handler(new NextRequest(`${WEBMAIL}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-forwarded-for': clientIp },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  }));
  return { status: res.status, body: await res.json(), cacheControl: res.headers.get('cache-control') };
}

const create = (body: unknown) => call(createPOST, '/api/auth/handoff/create', body);
const confirm = (body: unknown) => call(confirmPOST, '/api/auth/handoff/confirm', body);
const redeem = (body: unknown) => call(redeemPOST, '/api/auth/handoff/redeem', body);

const PASSWORD_SIGN_IN = {
  code_challenge: CHALLENGE,
  state: 'm-1',
  server_url: 'https://mail.example.org',
  username: 'alice@example.org',
  password: 'secret',
};

beforeEach(() => {
  resetHandoffStoreForTests();
  ip += 1;
  clientIp = `203.0.113.${ip}`;
});

afterEach(() => {
  vi.useRealTimers();
});

describe('password hand-off', () => {
  it('gives the app the sign-in for the code and the right verifier, once', async () => {
    const created = await create(PASSWORD_SIGN_IN);
    expect(created.status).toBe(200);
    expect(created.body.code).toMatch(/^[0-9a-f]{64}$/);
    expect(JSON.stringify(created.body)).not.toContain('secret');
    expect(created.cacheControl).toBe('no-store');

    const first = await redeem({ code: created.body.code, code_verifier: VERIFIER });
    expect(first.status).toBe(200);
    expect(first.body).toEqual({
      flow: 'password',
      server_url: 'https://mail.example.org',
      username: 'alice@example.org',
      password: 'secret',
      state: 'm-1',
    });
    expect(first.cacheControl).toBe('no-store');

    const again = await redeem({ code: created.body.code, code_verifier: VERIFIER });
    expect(again.status).toBe(400);
    expect(again.body).toEqual({ error: 'invalid_code' });
  });

  it('spends the code on a wrong verifier', async () => {
    const { body } = await create(PASSWORD_SIGN_IN);
    const wrong = await redeem({ code: body.code, code_verifier: OTHER_VERIFIER });
    expect(wrong.status).toBe(400);
    expect(wrong.body).toEqual({ error: 'invalid_verifier' });

    const right = await redeem({ code: body.code, code_verifier: VERIFIER });
    expect(right.status).toBe(400);
    expect(right.body.password).toBeUndefined();
  });

  it('spends the code on a malformed verifier', async () => {
    const { body } = await create(PASSWORD_SIGN_IN);
    const wrong = await redeem({ code: body.code, code_verifier: 'short' });
    expect(wrong.status).toBe(400);
    expect(wrong.body).toEqual({ error: 'invalid_verifier' });
    expect((await redeem({ code: body.code, code_verifier: VERIFIER })).status).toBe(400);
  });

  it('expires the code after 60 seconds', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const { body } = await create(PASSWORD_SIGN_IN);
    vi.setSystemTime(Date.now() + HANDOFF_TTL_MS + 1);
    const late = await redeem({ code: body.code, code_verifier: VERIFIER });
    expect(late.status).toBe(400);
    expect(late.body).toEqual({ error: 'expired_code' });
  });

  it('still redeems just before the 60 seconds are up', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const { body } = await create(PASSWORD_SIGN_IN);
    vi.setSystemTime(Date.now() + HANDOFF_TTL_MS - 1000);
    expect((await redeem({ code: body.code, code_verifier: VERIFIER })).status).toBe(200);
  });

  it.each([
    ['no challenge', { ...PASSWORD_SIGN_IN, code_challenge: undefined }],
    ['a plain challenge', { ...PASSWORD_SIGN_IN, code_challenge: 'abc' }],
    ['a padded challenge', { ...PASSWORD_SIGN_IN, code_challenge: `${CHALLENGE.slice(0, 42)}=` }],
    ['no password', { ...PASSWORD_SIGN_IN, password: '' }],
    ['no username', { ...PASSWORD_SIGN_IN, username: undefined }],
    ['no server', { ...PASSWORD_SIGN_IN, server_url: undefined }],
    ['a body that is not JSON', 'code_challenge=x'],
  ])('refuses to park %s', async (_label, body) => {
    const res = await create(body);
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: 'invalid_request' });
  });

  it('limits how many sign-ins one client parks', async () => {
    for (let i = 0; i < 10; i++) expect((await create(PASSWORD_SIGN_IN)).status).toBe(200);
    expect((await create(PASSWORD_SIGN_IN)).status).toBe(429);
  });
});

describe('redeem', () => {
  it.each([
    ['no code', { code_verifier: VERIFIER }],
    ['uppercase hex', { code: 'AB'.repeat(32), code_verifier: VERIFIER }],
    ['a body that is not JSON', 'code=x'],
  ])('refuses %s', async (_label, body) => {
    const res = await redeem(body);
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: 'invalid_request' });
  });

  it('answers invalid_code for a code nobody issued', async () => {
    const res = await redeem({ code: 'ab'.repeat(32), code_verifier: VERIFIER });
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: 'invalid_code' });
  });

  it('stops a client after ten failed redeems, and a success costs nothing', async () => {
    const { body } = await create(PASSWORD_SIGN_IN);
    expect((await redeem({ code: body.code, code_verifier: VERIFIER })).status).toBe(200);
    for (let i = 0; i < 10; i++) {
      expect((await redeem({ code: 'cd'.repeat(32), code_verifier: VERIFIER })).status).toBe(400);
    }
    expect((await redeem({ code: 'cd'.repeat(32), code_verifier: VERIFIER })).status).toBe(429);
  });
});

describe('SSO hand-off', () => {
  const bundle = {
    flow: 'oauth' as const,
    server_url: 'https://mail.example.org',
    access_token: 'at',
    refresh_token: 'rt',
    expires_in: 3600,
    token_endpoint: 'https://mail.example.org/auth/token',
    client_id: 'webmail',
  };

  it('redeems only after the user confirmed, for 60 seconds from then', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const start = Date.now();
    const code = await stashHandoff(bundle, { challenge: CHALLENGE, state: 'm-2', awaitConfirm: true });

    // The user reads the confirmation for a few minutes.
    vi.setSystemTime(start + HANDOFF_CONFIRM_TTL_MS - 1000);
    expect((await confirm({ code })).status).toBe(200);
    vi.setSystemTime(start + HANDOFF_CONFIRM_TTL_MS + HANDOFF_TTL_MS - 2000);

    const res = await redeem({ code, code_verifier: VERIFIER });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ flow: 'oauth', access_token: 'at', refresh_token: 'rt', state: 'm-2' });
    // Counted from when the tokens were issued, not from the redeem.
    expect(res.body.expires_in).toBe(3600 - Math.floor((HANDOFF_CONFIRM_TTL_MS + HANDOFF_TTL_MS - 2000) / 1000));
  });

  it('refuses and spends a code the user has not confirmed', async () => {
    const code = await stashHandoff(bundle, { challenge: CHALLENGE, state: 'm-2', awaitConfirm: true });
    const early = await redeem({ code, code_verifier: VERIFIER });
    expect(early.status).toBe(400);
    expect(early.body).toEqual({ error: 'invalid_code' });
    expect((await confirm({ code })).status).toBe(400);
  });

  it('expires 60 seconds after the confirmation', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const code = await stashHandoff(bundle, { challenge: CHALLENGE, state: 'm-2', awaitConfirm: true });
    expect((await confirm({ code })).status).toBe(200);
    vi.setSystemTime(Date.now() + HANDOFF_TTL_MS + 1);
    const late = await redeem({ code, code_verifier: VERIFIER });
    expect(late.status).toBe(400);
    expect(late.body).toEqual({ error: 'expired_code' });
  });

  it('cannot be confirmed once the five minutes to confirm are over', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const code = await stashHandoff(bundle, { challenge: CHALLENGE, state: 'm-2', awaitConfirm: true });
    vi.setSystemTime(Date.now() + HANDOFF_CONFIRM_TTL_MS + 1);
    expect((await confirm({ code })).status).toBe(400);
  });

  it('confirms a code once', async () => {
    const code = await stashHandoff(bundle, { challenge: CHALLENGE, state: 'm-2', awaitConfirm: true });
    expect((await confirm({ code })).status).toBe(200);
    expect((await confirm({ code })).status).toBe(400);
    expect((await confirm({ code: 'nope' })).status).toBe(400);
  });
});
