// @vitest-environment node
import { createHash, createHmac, randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { resetLocalStoreForTests } from '@/lib/shared-store/local';

// "Return to my account" puts the session from before an impersonation
// hand-off back. A sign-in made with "Remember me" unticked had a cookie that
// ends with the browser; it comes back as one, not as a 30-day cookie. The
// sign-in's own time comes back with it, so the maximum session length still
// counts from the sign-in.

vi.mock('@/lib/auth/session-secret', () => ({
  getSessionSecret: () => 's'.repeat(64),
  hasSessionSecret: () => true,
}));
vi.mock('@/lib/logger', () => ({
  logger: { warn: () => {}, error: () => {}, info: () => {}, debug: () => {} },
}));
vi.mock('@/lib/telemetry/login-tracker', () => ({ recordLogin: () => {} }));

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

const SERVER = 'https://mail.example.org';
const policy = { maxHours: 0 };
vi.mock('@/lib/admin/config-manager', () => ({
  configManager: {
    ensureLoaded: async () => {},
    get: (key: string, fallback: unknown) => (key === 'jmapServerUrl' ? SERVER : fallback),
    getPolicy: () => ({ organisation: { session: { maxHours: policy.maxHours } } }),
  },
}));

const SECRET = 'j'.repeat(40);
const SAME_ORIGIN = { 'sec-fetch-site': 'same-origin', 'sec-fetch-mode': 'cors', 'sec-fetch-dest': 'empty' };
const THIRTY_DAYS = 30 * 24 * 60 * 60;

function mintJwt(mailbox: string) {
  const now = Math.floor(Date.now() / 1000);
  const b64url = (s: string) => Buffer.from(s).toString('base64url');
  const h = b64url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const p = b64url(JSON.stringify({ iss: 'platform-api/webmail', iat: now, exp: now + 60, jti: randomUUID(), mailbox }));
  return `${h}.${p}.${createHmac('sha256', SECRET).update(`${h}.${p}`).digest('base64url')}`;
}

function stalwart(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const url = String(input);
  if (url.endsWith('/.well-known/jmap') || url.endsWith('/jmap/session')) {
    return Promise.resolve(Response.json({
      apiUrl: `${SERVER}/jmap/`,
      username: 'admin@example.org',
      accounts: { acc: { name: 'admin@example.org' } },
      primaryAccounts: { 'urn:ietf:params:jmap:mail': 'acc' },
    }));
  }
  const [name, args] = JSON.parse(String(init?.body)).methodCalls[0] as [string, Record<string, unknown>];
  if (name === 'x:AppPassword/get') return Promise.resolve(Response.json({ methodResponses: [[name, { list: [] }, '0']] }));
  if (args.create) return Promise.resolve(Response.json({ methodResponses: [[name, { created: { imp: { id: 'cred-1', secret: 'app-secret-1' } } }, '0']] }));
  return Promise.resolve(Response.json({ methodResponses: [[name, { destroyed: args.destroy }, '0']] }));
}

async function signIn(remember: boolean) {
  const { POST } = await import('@/app/api/auth/session/route');
  const res = await POST(new NextRequest('https://webmail.example/api/auth/session', {
    method: 'POST',
    headers: { ...SAME_ORIGIN, 'content-type': 'application/json' },
    body: JSON.stringify({ serverUrl: SERVER, username: 'admin@example.org', password: 'admins-own-password', slot: 0, remember }),
  }));
  expect(res.status).toBe(200);
}

async function impersonate() {
  const { GET } = await import('@/app/api/auth/impersonate/route');
  const handoff = await GET(new NextRequest(`https://webmail.example/api/auth/impersonate?token=${mintJwt('alice@example.org')}`));
  expect(handoff.status).toBe(303);
}

async function returnToOwnAccount() {
  const { POST } = await import('@/app/api/auth/impersonate/return/route');
  const back = await POST(new NextRequest('https://webmail.example/api/auth/impersonate/return', { method: 'POST', headers: SAME_ORIGIN }));
  expect(back.status).toBe(200);
}

describe('the session that comes back after an impersonation', () => {
  const stateDir = mkdtempSync(path.join(tmpdir(), 'bw-imp-lifetime-'));
  afterAll(() => rmSync(stateDir, { recursive: true, force: true }));
  beforeAll(() => {
    process.env.ADMIN_STATE_DIR = stateDir;
    process.env.BULWARK_JWT_AUTH_SECRET = SECRET;
    process.env.BULWARK_STALWART_MASTER_USER = 'master@example.org';
    process.env.BULWARK_STALWART_MASTER_PASSWORD = 'made-up-master-password';
  });
  beforeEach(() => {
    jar = new Map();
    options.clear();
    policy.maxHours = 0;
    resetLocalStoreForTests();
    vi.stubGlobal('fetch', vi.fn(stalwart));
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it('stays a 30-day cookie when it was one (control)', async () => {
    await signIn(true);
    expect(options.get('jmap_session')?.maxAge).toBe(THIRTY_DAYS);
    await impersonate();
    await returnToOwnAccount();
    expect(options.get('jmap_session')?.maxAge).toBe(THIRTY_DAYS);
  });

  it('stays a browser-session cookie when the sign-in was not remembered', async () => {
    await signIn(false);
    const own = jar.get('jmap_session');
    expect(options.get('jmap_session')?.maxAge).toBeUndefined();

    await impersonate();
    await returnToOwnAccount();

    expect(jar.get('jmap_session')).toBe(own);
    expect(options.get('jmap_session')?.maxAge).toBeUndefined();
  });

  it('comes back as a browser-session cookie when it was parked before the lifetime was kept', async () => {
    await signIn(true);
    await impersonate();
    // Take the parked record's lifetime away, as in a record written before it was kept.
    const { getStore } = await import('@/lib/shared-store');
    const { decryptPayload, encryptPayload } = await import('@/lib/auth/crypto');
    const key = `imp-restore:${createHash('sha256').update(jar.get('jmap_impersonation_restore')!).digest('hex')}`;
    const sealed = await getStore().kv.get(key);
    const record = decryptPayload(sealed!, 'impersonation-restore')!.r as Record<string, unknown>;
    expect(record.remembered).toBe(true);
    delete record.remembered;
    await getStore().kv.set(key, encryptPayload({ r: record }, 'impersonation-restore'), { ttlMs: 60_000 });

    await returnToOwnAccount();
    expect(options.get('jmap_session')?.maxAge).toBeUndefined();
  });

  it('still ends at the maximum session length counted from the sign-in', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    policy.maxHours = 8;
    await signIn(false);
    vi.setSystemTime(Date.now() + 2 * 3600_000);
    await impersonate();
    await returnToOwnAccount();

    const { PUT } = await import('@/app/api/auth/session/route');
    const restore = () => PUT(new NextRequest('https://webmail.example/api/auth/session', { method: 'PUT', headers: SAME_ORIGIN }));
    expect((await restore()).status).toBe(200);
    vi.setSystemTime(Date.now() + 7 * 3600_000);
    const late = await restore();
    expect(late.status).toBe(401);
    expect((await late.json()).error).toBe('session_expired');
  });
});
