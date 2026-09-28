// @vitest-environment node
import { createHmac, randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

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
    expect(body).toEqual({ serverUrl: 'https://mail.example.org', username: 'alice@example.org', password: APP_SECRET });
    expect(JSON.stringify(body)).not.toContain(MASTER_PASSWORD);
    expect([...jar.values()].join()).not.toContain(MASTER_PASSWORD);
  });

  it('uses the master credential only towards Stalwart, to create an expiring app password', async () => {
    const before = Date.now();
    await impersonate();

    const masterAuth = `Basic ${Buffer.from(`alice@example.org%master@example.org:${MASTER_PASSWORD}`).toString('base64')}`;
    expect(calls.every((c) => c.auth === masterAuth)).toBe(true);
    const create = calls.find((c) => c.url.endsWith('/jmap/'))!.body as {
      methodCalls: [string, { accountId: string; create: { imp: { expiresAt: string } } }, string][];
    };
    const [method, args] = create.methodCalls[0];
    expect(method).toBe('x:AppPassword/set');
    expect(args.accountId).toBe('acc-alice');
    expect(args.create.imp.expiresAt).toMatch(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$/);
    const ttl = Date.parse(args.create.imp.expiresAt) - before;
    expect(ttl).toBeGreaterThan(7 * 3600_000);
    expect(ttl).toBeLessThanOrEqual(8 * 3600_000);
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
    expect(jar.size).toBe(0);
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
