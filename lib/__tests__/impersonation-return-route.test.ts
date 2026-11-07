// @vitest-environment node
import { createHmac, randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { setStoreForTests } from '@/lib/shared-store';
import { resetLocalStoreForTests } from '@/lib/shared-store/local';
import { fakeSharedStore } from '@/lib/shared-store/__tests__/fake-shared';

// "Return to my account" after an impersonation handoff (#1538): the handoff
// parks the browser's own session on the server, and one return, from the
// same browser and while that impersonation is still open, brings it back.

vi.mock('@/lib/auth/session-secret', () => ({
  getSessionSecret: () => 's'.repeat(64),
  hasSessionSecret: () => true,
}));
vi.mock('@/lib/logger', () => ({
  logger: { warn: () => {}, error: () => {}, info: () => {}, debug: () => {} },
}));
vi.mock('@/lib/telemetry/login-tracker', () => ({ recordLogin: () => {} }));

/** The browser's cookie jar; tests swap it to act as another browser. */
let jar = new Map<string, string>();
const options = new Map<string, { maxAge?: number }>();
vi.mock('next/headers', () => ({
  cookies: async () => ({
    get: (name: string) => (jar.has(name) ? { name, value: jar.get(name)! } : undefined),
    set: (name: string, value: string, opts?: { maxAge?: number }) => { jar.set(name, value); options.set(name, opts ?? {}); },
    delete: (name: string | { name: string }) => { jar.delete(typeof name === 'string' ? name : name.name); },
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
const SERVER = 'https://mail.example.org';

function mintJwt(mailbox: string) {
  const now = Math.floor(Date.now() / 1000);
  const b64url = (s: string) => Buffer.from(s).toString('base64url');
  const h = b64url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const p = b64url(JSON.stringify({ iss: 'platform-api/webmail', iat: now, exp: now + 60, jti: randomUUID(), mailbox }));
  const sig = createHmac('sha256', SECRET).update(`${h}.${p}`).digest('base64url');
  return `${h}.${p}.${sig}`;
}

const SAME_ORIGIN = { 'sec-fetch-site': 'same-origin', 'sec-fetch-mode': 'cors', 'sec-fetch-dest': 'empty' };

let destroyed: string[];
let nextCredential: number;

function stalwartFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const url = String(input);
  if (url.endsWith('/jmap/session')) {
    return Promise.resolve(Response.json({
      apiUrl: `${SERVER}/jmap/`,
      primaryAccounts: { 'urn:ietf:params:jmap:mail': 'acc' },
    }));
  }
  const body = JSON.parse(String(init?.body));
  const [name, args] = body.methodCalls[0] as [string, Record<string, unknown>];
  if (name === 'x:AppPassword/get') {
    return Promise.resolve(Response.json({ methodResponses: [[name, { list: [] }, '0']] }));
  }
  if (args.create) {
    nextCredential += 1;
    return Promise.resolve(Response.json({
      methodResponses: [[name, { created: { imp: { id: `cred-${nextCredential}`, secret: `app-secret-${nextCredential}` } } }, '0']],
    }));
  }
  destroyed.push(...(args.destroy as string[]));
  return Promise.resolve(Response.json({ methodResponses: [[name, { destroyed: args.destroy }, '0']] }));
}

async function impersonate(mailbox = 'alice@example.org') {
  const { GET } = await import('@/app/api/auth/impersonate/route');
  return GET(new NextRequest(`https://webmail.example/api/auth/impersonate?token=${mintJwt(mailbox)}`));
}

async function available(): Promise<boolean> {
  const { GET } = await import('@/app/api/auth/impersonate/return/route');
  const res = await GET();
  return (await res.json()).available;
}

async function attach(registry: unknown, headers: Record<string, string> = SAME_ORIGIN) {
  const { PUT } = await import('@/app/api/auth/impersonate/return/route');
  return PUT(new NextRequest('https://webmail.example/api/auth/impersonate/return', {
    method: 'PUT',
    headers: { ...headers, 'content-type': 'application/json' },
    body: JSON.stringify(registry),
  }));
}

async function returnToOwnAccount(headers: Record<string, string> = SAME_ORIGIN) {
  const { POST } = await import('@/app/api/auth/impersonate/return/route');
  return POST(new NextRequest('https://webmail.example/api/auth/impersonate/return', { method: 'POST', headers }));
}

async function sessionUsername(): Promise<string | null> {
  const { PUT } = await import('@/app/api/auth/session/route');
  const res = await PUT(new NextRequest('https://webmail.example/api/auth/session', { method: 'PUT', headers: SAME_ORIGIN }));
  return res.ok ? (await res.json()).username : null;
}

async function signedInAsAdmin() {
  const { encryptSession } = await import('@/lib/auth/crypto');
  const token = encryptSession(SERVER, 'admin@example.org', 'admins-own-password');
  jar.set('jmap_session', token);
  return token;
}

const REGISTRY = {
  accounts: [{ id: 'admin@example.org@mail.example.org', username: 'admin@example.org', serverUrl: SERVER, cookieSlot: 0, authMode: 'basic' }],
  activeAccountId: 'admin@example.org@mail.example.org',
  defaultAccountId: 'admin@example.org@mail.example.org',
};

describe('returning to the own account after an impersonation handoff', () => {
  const stateDir = mkdtempSync(path.join(tmpdir(), 'bw-imp-return-'));
  afterAll(() => rmSync(stateDir, { recursive: true, force: true }));

  beforeAll(() => {
    process.env.ADMIN_STATE_DIR = stateDir;
    process.env.BULWARK_JWT_AUTH_SECRET = SECRET;
    process.env.BULWARK_STALWART_MASTER_USER = 'master@example.org';
    process.env.BULWARK_STALWART_MASTER_PASSWORD = MASTER_PASSWORD;
  });

  beforeEach(() => {
    jar = new Map();
    options.clear();
    destroyed = [];
    nextCredential = 0;
    resetLocalStoreForTests();
    vi.stubGlobal('fetch', vi.fn(stalwartFetch));
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it('puts the session from before the handoff back and ends the target session', async () => {
    const own = await signedInAsAdmin();
    await impersonate();
    expect(await sessionUsername()).toBe('alice@example.org');
    expect(jar.get('jmap_impersonation_restore')).toMatch(/^[0-9a-f]{64}$/);
    // The handle is all the browser holds: the parked session is not in any cookie.
    expect([...jar.values()].filter((value) => value === own)).toEqual([]);
    expect(await available()).toBe(true);

    const res = await returnToOwnAccount();
    expect(res.status).toBe(200);
    expect(jar.get('jmap_session')).toBe(own);
    expect(options.get('jmap_session')?.maxAge).toBe(30 * 24 * 60 * 60);
    expect(await sessionUsername()).toBe('admin@example.org');
    // The target's app password is revoked, as on sign-out.
    expect(destroyed).toEqual(['cred-1']);
    expect(jar.has('jmap_impersonation')).toBe(false);
    expect(jar.has('jmap_impersonation_restore')).toBe(false);
  });

  it('hands back the account list the page attached, and takes it only once', async () => {
    await signedInAsAdmin();
    await impersonate();

    expect((await attach(REGISTRY)).status).toBe(200);
    expect((await attach({ accounts: [{ id: 'someone-else' }] })).status).toBe(409);

    const res = await returnToOwnAccount();
    expect((await res.json()).registry).toEqual(REGISTRY);
  });

  it('is single-use', async () => {
    await signedInAsAdmin();
    await impersonate();
    const handle = jar.get('jmap_impersonation_restore')!;
    const afterHandoff = new Map(jar);

    expect((await returnToOwnAccount()).status).toBe(200);

    // The same browser state replayed, handle included: nothing opens twice.
    jar = afterHandoff;
    expect(jar.get('jmap_impersonation_restore')).toBe(handle);
    const again = await returnToOwnAccount();
    expect(again.status).toBe(410);
    expect(await sessionUsername()).toBe('alice@example.org');
  });

  it('expires with the impersonation session', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    await signedInAsAdmin();
    await impersonate();
    expect(await available()).toBe(true);

    vi.setSystemTime(Date.now() + 8 * 60 * 60 * 1000 + 1000);
    expect(await available()).toBe(false);
    expect((await returnToOwnAccount()).status).toBe(410);
    expect(destroyed).toEqual([]);
  });

  it('expires by its own clock when the store keeps the record longer', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    // A store whose entries outlive their TTL (a Redis eviction policy, a slow sweep).
    const store = fakeSharedStore();
    const set = store.kv.set.bind(store.kv);
    store.kv.set = (key, value, opts) => set(key, value, { ...opts, ttlMs: undefined });
    setStoreForTests(store);
    try {
      await signedInAsAdmin();
      await impersonate();
      vi.setSystemTime(Date.now() + 8 * 60 * 60 * 1000 + 1000);
      expect(await available()).toBe(false);
      expect((await returnToOwnAccount()).status).toBe(410);
    } finally {
      setStoreForTests(null);
    }
  });

  it('does nothing for another browser holding a copy of the handle', async () => {
    await signedInAsAdmin();
    await impersonate();
    const handle = jar.get('jmap_impersonation_restore')!;

    // Another browser in an impersonation of its own, with the copied handle.
    jar = new Map();
    await impersonate('bob@example.org');
    jar.set('jmap_impersonation_restore', handle);
    expect(await available()).toBe(false);
    const res = await returnToOwnAccount();
    expect(res.status).toBe(410);
    expect(await sessionUsername()).toBe('bob@example.org');
    expect(destroyed).toEqual([]);
  });

  it('offers nothing when the handoff started without a session of its own', async () => {
    await impersonate();
    expect(jar.has('jmap_impersonation_restore')).toBe(false);
    expect(await available()).toBe(false);
    expect((await returnToOwnAccount()).status).toBe(410);
    expect(await sessionUsername()).toBe('alice@example.org');
  });

  it('keeps a refresh token in place and returns to it', async () => {
    jar.set('jmap_rt', 'admins-refresh-token');
    await impersonate();
    expect(await available()).toBe(true);

    expect((await returnToOwnAccount()).status).toBe(200);
    expect(jar.get('jmap_rt')).toBe('admins-refresh-token');
    expect(jar.has('jmap_session')).toBe(false);
    expect(destroyed).toEqual(['cred-1']);
  });

  it('leads back to the first account after a second handoff', async () => {
    const own = await signedInAsAdmin();
    await impersonate('alice@example.org');
    await impersonate('bob@example.org');
    expect(await sessionUsername()).toBe('bob@example.org');
    expect(await available()).toBe(true);

    expect((await returnToOwnAccount()).status).toBe(200);
    expect(jar.get('jmap_session')).toBe(own);
    expect(destroyed).toEqual(['cred-2']);
  });

  it('gives up the way back when the impersonation is signed out of', async () => {
    await signedInAsAdmin();
    await impersonate();
    const handle = jar.get('jmap_impersonation_restore')!;
    const { DELETE } = await import('@/app/api/auth/session/route');
    await DELETE(new NextRequest('https://webmail.example/api/auth/session?slot=0', {
      method: 'DELETE',
      headers: { 'sec-fetch-site': 'same-origin' },
    }));
    expect(jar.has('jmap_impersonation_restore')).toBe(false);

    // Even with the old handle and a new impersonation in the same browser.
    await impersonate();
    jar.set('jmap_impersonation_restore', handle);
    expect(await available()).toBe(false);
  });

  it('refuses a cross-site return and a cross-site account list', async () => {
    await signedInAsAdmin();
    await impersonate();
    const crossSite = { 'sec-fetch-site': 'cross-site' };
    expect((await returnToOwnAccount(crossSite)).status).toBe(403);
    expect((await attach(REGISTRY, crossSite)).status).toBe(403);
    expect(await available()).toBe(true);
    expect(await sessionUsername()).toBe('alice@example.org');
  });

  it('refuses an account list that is not one', async () => {
    await signedInAsAdmin();
    await impersonate();
    expect((await attach([1, 2, 3])).status).toBe(400);
    expect((await attach({ accounts: 'nope' })).status).toBe(400);
    expect((await attach({ accounts: ['x'.repeat(70 * 1024)] })).status).toBe(413);
  });
});

describe('returning when impersonation is not configured', () => {
  beforeAll(() => {
    delete process.env.BULWARK_JWT_AUTH_SECRET;
  });
  afterAll(() => {
    process.env.BULWARK_JWT_AUTH_SECRET = SECRET;
  });

  it('answers 404, like the handoff route', async () => {
    jar = new Map();
    const { GET } = await import('@/app/api/auth/impersonate/return/route');
    expect((await GET()).status).toBe(404);
    expect((await returnToOwnAccount()).status).toBe(404);
  });
});
