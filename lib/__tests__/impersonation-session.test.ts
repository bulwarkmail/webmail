// @vitest-environment node
import { createHmac, randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { setStoreForTests } from '@/lib/shared-store';
import { resetLocalStoreForTests } from '@/lib/shared-store/local';
import { switchableSharedStore } from './helpers/shared-store-down';

vi.mock('@/lib/auth/session-secret', () => ({
  getSessionSecret: () => 's'.repeat(64),
  hasSessionSecret: () => true,
}));
vi.mock('@/lib/logger', () => ({
  logger: { warn: () => {}, error: () => {}, info: () => {}, debug: () => {} },
}));
vi.mock('@/lib/telemetry/login-tracker', () => ({ recordLogin: () => {} }));

const jar = new Map<string, string>();
vi.mock('next/headers', () => ({
  cookies: async () => ({
    get: (name: string) => (jar.has(name) ? { name, value: jar.get(name)! } : undefined),
    set: (name: string, value: string) => { jar.set(name, value); },
    delete: (name: string) => { jar.delete(name); },
    getAll: () => [...jar].map(([name, value]) => ({ name, value })),
  }),
}));

vi.mock('@/lib/admin/config-manager', () => ({
  configManager: {
    ensureLoaded: async () => {},
    get: (key: string, fallback: unknown) =>
      key === 'jmapServerUrl' ? 'https://mail.example.org' : fallback,
  },
}));

const SECRET = 'j'.repeat(40);
const MASTER_PASSWORD = 'M4ster-P4ss-for-every-mailbox';
const APP_SECRET = 'app-password-secret-for-alice';

function mintJwt(mailbox: string) {
  const now = Math.floor(Date.now() / 1000);
  const b64url = (s: string) => Buffer.from(s).toString('base64url');
  const h = b64url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const p = b64url(JSON.stringify({ iss: 'platform-api/webmail', iat: now, exp: now + 60, jti: randomUUID(), mailbox }));
  const sig = createHmac('sha256', SECRET).update(`${h}.${p}`).digest('base64url');
  return `${h}.${p}.${sig}`;
}

const SAME_ORIGIN = { 'sec-fetch-site': 'same-origin', 'sec-fetch-mode': 'cors', 'sec-fetch-dest': 'empty' };

type Call = { url: string; auth: string | null; body: unknown };
let calls: Call[];
let createResult: Record<string, unknown>;
// The mailbox's app passwords, as x:AppPassword/get lists them; null makes the
// listing fail.
let existing: { id: string; description: string; expiresAt?: string }[] | null;

function stalwartFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const url = String(input);
  const headers = new Headers(init?.headers);
  const body = typeof init?.body === 'string' ? JSON.parse(init.body) : undefined;
  calls.push({ url, auth: headers.get('authorization'), body });
  if (url.endsWith('/jmap/session')) {
    return Promise.resolve(Response.json({
      apiUrl: 'https://mail.example.org/jmap/',
      primaryAccounts: { 'urn:ietf:params:jmap:mail': 'acc-alice' },
    }));
  }
  const method = (body as { methodCalls: [string, Record<string, unknown>, string][] }).methodCalls[0];
  if (method[0] === 'x:AppPassword/get') {
    return Promise.resolve(Response.json({
      methodResponses: [existing ? ['x:AppPassword/get', { list: existing }, '0'] : ['error', { type: 'serverFail' }, '0']],
    }));
  }
  if (method[1].create) {
    return Promise.resolve(Response.json({ methodResponses: [['x:AppPassword/set', createResult, '0']] }));
  }
  return Promise.resolve(Response.json({ methodResponses: [['x:AppPassword/set', { destroyed: method[1].destroy }, '0']] }));
}

async function impersonate(mailbox = 'alice@example.org') {
  const { GET } = await import('@/app/api/auth/impersonate/route');
  return GET(new NextRequest(`https://webmail.example/api/auth/impersonate?token=${mintJwt(mailbox)}`));
}

async function readSession() {
  const { PUT } = await import('@/app/api/auth/session/route');
  return PUT(new NextRequest('https://webmail.example/api/auth/session', { method: 'PUT', headers: SAME_ORIGIN }));
}

describe('impersonation handoff', () => {
  // Used jtis are recorded in the state directory.
  const stateDir = mkdtempSync(path.join(tmpdir(), 'bw-imp-'));
  afterAll(() => rmSync(stateDir, { recursive: true, force: true }));

  beforeAll(() => {
    process.env.ADMIN_STATE_DIR = stateDir;
    process.env.BULWARK_JWT_AUTH_SECRET = SECRET;
    process.env.BULWARK_STALWART_MASTER_USER = 'master@example.org';
    process.env.BULWARK_STALWART_MASTER_PASSWORD = MASTER_PASSWORD;
  });

  beforeEach(() => {
    jar.clear();
    calls = [];
    createResult = { created: { imp: { id: 'cred-1', secret: APP_SECRET } } };
    existing = [];
    vi.stubGlobal('fetch', vi.fn(stalwartFetch));
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('hands the browser an app password for the target mailbox, never the master password', async () => {
    const res = await impersonate();
    expect(res.status).toBe(303);

    const put = await readSession();
    expect(put.status).toBe(200);
    const body = await put.json();
    expect(body).toEqual({ serverUrl: 'https://mail.example.org', username: 'alice@example.org', password: APP_SECRET, signedInAt: expect.any(Number), impersonated: true });
    expect(JSON.stringify(body)).not.toContain(MASTER_PASSWORD);
    expect([...jar.values()].join()).not.toContain(MASTER_PASSWORD);
  });

  it('uses the master credential only towards Stalwart, to create an expiring app password', async () => {
    const before = Date.now();
    await impersonate();

    const masterAuth = `Basic ${Buffer.from(`alice@example.org%master@example.org:${MASTER_PASSWORD}`).toString('base64')}`;
    expect(calls.every((c) => c.auth === masterAuth)).toBe(true);
    const create = calls.find((c) => c.url.endsWith('/jmap/') && JSON.stringify(c.body).includes('"create"'))!.body as {
      methodCalls: [string, { accountId: string; create: { imp: { expiresAt: string } } }, string][];
    };
    const [method, args] = create.methodCalls[0];
    expect(method).toBe('x:AppPassword/set');
    expect(args.accountId).toBe('acc-alice');
    expect(args.create.imp.expiresAt).toMatch(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$/);
    // The handoff reads the clock after `before` was taken, so bound the
    // expiry by both ends instead of measuring from `before` alone.
    const after = Date.now();
    const expires = Date.parse(args.create.imp.expiresAt);
    expect(expires - before).toBeGreaterThan(7 * 3600_000);
    expect(expires).toBeLessThanOrEqual(after + 8 * 3600_000);
  });

  it("deletes the mailbox's expired handoff app passwords before making a new one", async () => {
    const past = '2026-01-01T00:00:00Z';
    const future = new Date(Date.now() + 3600_000).toISOString().replace(/\.\d{3}Z$/, 'Z');
    existing = [
      { id: 'old-1', description: 'Support session aaa', expiresAt: past },
      { id: 'old-2', description: 'Support session bbb', expiresAt: past },
      { id: 'live', description: 'Support session ccc', expiresAt: future },
      { id: 'theirs', description: 'Thunderbird on the laptop', expiresAt: past },
      { id: 'forever', description: 'Support session ddd' },
    ];
    const res = await impersonate();
    expect(res.status).toBe(303);

    const jmap = calls.filter((c) => c.url.endsWith('/jmap/')).map((c) =>
      (c.body as { methodCalls: [string, Record<string, unknown>, string][] }).methodCalls[0]);
    expect(jmap.map(([name]) => name)).toEqual(['x:AppPassword/get', 'x:AppPassword/set', 'x:AppPassword/set']);
    expect(jmap[1][1].destroy).toEqual(['old-1', 'old-2']);
    expect(jmap[2][1].create).toBeDefined();
  });

  it('still hands over a session when the expired ones cannot be listed', async () => {
    existing = null;
    const res = await impersonate();
    expect(res.status).toBe(303);
    expect(calls.some((c) => JSON.stringify(c.body ?? null).includes('"destroy"'))).toBe(false);
  });

  it('refuses the handoff when Stalwart does not create the app password', async () => {
    createResult = { notCreated: { imp: { type: 'forbidden', description: 'not allowed' } } };
    const res = await impersonate();
    expect(res.status).toBe(502);
    expect(jar.size).toBe(0);
  });

  it('revokes the app password on sign-out', async () => {
    await impersonate();
    calls = [];
    const { DELETE } = await import('@/app/api/auth/session/route');
    const res = await DELETE(new NextRequest('https://webmail.example/api/auth/session?all=true', {
      method: 'DELETE',
      headers: { 'sec-fetch-site': 'same-origin', origin: 'https://webmail.example' },
    }));
    expect(res.status).toBe(200);
    const destroy = calls.find((c) => c.url.endsWith('/jmap/'))!.body as {
      methodCalls: [string, { destroy: string[] }, string][];
    };
    expect(destroy.methodCalls[0][1].destroy).toEqual(['cred-1']);
    // The reconcile marker is no credential and expires within a minute.
    expect([...jar.keys()].filter((name) => name !== 'jmap_impersonated')).toEqual([]);
  });

  it('sets the marker cookie that lets the client reconcile its account list', async () => {
    const res = await impersonate();
    expect(res.headers.get('location')).toBe('/?impersonated=1');
    expect(jar.get('jmap_impersonated')).toBe('1');
  });

  it('tells the browser the handoff session is an impersonation, which the username no longer shows', async () => {
    await impersonate();
    const { GET } = await import('@/app/api/auth/session/route');
    const get = await GET(new NextRequest('https://webmail.example/api/auth/session'));
    expect(await get.json()).toMatchObject({ username: 'alice@example.org', impersonated: true });
  });

  it('does not mark a session the user signed in to themselves', async () => {
    const { encryptSession } = await import('@/lib/auth/crypto');
    jar.set('jmap_session', encryptSession('https://mail.example.org', 'alice@example.org', 'her-own-password'));
    const put = await readSession();
    expect((await put.json()).impersonated).toBeUndefined();
  });

  it('does not mark another mailbox signed in to after the handoff', async () => {
    await impersonate();
    const { encryptSession } = await import('@/lib/auth/crypto');
    jar.set('jmap_session', encryptSession('https://mail.example.org', 'bob@example.org', 'bobs-password'));
    const put = await readSession();
    expect((await put.json()).impersonated).toBeUndefined();
  });

  it('will not return a session that still holds the master password', async () => {
    const { encryptSession } = await import('@/lib/auth/crypto');
    jar.set('jmap_session', encryptSession('https://mail.example.org', 'alice@example.org%master@example.org', MASTER_PASSWORD));

    const put = await readSession();
    expect(put.status).toBe(401);
    expect(JSON.stringify(await put.json())).not.toContain(MASTER_PASSWORD);
    expect(jar.has('jmap_session')).toBe(false);
  });
});

describe('impersonation handoff while the shared store is down (#1066)', () => {
  beforeAll(() => {
    process.env.BULWARK_JWT_AUTH_SECRET = SECRET;
    process.env.BULWARK_STALWART_MASTER_USER = 'master@example.org';
    process.env.BULWARK_STALWART_MASTER_PASSWORD = MASTER_PASSWORD;
  });
  afterEach(() => {
    setStoreForTests(null);
    resetLocalStoreForTests();
    vi.unstubAllGlobals();
  });

  it('answers 503, not "already used", and opens no session', async () => {
    const store = switchableSharedStore();
    store.down = true;
    setStoreForTests(store);
    jar.clear();
    calls = [];
    vi.stubGlobal('fetch', vi.fn(stalwartFetch));
    const res = await impersonate();
    expect(res.status).toBe(503);
    expect(calls).toHaveLength(0);
  });
});
