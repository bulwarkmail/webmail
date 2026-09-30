// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

// POST /api/auth/pair/create: the desktop side of "Link mobile app". The
// step-up (current password, optionally TOTP) is checked against the signed-in
// account's own mail server and mints the phone's sign-in; the route then
// hands out a one-time code for the QR. Real crypto and a Map-backed cookie
// jar, so the encrypted cookies round-trip for real; the mail server is a
// fake behind a stubbed fetch.

let sessionSecret = 's'.repeat(64);
vi.mock('@/lib/auth/session-secret', () => ({
  getSessionSecret: () => sessionSecret,
  hasSessionSecret: () => sessionSecret.length > 0,
}));

const logger = vi.hoisted(() => ({ warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() }));
vi.mock('@/lib/logger', () => ({ logger }));

const jar = new Map<string, string>();
const cookieWrites: Array<{ name: string; value: string; options?: Record<string, unknown> }> = [];
const cookieStore = {
  get: (name: string) => (jar.has(name) ? { name, value: jar.get(name)! } : undefined),
  set: (name: string, value: string, options?: Record<string, unknown>) => {
    jar.set(name, value);
    cookieWrites.push({ name, value, options });
  },
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

const publicFetch = vi.fn();
vi.mock('@/lib/security/url-guard', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/security/url-guard')>();
  return {
    ...actual,
    isPublicHttpUrl: async () => true,
    fetchPublicUrl: (...args: unknown[]) => publicFetch(...args),
  };
});

import { decryptPayload } from '@/lib/auth/crypto';
import { setStalwartAuthContextInStore, type StalwartAuthContext } from '@/lib/stalwart/auth-context';
import { IMPERSONATION_GRANT_COOKIE, sealImpersonationGrant } from '@/lib/impersonation/grant-cookie';
import { resetPairingStoreForTests, stashGrant, type PairingGrant } from '@/lib/auth/pairing-store';
import { readPairReauthFromStore, setPairReauthInStore } from '@/lib/auth/pair-reauth';
import { openPhoneRefreshToken } from '@/lib/auth/pair-bundle';
import { POST as createPOST } from '@/app/api/auth/pair/create/route';
import { POST as redeemPOST } from '@/app/api/auth/pair/redeem/route';
import { GET as statusGET } from '@/app/api/auth/pair/status/route';

const SERVER = 'https://mail.example.org';
const CUSTOM_SERVER = 'https://custom.example';
const WEBMAIL = 'https://webmail.example';
const USER = 'alice@example.org';
const PASSWORD = 'Tr0ub4dor&3-correct-horse';
const WRONG_PASSWORD = 'hunter2-wrong-guess';
const APP_SECRET = 'app_7bq9mobile-secret';
const TOKENS = { access_token: 'access-1', refresh_token: 'refresh-1', expires_in: 3600 };
const HOSTILE = 'http://169.254.169.254/latest/meta-data';

// --- fake mail server --------------------------------------------------------

interface UpstreamCall {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: string;
  redirect?: string;
  via: 'fetch' | 'public';
}
const calls: UpstreamCall[] = [];
type Handler = (call: UpstreamCall) => Response | Promise<Response>;
let handler: Handler;

function record(via: UpstreamCall['via']) {
  return async (input: unknown, init: RequestInit = {}) => {
    const headers: Record<string, string> = {};
    new Headers(init.headers as HeadersInit | undefined).forEach((value, key) => { headers[key] = value; });
    const call: UpstreamCall = {
      url: String(input),
      method: (init.method ?? 'GET').toUpperCase(),
      headers,
      body: typeof init.body === 'string' ? init.body : '',
      redirect: init.redirect,
      via,
    };
    calls.push(call);
    return handler(call);
  };
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

const authenticated = () => json({ type: 'authenticated', client_code: 'client-code-1' });

function basicFor(password: string): string {
  return `Basic ${Buffer.from(`${USER}:${password}`).toString('base64')}`;
}

interface ServerOptions {
  base?: string;
  /** Answer of /api/auth; defaults to a Stalwart that checks the password. */
  apiAuth?: (body: Record<string, unknown>) => Response | Promise<Response>;
  tokens?: () => Response;
  /** Whether the JMAP session advertises urn:stalwart:jmap. */
  stalwart?: boolean;
  appPassword?: () => Response;
}

function mailServer(opts: ServerOptions = {}): Handler {
  const base = opts.base ?? SERVER;
  return async (call) => {
    if (!call.url.startsWith(`${base}/`)) return new Response('no such host', { status: 502 });
    const path = call.url.slice(base.length);
    const basicOk = call.headers.authorization === basicFor(PASSWORD);
    if (path === '/api/auth' && call.method === 'POST') {
      const body = JSON.parse(call.body) as Record<string, unknown>;
      if (opts.apiAuth) return opts.apiAuth(body);
      return body.accountSecret === PASSWORD ? authenticated() : json({ type: 'failure' });
    }
    if (path === '/auth/token' && call.method === 'POST') return opts.tokens ? opts.tokens() : json(TOKENS);
    if (path === '/.well-known/jmap' || path === '/jmap/session') {
      if (!basicOk) return new Response('unauthorized', { status: 401 });
      if (path === '/jmap/session' && !opts.stalwart) return new Response('not found', { status: 404 });
      const caps: Record<string, unknown> = { 'urn:ietf:params:jmap:mail': {} };
      if (opts.stalwart) caps['urn:stalwart:jmap'] = {};
      return json({
        apiUrl: `${base}/jmap/`,
        username: USER,
        primaryAccounts: { 'urn:ietf:params:jmap:mail': 'a1' },
        accounts: { a1: { name: USER, accountCapabilities: caps } },
        capabilities: {},
      });
    }
    if (path === '/jmap/' && call.method === 'POST') {
      if (!basicOk) return new Response('unauthorized', { status: 401 });
      if (opts.appPassword) return opts.appPassword();
      return json({ methodResponses: [['x:AppPassword/set', { created: { imp: { id: 'ap-1', secret: APP_SECRET } } }, '0']] });
    }
    return new Response('not found', { status: 404 });
  };
}

const noStructuredLogin = () => new Response('not found', { status: 404 });

function apiAuthCalls() {
  return calls.filter((c) => c.url.endsWith('/api/auth')).map((c) => JSON.parse(c.body) as Record<string, unknown>);
}
function tokenCalls() {
  return calls.filter((c) => c.url.endsWith('/auth/token')).map((c) => Object.fromEntries(new URLSearchParams(c.body)));
}

// --- requests ------------------------------------------------------------------

const createResponses: string[] = [];

async function create(body: Record<string, unknown> = {}, headers: Record<string, string | undefined> = {}) {
  const merged: Record<string, string | undefined> = {
    'content-type': 'application/json',
    'sec-fetch-site': 'same-origin',
    origin: WEBMAIL,
    ...headers,
  };
  const h: Record<string, string> = {};
  for (const [k, v] of Object.entries(merged)) if (v !== undefined) h[k] = v;
  const res = await createPOST(new NextRequest(`${WEBMAIL}/api/auth/pair/create`, {
    method: 'POST',
    headers: h,
    body: JSON.stringify({ webmail_base: `${WEBMAIL}/`, ...body }),
  }));
  const data = await res.json();
  createResponses.push(JSON.stringify(data));
  return { status: res.status, body: data, cacheControl: res.headers.get('cache-control') };
}

async function redeem(code: string) {
  const res = await redeemPOST(new NextRequest(`${WEBMAIL}/api/auth/pair/redeem`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ pairing_code: code }),
  }));
  return { status: res.status, body: await res.json() };
}

async function status(id: string) {
  const res = await statusGET(new NextRequest(`${WEBMAIL}/api/auth/pair/status?id=${encodeURIComponent(id)}`));
  return (await res.json()).status as string;
}

function signIn(slot: number, context: Partial<StalwartAuthContext> = {}) {
  setStalwartAuthContextInStore(cookieStore as never, slot, {
    serverUrl: SERVER,
    username: USER,
    authHeader: 'Bearer desktop-session-token',
    ...context,
  });
}

function proofCookie(): Record<string, unknown> | null {
  const raw = jar.get('pair_reauth');
  return raw ? decryptPayload(raw, 'pair-reauth') : null;
}

function allLoggerCalls(): string {
  return JSON.stringify([logger.warn, logger.error, logger.info, logger.debug].map((fn) => fn.mock.calls));
}

beforeEach(() => {
  sessionSecret = 's'.repeat(64);
  jar.clear();
  for (const key of Object.keys(config)) delete config[key];
  config.jmapServerUrl = SERVER;
  vi.stubEnv('OAUTH_CLIENT_ID', '');
  vi.stubEnv('OAUTH_CLIENT_SECRET', '');
  vi.stubEnv('OAUTH_CLIENT_SECRET_FILE', '');
  resetPairingStoreForTests();
  delete (globalThis as Record<string, unknown>).__bulwarkPairAttempts;
  calls.length = 0;
  handler = mailServer();
  vi.stubGlobal('fetch', vi.fn(record('fetch')));
  publicFetch.mockReset().mockImplementation(record('public'));
  for (const fn of Object.values(logger)) fn.mockClear();
  signIn(0);
  cookieWrites.length = 0;
  createResponses.length = 0;
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

// --- tests -----------------------------------------------------------------------

describe('pair/create gatekeeping', () => {
  it('refuses a cross-site request before doing anything', async () => {
    const res = await create({ password: PASSWORD }, { 'sec-fetch-site': 'cross-site', origin: 'https://evil.example' });
    expect(res.status).toBe(403);
    expect(calls).toHaveLength(0);
    expect(cookieWrites).toHaveLength(0);
  });

  it('needs SESSION_SECRET', async () => {
    sessionSecret = '';
    const res = await create({ password: PASSWORD });
    expect(res.status).toBe(500);
    expect(res.body).toEqual({ error: 'session_secret_required' });
    expect(calls).toHaveLength(0);
  });

  it.each([
    ['missing', undefined],
    ['not a string', 42],
    ['another origin than the request', 'https://evil.example/'],
    ['another port', 'https://webmail.example:8443/'],
    ['plain http for an https origin', 'http://webmail.example/'],
    ['a query string', `${WEBMAIL}/?next=/x`],
    ['a fragment', `${WEBMAIL}/#x`],
    ['credentials', 'https://user:pw@webmail.example/'],
    ['another scheme', 'javascript:alert(1)'],
    ['not a URL', 'webmail.example'],
  ])('rejects a webmail_base that is %s', async (_label, base) => {
    const res = await create({ webmail_base: base, password: PASSWORD });
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: 'invalid_request' });
    expect(calls).toHaveLength(0);
  });

  it('checks webmail_base against Host when the browser sent no Origin', async () => {
    const noOrigin = { origin: undefined, host: 'webmail.example' };
    expect((await create({}, noOrigin)).body).toEqual({ error: 'reauth_required' });
    expect((await create({}, { origin: undefined, host: 'other.example' })).status).toBe(400);
    expect(
      (await create({}, { origin: undefined, host: 'internal:3000', 'x-forwarded-host': 'webmail.example' })).body,
    ).toEqual({ error: 'reauth_required' });
  });

  it('needs a signed-in session context for the slot', async () => {
    const res = await create({ slot: 2, password: PASSWORD });
    expect(res.status).toBe(401);
    expect(res.body).toEqual({ error: 'not_signed_in' });
    expect(calls).toHaveLength(0);
  });

  it('falls back to slot 0 for a malformed slot', async () => {
    signIn(1, { username: 'bob@example.org' });
    for (const slot of ['1', 1.5, -1, 99]) {
      const res = await create({ slot, password: PASSWORD });
      expect(res.status).toBe(200);
      expect(proofCookie()?.owner).toBe(`0:${USER}`);
    }
  });

  it('refuses an impersonation (support) session on slot 0', async () => {
    jar.set(IMPERSONATION_GRANT_COOKIE, sealImpersonationGrant({ serverUrl: SERVER, mailbox: USER, credentialId: 'c1' }));
    const res = await create({ password: PASSWORD });
    expect(res.status).toBe(403);
    expect(res.body).toEqual({ error: 'impersonation' });
    expect(calls).toHaveLength(0);
    expect(jar.has('pair_reauth')).toBe(false);

    // Other slots are real sign-ins.
    signIn(1);
    expect((await create({ slot: 1 })).body).toEqual({ error: 'reauth_required' });
  });

  it('asks for a step-up when there is neither a password nor a proof', async () => {
    const res = await create({});
    expect(res.status).toBe(401);
    expect(res.body).toEqual({ error: 'reauth_required' });
    expect(calls).toHaveLength(0);
  });

  it('does not accept a proof for another slot or another user', async () => {
    signIn(1, { username: 'bob@example.org' });

    setPairReauthInStore(cookieStore as never, { grantId: stashGrant(grant(), '1:bob@example.org'), owner: '1:bob@example.org' });
    expect(await create({ slot: 0 })).toMatchObject({ status: 401, body: { error: 'reauth_required' } });

    setPairReauthInStore(cookieStore as never, { grantId: stashGrant(grant(), `1:${USER}`), owner: `1:${USER}` });
    expect(await create({ slot: 0 })).toMatchObject({ status: 401, body: { error: 'reauth_required' } });

    setPairReauthInStore(cookieStore as never, { grantId: stashGrant(grant(), '0:mallory@example.org'), owner: '0:mallory@example.org' });
    expect(await create({ slot: 0 })).toMatchObject({ status: 401, body: { error: 'reauth_required' } });

    // The proof's own account gets a code.
    setPairReauthInStore(cookieStore as never, { grantId: stashGrant(grant(), `0:${USER}`), owner: `0:${USER}` });
    expect((await create({ slot: 0 })).status).toBe(200);
  });

  it('matches the proof owner case-insensitively', async () => {
    signIn(0, { username: 'Alice@Example.ORG' });
    setPairReauthInStore(cookieStore as never, { grantId: stashGrant(grant(), `0:${USER}`), owner: `0:${USER}` });
    expect((await create({})).status).toBe(200);
  });
});

function grant(): PairingGrant {
  return {
    flow: 'oauth',
    serverUrl: SERVER,
    serverId: null,
    accessToken: 'seeded-access',
    refreshToken: 'seeded-refresh',
    expiresIn: 3600,
    issuedAt: Date.now(),
    tokenEndpoint: `${SERVER}/auth/token`,
    clientId: 'bulwark-webmail',
    confidential: false,
    trusted: true,
  };
}

describe('pair/create password step-up', () => {
  it('mints an OAuth grant for the app client and pairs it', async () => {
    const res = await create({ password: PASSWORD, totp: ' 123456 ' });
    expect(res.status).toBe(200);
    expect(res.cacheControl).toBe('no-store');
    expect(res.body.pairing_code).toMatch(/^[0-9a-f]{64}$/);
    expect(res.body.status_id).toMatch(/^[0-9a-f]{32}$/);
    expect(res.body.expires_in).toBe(120);

    // Structured login for the app's own client and redirect, with the TOTP
    // as a separate field.
    expect(apiAuthCalls()).toEqual([expect.objectContaining({
      type: 'authCode',
      accountName: USER,
      accountSecret: PASSWORD,
      mfaToken: '123456',
      clientId: 'bulwark-webmail',
      redirectUri: 'bulwarkmobile://auth/callback',
      codeChallengeMethod: 'S256',
    })]);
    const [exchange] = tokenCalls();
    expect(exchange).toMatchObject({
      grant_type: 'authorization_code',
      code: 'client-code-1',
      client_id: 'bulwark-webmail',
      redirect_uri: 'bulwarkmobile://auth/callback',
    });
    expect(exchange).not.toHaveProperty('client_secret');

    // The proof remembers the grant for this account.
    expect(proofCookie()).toMatchObject({ purpose: 'pair', owner: `0:${USER}`, grant_id: expect.any(String) });
    expect(cookieWrites.find((w) => w.name === 'pair_reauth')?.options).toMatchObject({ httpOnly: true, maxAge: 300 });

    expect(await status(res.body.status_id)).toBe('pending');
    const redeemed = await redeem(res.body.pairing_code);
    expect(redeemed.status).toBe(200);
    expect(redeemed.body).toEqual({
      flow: 'oauth',
      server_url: SERVER,
      access_token: 'access-1',
      refresh_token: 'refresh-1',
      expires_in: 3600,
      token_endpoint: `${SERVER}/auth/token`,
      client_id: 'bulwark-webmail',
    });
    expect(await status(res.body.status_id)).toBe('redeemed');
  });

  it('sends no mfaToken without a TOTP code', async () => {
    await create({ password: PASSWORD, totp: '   ' });
    expect(apiAuthCalls()[0]).not.toHaveProperty('mfaToken');
  });

  it('answers a wrong password with 401 invalid_credentials and locks after five', async () => {
    for (let i = 0; i < 5; i++) {
      const res = await create({ password: WRONG_PASSWORD });
      expect(res.status).toBe(401);
      expect(res.body).toEqual({ error: 'invalid_credentials' });
    }
    expect(apiAuthCalls()).toHaveLength(5);
    expect(jar.has('pair_reauth')).toBe(false);

    const locked = await create({ password: WRONG_PASSWORD });
    expect(locked.status).toBe(429);
    expect(locked.body).toEqual({ error: 'too_many_attempts' });
    // Not even the right password gets through while locked, and the mail
    // server is not asked again.
    expect((await create({ password: PASSWORD })).status).toBe(429);
    expect(apiAuthCalls()).toHaveLength(5);

    // The lock is per signed-in account.
    signIn(1, { username: 'bob@example.org' });
    expect((await create({ slot: 1, password: WRONG_PASSWORD })).status).toBe(401);
  });

  it('resets the failure count after a successful step-up', async () => {
    for (let i = 0; i < 4; i++) await create({ password: WRONG_PASSWORD });
    expect((await create({ password: PASSWORD })).status).toBe(200);
    for (let i = 0; i < 4; i++) expect((await create({ password: WRONG_PASSWORD })).status).toBe(401);
  });

  it('asks for the TOTP code, and counts a wrong code but not a missing one', async () => {
    handler = mailServer({ apiAuth: () => json({ type: 'mfaRequired' }) });
    for (let i = 0; i < 6; i++) {
      const res = await create({ password: PASSWORD });
      expect(res.status).toBe(401);
      expect(res.body).toEqual({ error: 'totp_required' });
    }
    for (let i = 0; i < 5; i++) expect((await create({ password: PASSWORD, totp: '000000' })).status).toBe(401);
    expect((await create({ password: PASSWORD, totp: '000000' })).status).toBe(429);
  });

  it('reports an unreachable mail server as 502 without counting it', async () => {
    handler = () => { throw new TypeError('fetch failed'); };
    for (let i = 0; i < 6; i++) {
      const res = await create({ password: PASSWORD });
      expect(res.status).toBe(502);
      expect(res.body).toEqual({ error: 'server_unreachable' });
    }
  });

  it('falls back to an app password on a Stalwart without structured login', async () => {
    handler = mailServer({ apiAuth: noStructuredLogin, stalwart: true });
    const res = await create({ password: PASSWORD, redirect_uri: `${WEBMAIL}/auth/callback` });
    expect(res.status).toBe(200);

    // No second structured-login attempt: the endpoint does not exist.
    expect(apiAuthCalls()).toHaveLength(1);
    const setCall = calls.find((c) => c.url === `${SERVER}/jmap/` && c.method === 'POST');
    expect(setCall).toBeDefined();
    expect(setCall!.headers.authorization).toBe(basicFor(PASSWORD));
    const [method, args] = (JSON.parse(setCall!.body) as { methodCalls: [string, Record<string, unknown>][] }).methodCalls[0];
    expect(method).toBe('x:AppPassword/set');
    const created = (args.create as Record<string, Record<string, unknown>>).imp;
    expect(created.description).toMatch(/^Bulwark mobile \(paired \d{4}-\d{2}-\d{2}\)$/);
    expect(created).not.toHaveProperty('expiresAt');

    const redeemed = await redeem(res.body.pairing_code);
    expect(redeemed.body).toEqual({ flow: 'password', server_url: SERVER, username: USER, password: APP_SECRET });
    expect(JSON.stringify(redeemed.body)).not.toContain(PASSWORD);
  });

  it('gives no credential at all when Stalwart refuses the app password', async () => {
    handler = mailServer({
      apiAuth: noStructuredLogin,
      stalwart: true,
      appPassword: () => json({ methodResponses: [['x:AppPassword/set', { notCreated: { imp: { type: 'forbidden' } } }, '0']] }),
    });
    const res = await create({ password: PASSWORD });
    expect(res.status).toBe(502);
    expect(res.body).toEqual({ error: 'pairing_unavailable' });
    expect(jar.has('pair_reauth')).toBe(false);
  });

  it('hands out the verified account password on a server without OAuth or app passwords', async () => {
    handler = mailServer({ apiAuth: noStructuredLogin, stalwart: false });
    const res = await create({ password: PASSWORD });
    expect(res.status).toBe(200);
    expect(calls.some((c) => c.url === `${SERVER}/jmap/` && c.method === 'POST')).toBe(false);
    const redeemed = await redeem(res.body.pairing_code);
    expect(redeemed.body).toEqual({ flow: 'password', server_url: SERVER, username: USER, password: PASSWORD });
  });

  it('checks the password over Basic before falling back, and counts a wrong one', async () => {
    handler = mailServer({ apiAuth: noStructuredLogin, stalwart: false });
    for (let i = 0; i < 5; i++) {
      expect(await create({ password: WRONG_PASSWORD })).toMatchObject({ status: 401, body: { error: 'invalid_credentials' } });
    }
    expect((await create({ password: WRONG_PASSWORD })).status).toBe(429);
  });

  // A TOTP code must not turn a wrong password into an uncounted failure, or
  // the lockout could be sidestepped against a server without structured login.
  it('counts a wrong password toward the lockout even when a TOTP code is sent', async () => {
    handler = mailServer({ apiAuth: noStructuredLogin, stalwart: false });
    for (let i = 0; i < 5; i++) await create({ password: WRONG_PASSWORD, totp: '000000' });
    expect((await create({ password: WRONG_PASSWORD, totp: '000000' })).status).toBe(429);
  });

  // The attempt is counted before the upstream round trip, so parallel
  // requests cannot all pass the check.
  it('does not let parallel step-ups exceed the failure budget', async () => {
    handler = mailServer({
      apiAuth: async () => {
        await new Promise((resolve) => setTimeout(resolve, 20));
        return json({ type: 'failure' });
      },
    });
    await Promise.all(Array.from({ length: 8 }, () => create({ password: WRONG_PASSWORD })));
    expect(apiAuthCalls().length).toBeLessThanOrEqual(5);
  });

  it('retries with the webmail client and redirect when the server refuses the app client', async () => {
    config.oauthClientId = 'webmail-client';
    handler = mailServer({
      apiAuth: (body) => (body.clientId === 'bulwark-webmail'
        ? new Response('client not registered', { status: 401 })
        : body.accountSecret === PASSWORD ? authenticated() : json({ type: 'failure' })),
    });
    const res = await create({ password: PASSWORD, redirect_uri: `${WEBMAIL}/auth/callback` });
    expect(res.status).toBe(200);

    expect(apiAuthCalls()).toEqual([
      expect.objectContaining({ clientId: 'bulwark-webmail', redirectUri: 'bulwarkmobile://auth/callback' }),
      expect.objectContaining({ clientId: 'webmail-client', redirectUri: `${WEBMAIL}/auth/callback` }),
    ]);
    expect(tokenCalls()).toEqual([
      expect.objectContaining({ client_id: 'webmail-client', redirect_uri: `${WEBMAIL}/auth/callback` }),
    ]);

    const redeemed = await redeem(res.body.pairing_code);
    expect(redeemed.body).toMatchObject({
      flow: 'oauth',
      client_id: 'webmail-client',
      token_endpoint: `${SERVER}/auth/token`,
      refresh_token: 'refresh-1',
    });
  });

  it('retries with the desktop redirect even when the client id is the same', async () => {
    handler = mailServer({
      apiAuth: (body) => (body.redirectUri === 'bulwarkmobile://auth/callback'
        ? new Response('redirect not registered', { status: 400 })
        : authenticated()),
    });
    const res = await create({ password: PASSWORD, redirect_uri: `${WEBMAIL}/auth/callback` });
    expect(res.status).toBe(200);
    expect(apiAuthCalls().map((b) => [b.clientId, b.redirectUri])).toEqual([
      ['bulwark-webmail', 'bulwarkmobile://auth/callback'],
      ['bulwark-webmail', `${WEBMAIL}/auth/callback`],
    ]);
  });

  it('does not retry after a credential verdict', async () => {
    config.oauthClientId = 'webmail-client';
    const res = await create({ password: WRONG_PASSWORD, redirect_uri: `${WEBMAIL}/auth/callback` });
    expect(res.body).toEqual({ error: 'invalid_credentials' });
    expect(apiAuthCalls()).toHaveLength(1);
  });

  it('ignores a desktop redirect on another origin', async () => {
    config.oauthClientId = 'webmail-client';
    handler = mailServer({ apiAuth: () => new Response('nope', { status: 401 }), stalwart: true });
    const res = await create({ password: PASSWORD, redirect_uri: 'https://evil.example/auth/callback' });
    // No second structured login; straight to the Basic fallbacks.
    expect(apiAuthCalls()).toHaveLength(1);
    expect(res.status).toBe(200);
    expect((await redeem(res.body.pairing_code)).body).toMatchObject({ flow: 'password', password: APP_SECRET });
  });

  it('uses the account the credential belongs to, not the claimed login', async () => {
    signIn(0, { username: 'alice', accountName: USER });
    const res = await create({ password: PASSWORD });
    expect(res.status).toBe(200);
    expect(apiAuthCalls()[0].accountName).toBe(USER);
    // The proof is still keyed on the slot's login.
    expect(proofCookie()?.owner).toBe('0:alice');
  });

  it('only ever talks to the session context server, whatever the body says', async () => {
    const hostile = { password: PASSWORD, serverUrl: HOSTILE, server_url: HOSTILE, server: HOSTILE, jmapServerUrl: HOSTILE };
    expect((await create(hostile)).status).toBe(200);

    handler = mailServer({ apiAuth: noStructuredLogin, stalwart: true });
    expect((await create(hostile)).status).toBe(200);

    expect(calls.length).toBeGreaterThan(3);
    for (const call of calls) expect(call.url.startsWith(`${SERVER}/`)).toBe(true);
    expect(JSON.stringify(calls)).not.toContain('169.254');
  });

  it('reaches a user-chosen server only through the rebinding-safe fetch', async () => {
    signIn(0, { serverUrl: CUSTOM_SERVER });
    handler = mailServer({ base: CUSTOM_SERVER });
    const res = await create({ password: PASSWORD });
    expect(res.status).toBe(200);
    expect(calls.length).toBeGreaterThan(0);
    expect(calls.every((c) => c.via === 'public')).toBe(true);
    expect(calls.every((c) => c.url.startsWith(`${CUSTOM_SERVER}/`))).toBe(true);
    expect((await redeem(res.body.pairing_code)).body).toMatchObject({
      server_url: CUSTOM_SERVER,
      token_endpoint: `${CUSTOM_SERVER}/auth/token`,
    });
  });

  // The webmail's own OAuth client secret is the admin's, for the admin's
  // server: a user-chosen server (custom JMAP endpoints) never receives it.
  it('does not send the webmail client secret to a user-chosen server', async () => {
    config.oauthClientSecret = 'webmail-client-secret';
    signIn(0, { serverUrl: CUSTOM_SERVER });
    handler = mailServer({ base: CUSTOM_SERVER });
    expect((await create({ password: PASSWORD })).status).toBe(200);
    expect(JSON.stringify(calls)).not.toContain('webmail-client-secret');
  });
});

describe('pair/create with a confidential client', () => {
  it('sends the secret for the app client when it is the configured one, and proxies the phone', async () => {
    config.oauthClientSecret = 'webmail-client-secret';
    const res = await create({ password: PASSWORD, webmail_base: `${WEBMAIL}/mail/` });
    expect(res.status).toBe(200);
    expect(tokenCalls()[0]).toMatchObject({ client_id: 'bulwark-webmail', client_secret: 'webmail-client-secret' });

    const redeemed = await redeem(res.body.pairing_code);
    expect(redeemed.body).toMatchObject({
      flow: 'oauth',
      access_token: 'access-1',
      token_endpoint: `${WEBMAIL}/mail/api/auth/pair/token`,
      client_id: 'bulwark-webmail',
    });
    expect(redeemed.body.refresh_token).not.toBe('refresh-1');
    expect(openPhoneRefreshToken(redeemed.body.refresh_token)).toEqual({
      refreshToken: 'refresh-1',
      serverId: null,
      clientId: 'bulwark-webmail',
      tokenEndpoint: `${SERVER}/auth/token`,
      trusted: true,
    });
    expect(JSON.stringify(redeemed.body)).not.toContain('webmail-client-secret');
  });

  it('takes the secret from OAUTH_CLIENT_SECRET too', async () => {
    vi.stubEnv('OAUTH_CLIENT_SECRET', 'env-secret');
    const res = await create({ password: PASSWORD });
    expect(tokenCalls()[0].client_secret).toBe('env-secret');
    expect((await redeem(res.body.pairing_code)).body.token_endpoint).toBe(`${WEBMAIL}/api/auth/pair/token`);
  });

  it('keeps the server entry in the sealed token for per-server secrets', async () => {
    config.jmapServers = [{ id: 'main', label: 'Main', url: SERVER, oauth: { clientSecret: 'per-server-secret' } }];
    const res = await create({ password: PASSWORD });
    expect(tokenCalls()[0].client_secret).toBe('per-server-secret');
    const redeemed = await redeem(res.body.pairing_code);
    expect(openPhoneRefreshToken(redeemed.body.refresh_token)?.serverId).toBe('main');
  });

  it('keeps the app client public when the secret belongs to another configured client', async () => {
    config.oauthClientId = 'webmail-client';
    config.oauthClientSecret = 'webmail-client-secret';
    const res = await create({ password: PASSWORD });
    expect(tokenCalls()[0]).not.toHaveProperty('client_secret');
    expect((await redeem(res.body.pairing_code)).body).toMatchObject({
      token_endpoint: `${SERVER}/auth/token`,
      refresh_token: 'refresh-1',
    });
  });
});

describe('pair/create without a password', () => {
  it('shows a new code for the same grant and supersedes the previous one', async () => {
    const first = await create({ password: PASSWORD });
    const grantId = readPairReauthFromStore(cookieStore as never)?.grantId;
    const upstreamCalls = calls.length;

    const second = await create({});
    expect(second.status).toBe(200);
    expect(second.cacheControl).toBe('no-store');
    expect(second.body.pairing_code).not.toBe(first.body.pairing_code);
    expect(second.body.status_id).not.toBe(first.body.status_id);
    expect(readPairReauthFromStore(cookieStore as never)?.grantId).toBe(grantId);
    // No new step-up, so the mail server is not involved.
    expect(calls.length).toBe(upstreamCalls);

    expect(await status(first.body.status_id)).toBe('expired');
    expect(await status(second.body.status_id)).toBe('pending');
    expect(await redeem(first.body.pairing_code)).toEqual({ status: 410, body: { error: 'expired_code' } });

    expect((await redeem(second.body.pairing_code)).status).toBe(200);
    expect(await redeem(second.body.pairing_code)).toEqual({ status: 410, body: { error: 'used_code' } });
    expect(await redeem(first.body.pairing_code)).toEqual({ status: 410, body: { error: 'used_code' } });

    // The grant was handed out: the next QR needs a new step-up.
    expect(await create({})).toMatchObject({ status: 401, body: { error: 'reauth_required' } });
  });

  it('kills the previous grant when the user steps up again', async () => {
    const first = await create({ password: PASSWORD });
    const second = await create({ password: PASSWORD });
    expect(await redeem(first.body.pairing_code)).toEqual({ status: 410, body: { error: 'expired_code' } });
    expect((await redeem(second.body.pairing_code)).status).toBe(200);
  });
});

describe('pair/create never exposes the typed password', () => {
  it('keeps it out of logs, cookies and responses', async () => {
    await create({ password: PASSWORD, totp: '123456' });
    await create({ password: WRONG_PASSWORD });

    handler = mailServer({ apiAuth: () => json({ type: 'mfaRequired' }) });
    await create({ password: PASSWORD });

    handler = mailServer({ tokens: () => new Response('token endpoint exploded', { status: 500 }) });
    await create({ password: PASSWORD });

    handler = mailServer({ apiAuth: () => new Response('bad client', { status: 403 }) });
    await create({ password: PASSWORD, redirect_uri: `${WEBMAIL}/auth/callback` });

    handler = mailServer({ apiAuth: noStructuredLogin, stalwart: true });
    await create({ password: PASSWORD });
    await create({ password: WRONG_PASSWORD });

    handler = mailServer({
      apiAuth: noStructuredLogin,
      stalwart: true,
      appPassword: () => json({ methodResponses: [['error', { type: 'forbidden', description: 'nope' }, '0']] }),
    });
    await create({ password: PASSWORD });

    handler = mailServer({ apiAuth: noStructuredLogin, stalwart: false });
    await create({ password: PASSWORD });

    handler = () => { throw new TypeError('fetch failed'); };
    await create({ password: PASSWORD });

    // Every flow ran (oauth, verdicts, errors, app password, account password).
    expect(logger.info).toHaveBeenCalled();
    expect(logger.warn).toHaveBeenCalled();

    const logs = allLoggerCalls();
    for (const secret of [PASSWORD, WRONG_PASSWORD]) {
      expect(logs).not.toContain(secret);
      expect(createResponses.join('\n')).not.toContain(secret);
      for (const write of cookieWrites) {
        expect(write.value).not.toContain(secret);
        expect(Buffer.from(write.value, 'base64').toString('latin1')).not.toContain(secret);
      }
    }
    expect(logs).not.toContain(basicFor(PASSWORD).slice(6));

    const proofs = cookieWrites.filter((w) => w.name === 'pair_reauth');
    expect(proofs.length).toBeGreaterThan(0);
    for (const proof of proofs) {
      const opened = decryptPayload(proof.value, 'pair-reauth');
      expect(opened).not.toBeNull();
      expect(Object.keys(opened!).sort()).toEqual(['created_at', 'grant_id', 'owner', 'p', 'purpose']);
      expect(JSON.stringify(opened)).not.toContain(PASSWORD);
    }
  });
});

describe('pair/create after the security review', () => {
  it('deletes an app password whose grant dies unredeemed, with its own credential', async () => {
    const base = mailServer({ apiAuth: noStructuredLogin, stalwart: true });
    const destroyed: unknown[] = [];
    handler = async (call) => {
      if (call.headers.authorization === basicFor(APP_SECRET)) {
        if (call.url === `${SERVER}/jmap/` && call.method === 'POST') {
          destroyed.push((JSON.parse(call.body) as { methodCalls: [string, { destroy?: unknown }, string][] }).methodCalls[0][1].destroy);
          return json({ methodResponses: [['x:AppPassword/set', { destroyed: ['ap-1'] }, '0']] });
        }
        return base({ ...call, headers: { ...call.headers, authorization: basicFor(PASSWORD) } });
      }
      return base(call);
    };
    signIn(0);
    expect((await create({ password: PASSWORD })).status).toBe(200);
    // A new step-up replaces the grant the phone never picked up.
    expect((await create({ password: PASSWORD })).status).toBe(200);
    await vi.waitFor(() => expect(destroyed).toEqual([['ap-1']]));
  });

  it('does not delete the app password a phone redeemed', async () => {
    handler = mailServer({ apiAuth: noStructuredLogin, stalwart: true });
    signIn(0);
    const res = await create({ password: PASSWORD });
    expect((await redeem(res.body.pairing_code)).status).toBe(200);
    resetPairingStoreForTests();
    await new Promise((r) => setTimeout(r, 10));
    expect(calls.filter((c) => c.headers.authorization === basicFor(APP_SECRET))).toEqual([]);
  });

  it('fails closed when the session cannot be read after the credential check', async () => {
    const base = mailServer({ apiAuth: noStructuredLogin, stalwart: false });
    handler = async (call) => (call.url === `${SERVER}/jmap/session` || (call.url === `${SERVER}/.well-known/jmap` && calls.filter((c) => c.url.endsWith('/.well-known/jmap')).length > 1)
      ? new Response('boom', { status: 500 })
      : base(call));
    signIn(0);
    const res = await create({ password: PASSWORD });
    expect(res).toMatchObject({ status: 502, body: { error: 'pairing_unavailable' } });
  });

  it('counts failures per mail account, whichever cookie slot sends them', async () => {
    handler = mailServer();
    for (let slot = 0; slot < 6; slot++) signIn(slot);
    for (let slot = 0; slot < 5; slot++) {
      expect((await create({ slot, password: WRONG_PASSWORD })).status).toBe(401);
    }
    expect((await create({ slot: 5, password: WRONG_PASSWORD })).status).toBe(429);
  });
});

describe('pair/create for a server the app refuses', () => {
  it('refuses a plain-http mail server before any step-up', async () => {
    handler = mailServer({ base: 'http://mail.lan' });
    signIn(0, { serverUrl: 'http://mail.lan' });
    expect(await create({ password: PASSWORD })).toMatchObject({ status: 400, body: { error: 'insecure_server' } });
    expect(calls).toEqual([]);
  });

  it('allows loopback http, as the app does for development', async () => {
    handler = mailServer({ base: 'http://localhost:8080' });
    signIn(0, { serverUrl: 'http://localhost:8080' });
    config.jmapServerUrl = 'http://localhost:8080';
    expect((await create({ password: PASSWORD })).status).toBe(200);
  });
});
