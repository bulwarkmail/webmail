// @vitest-environment node
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { SESSION_TOO_OLD } from "@/lib/session-policy/constants";
import { resetLocalStoreForTests } from '@/lib/shared-store/local';
import { loginFingerprint } from '@/lib/pwa-notify/login-fingerprint';

// The organisation's maximum session length (policy.json
// organisation.session.maxHours) covers the context cookie jmap_stalwart_ctx,
// which every cookie-authed route takes the user's credential from, not only
// the routes that restore a remembered sign-in (/api/auth/session) or renew a
// token (/api/auth/token). A context past the maximum is refused and cleared
// before anything is sent to the mail server.

vi.mock('@/lib/auth/session-secret', () => ({
  getSessionSecret: () => 's'.repeat(64),
  hasSessionSecret: () => true,
}));
vi.mock('@/lib/logger', () => ({
  logger: { warn: () => {}, error: () => {}, info: () => {}, debug: () => {} },
}));
vi.mock('@/lib/telemetry/login-tracker', () => ({ recordLogin: () => {} }));

const SERVER = 'https://mail.example.org';
const MAX_HOURS = 8;
/** Everyone's maximum session length; 0 is none. */
let maxHours = MAX_HOURS;

vi.mock('@/lib/admin/config-manager', () => ({
  configManager: {
    ensureLoaded: async () => {},
    get: (key: string, fallback: unknown) => (key === 'jmapServerUrl' ? SERVER : fallback),
    getPolicy: () => ({ organisation: { session: { maxHours } } }),
  },
}));

let jar = new Map<string, string>();
vi.mock('next/headers', () => ({
  cookies: async () => ({
    get: (name: string) => (jar.has(name) ? { name, value: jar.get(name)! } : undefined),
    set: (name: string, value: string) => { jar.set(name, value); },
    delete: (name: string | { name: string }) => { jar.delete(typeof name === 'string' ? name : name.name); },
    getAll: () => [...jar].map(([name, value]) => ({ name, value })),
  }),
}));

const SAME_ORIGIN = { 'sec-fetch-site': 'same-origin', 'sec-fetch-mode': 'cors', 'sec-fetch-dest': 'empty' };
const USER = 'user@example.org';
const PASSWORD = 'correct horse battery staple';
const BASIC = `Basic ${Buffer.from(`${USER}:${PASSWORD}`).toString('base64')}`;
const BEARER = 'Bearer access-token-of-the-user';

/** Requests the mail server got that carried the user's credential. */
let upstream: string[];

function mailServer(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const url = String(input);
  const auth = new Headers(init?.headers).get('authorization');
  if (auth === BASIC || auth === BEARER) upstream.push(`${init?.method ?? 'GET'} ${url}`);
  if (url.endsWith('/.well-known/jmap')) {
    return Promise.resolve(Response.json({
      apiUrl: `${SERVER}/jmap/`,
      username: USER,
      accounts: { acc: { name: USER } },
      primaryAccounts: { 'urn:ietf:params:jmap:mail': 'acc' },
    }));
  }
  // Every method answers with an empty result.
  const calls = typeof init?.body === 'string'
    ? (JSON.parse(init.body) as { methodCalls?: Array<[string, unknown, string]> }).methodCalls ?? []
    : [];
  return Promise.resolve(Response.json({
    methodResponses: calls.map(([name, , id]) => [name, { accountId: 'acc', ids: [], list: [], total: 0 }, id]),
  }));
}

const at = (time: string) => vi.setSystemTime(new Date(`2026-11-11T${time}Z`));

async function signIn(slot = 0) {
  const { POST } = await import('@/app/api/auth/session/route');
  const res = await POST(new NextRequest('https://webmail.example/api/auth/session', {
    method: 'POST',
    headers: { ...SAME_ORIGIN, 'content-type': 'application/json' },
    body: JSON.stringify({ serverUrl: SERVER, username: USER, password: PASSWORD, slot }),
  }));
  expect(res.status).toBe(200);
}

async function restoreSession() {
  const { PUT } = await import('@/app/api/auth/session/route');
  return PUT(new NextRequest('https://webmail.example/api/auth/session', { method: 'PUT', headers: SAME_ORIGIN }));
}

async function readMailThroughTheServer(slot: string | null = '0') {
  const { POST } = await import('@/app/api/account/stalwart/jmap/route');
  return POST(new NextRequest('https://webmail.example/api/account/stalwart/jmap', {
    method: 'POST',
    headers: { ...SAME_ORIGIN, 'content-type': 'application/json', ...(slot === null ? {} : { 'X-JMAP-Cookie-Slot': slot }) },
    body: JSON.stringify({
      using: ['urn:ietf:params:jmap:core', 'urn:ietf:params:jmap:mail'],
      methodCalls: [['Email/query', { accountId: 'acc' }, '0']],
    }),
  }));
}

describe('the maximum session length and the context cookie', () => {
  const stateDir = mkdtempSync(path.join(tmpdir(), 'bw-session-age-'));
  afterAll(() => rmSync(stateDir, { recursive: true, force: true }));
  beforeAll(() => { process.env.ADMIN_STATE_DIR = stateDir; });

  beforeEach(async () => {
    jar = new Map();
    upstream = [];
    maxHours = MAX_HOURS;
    resetLocalStoreForTests();
    vi.useFakeTimers({ toFake: ['Date'] });
    at('08:00:00');
    // The server enforces the limits from 08:00 on.
    rmSync(path.join(stateDir, 'session-limits-since'), { force: true });
    const { limitsEnforcedSince, resetLimitsEnforcedSince } = await import('@/lib/auth/session-age');
    resetLimitsEnforcedSince();
    await limitsEnforcedSince();
    vi.stubGlobal('fetch', vi.fn(mailServer));
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it('works while the session is younger than the maximum (control)', async () => {
    await signIn();
    at('09:00:00');
    upstream = [];
    const res = await readMailThroughTheServer();
    expect(res.status).toBe(200);
    expect(upstream).toHaveLength(1);
  });

  it('refuses the remembered sign-in once it is older than the maximum (control)', async () => {
    await signIn();
    at('17:00:01');
    const res = await restoreSession();
    expect(res.status).toBe(401);
    expect((await res.json()).error).toBe(SESSION_TOO_OLD);
  });

  it('refuses the context cookie once the session is older than the maximum', async () => {
    await signIn();
    // The browser was left as it was: nothing ran the sign-out. Nine hours later a
    // cookie-authed route is called without the app being loaded first.
    at('17:00:01');
    upstream = [];

    const res = await readMailThroughTheServer();

    expect(upstream).toEqual([]);
    expect(res.status).toBe(401);
    expect(jar.has('jmap_stalwart_ctx')).toBe(false);
  });

  it('refuses it for the WebDAV proxy', async () => {
    await signIn();
    at('17:00:01');
    upstream = [];
    const { POST } = await import('@/app/api/webdav/route');
    const res = await POST(new NextRequest('https://webmail.example/api/webdav', {
      method: 'POST',
      headers: { ...SAME_ORIGIN, 'X-JMAP-Cookie-Slot': '0', 'X-WebDAV-Method': 'PROPFIND', 'X-WebDAV-Path': '/' },
    }));
    expect(upstream).toEqual([]);
    expect(res.status).toBe(401);
  });

  it('refuses it for the push preview', async () => {
    await signIn();
    at('17:00:01');
    upstream = [];
    const { GET } = await import('@/app/api/push/preview/route');
    const res = await GET(new NextRequest(`https://webmail.example/api/push/preview?accountId=acc&login=${encodeURIComponent(USER)}`, {
      headers: SAME_ORIGIN,
    }));
    expect(upstream).toEqual([]);
    expect(res.status).toBe(401);
  });

  it("refuses it for a notification's action", async () => {
    await signIn();
    at('17:00:01');
    upstream = [];
    const { POST } = await import('@/app/api/push/action/route');
    const res = await POST(new NextRequest('https://webmail.example/api/push/action', {
      method: 'POST',
      headers: { ...SAME_ORIGIN, 'content-type': 'application/json' },
      body: JSON.stringify({ action: 'mark-read', accountId: 'acc', emailId: 'm1', login: await loginFingerprint(SERVER, USER) }),
    }));
    expect(upstream).toEqual([]);
    expect(res.status).toBe(401);
  });

  it('refuses it in every slot, named or not', async () => {
    await signIn(2);
    at('09:00:00');
    expect((await readMailThroughTheServer('2')).status).toBe(200);
    at('17:00:01');
    upstream = [];
    expect((await readMailThroughTheServer(null)).status).toBe(401);
    expect((await readMailThroughTheServer('2')).status).toBe(401);
    expect(upstream).toEqual([]);
    expect(jar.has('jmap_stalwart_ctx_2')).toBe(false);
  });

  it('keeps the sign-in time when a restore rewrites the context', async () => {
    await signIn();
    at('15:00:00');
    expect((await restoreSession()).status).toBe(200);
    at('16:00:01');
    upstream = [];
    expect((await readMailThroughTheServer()).status).toBe(401);
    expect(upstream).toEqual([]);
  });

  it("applies a token sign-in's own sign-in time, not the time its context was written", async () => {
    // A provider sign-in at 08:00 kept its refresh token and its stamp.
    const { writeSignInStamp } = await import('@/lib/auth/session-age');
    const store = await (await import('next/headers')).cookies();
    jar.set('jmap_rt', 'refresh-token');
    writeSignInStamp(store as never, 0, { signedInAt: Date.now(), refreshToken: 'refresh-token' });
    // Four hours later the page renewed the access token and wrote the context.
    at('12:00:00');
    const { POST } = await import('@/app/api/auth/stalwart-context/route');
    const written = await POST(new NextRequest('https://webmail.example/api/auth/stalwart-context', {
      method: 'POST',
      headers: { ...SAME_ORIGIN, 'content-type': 'application/json' },
      body: JSON.stringify({ serverUrl: SERVER, username: USER, authHeader: BEARER, slot: 0 }),
    }));
    expect(written.status).toBe(200);
    at('15:59:59');
    expect((await readMailThroughTheServer()).status).toBe(200);
    at('16:00:01');
    upstream = [];
    expect((await readMailThroughTheServer()).status).toBe(401);
    expect(upstream).toEqual([]);
  });

  it('applies a maximum the admin lowered after the sign-in', async () => {
    maxHours = 0;
    await signIn();
    at('11:00:00');
    expect((await readMailThroughTheServer()).status).toBe(200);
    maxHours = 2;
    upstream = [];
    expect((await readMailThroughTheServer()).status).toBe(401);
    expect(upstream).toEqual([]);
  });

  it('changes nothing without a maximum', async () => {
    maxHours = 0;
    await signIn();
    vi.setSystemTime(new Date('2026-11-20T08:00:00Z'));
    upstream = [];
    expect((await readMailThroughTheServer()).status).toBe(200);
    expect(upstream).toHaveLength(1);
  });

  it('counts a context written without a sign-in time from when the limits were first enforced', async () => {
    const { encryptPayload } = await import('@/lib/auth/crypto');
    jar.set('jmap_stalwart_ctx', encryptPayload({ serverUrl: SERVER, username: USER, authHeader: BASIC }, 'session-context'));
    at('15:59:59');
    expect((await readMailThroughTheServer()).status).toBe(200);
    at('16:00:01');
    upstream = [];
    expect((await readMailThroughTheServer()).status).toBe(401);
    expect(upstream).toEqual([]);
  });
});
