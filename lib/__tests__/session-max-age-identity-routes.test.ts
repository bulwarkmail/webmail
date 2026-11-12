// @vitest-environment node
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { resetLocalStoreForTests } from '@/lib/shared-store/local';

// The organisation's maximum session length (policy.json
// organisation.session.maxHours) also holds on the routes that take the
// signed-in identity from the cookies without acting on the mail server with
// it: settings sync, the account archive, plugin approval requests and the
// instance details. A context or a remembered session past the maximum
// counts as no sign-in there.

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
    getPolicy: () => ({ organisation: { session: { maxHours } }, features: { accountArchiveEnabled: true } }),
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

function mailServer(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const url = String(input);
  if (url.endsWith('/.well-known/jmap') && new Headers(init?.headers).get('authorization') === BASIC) {
    return Promise.resolve(Response.json({
      apiUrl: `${SERVER}/jmap/`,
      username: USER,
      accounts: { acc: { name: USER } },
      primaryAccounts: { 'urn:ietf:params:jmap:mail': 'acc' },
    }));
  }
  return Promise.resolve(new Response('unauthorized', { status: 401 }));
}

const at = (time: string) => vi.setSystemTime(new Date(`2026-11-11T${time}Z`));

/** A remembered password sign-in at 08:00: context and session cookie. */
async function signIn() {
  const { POST } = await import('@/app/api/auth/session/route');
  const res = await POST(new NextRequest('https://webmail.example/api/auth/session', {
    method: 'POST',
    headers: { ...SAME_ORIGIN, 'content-type': 'application/json' },
    body: JSON.stringify({ serverUrl: SERVER, username: USER, password: PASSWORD, slot: 0 }),
  }));
  expect(res.status).toBe(200);
  expect(jar.has('jmap_stalwart_ctx')).toBe(true);
  expect(jar.has('jmap_session')).toBe(true);
}

async function settingsGet() {
  const { GET } = await import('@/app/api/settings/route');
  return GET(new NextRequest('https://webmail.example/api/settings', {
    headers: { ...SAME_ORIGIN, 'x-settings-username': USER, 'x-settings-server': SERVER },
  }));
}

async function archiveGet() {
  const { GET } = await import('@/app/api/account-archive/route');
  return GET(new NextRequest('https://webmail.example/api/account-archive', {
    headers: { ...SAME_ORIGIN, 'x-archive-username': USER, 'x-archive-server': SERVER },
  }));
}

async function approvalStatus() {
  const { GET } = await import('@/app/api/plugin-approval-status/route');
  return GET(new NextRequest(`https://webmail.example/api/plugin-approval-status?pluginId=some-plugin&bundleHash=${'a'.repeat(64)}`, {
    headers: SAME_ORIGIN,
  }));
}

async function instanceDetails() {
  const { canSeeInstanceDetails, signedInIdentity } = await import('@/lib/auth/instance-details');
  return {
    visible: await canSeeInstanceDetails(new NextRequest('https://webmail.example/api/plugins', { headers: SAME_ORIGIN })),
    identity: await signedInIdentity(),
  };
}

describe('routes that take the signed-in identity from the cookies, and the maximum session length', () => {
  const stateDir = mkdtempSync(path.join(tmpdir(), 'bw-identity-age-'));
  const settingsDir = mkdtempSync(path.join(tmpdir(), 'bw-identity-settings-'));
  afterAll(() => {
    rmSync(stateDir, { recursive: true, force: true });
    rmSync(settingsDir, { recursive: true, force: true });
  });
  // Loaded once up front, so no single test spends its time limit on it.
  beforeAll(async () => {
    process.env.ADMIN_STATE_DIR = stateDir;
    process.env.SETTINGS_DATA_DIR = settingsDir;
    process.env.SETTINGS_SYNC_ENABLED = 'true';
    await Promise.all([
      import('@/app/api/auth/session/route'),
      import('@/app/api/settings/route'),
      import('@/app/api/account-archive/route'),
      import('@/app/api/plugin-approval-status/route'),
      import('@/lib/auth/instance-details'),
    ]);
  }, 60_000);

  beforeEach(async () => {
    jar = new Map();
    maxHours = MAX_HOURS;
    resetLocalStoreForTests();
    vi.useFakeTimers({ toFake: ['Date'] });
    at('08:00:00');
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

  it('answers within the maximum (control)', async () => {
    await signIn();
    at('15:59:59');
    expect((await settingsGet()).status).toBe(200);
    expect((await archiveGet()).status).toBe(200);
    expect((await approvalStatus()).status).toBe(200);
    expect(await instanceDetails()).toEqual({ visible: true, identity: { admin: false, addresses: [USER] } });
  });

  it('refuses a context past the maximum', async () => {
    await signIn();
    at('16:00:01');
    expect((await settingsGet()).status).toBe(403);
    expect((await archiveGet()).status).toBe(403);
    expect((await approvalStatus()).status).toBe(401);
    expect(await instanceDetails()).toEqual({ visible: false, identity: { admin: false, addresses: [] } });
  });

  it('refuses a remembered session past the maximum when there is no context', async () => {
    await signIn();
    jar.delete('jmap_stalwart_ctx');
    at('16:00:01');
    expect((await settingsGet()).status).toBe(403);
    expect((await approvalStatus()).status).toBe(401);
    expect(await instanceDetails()).toEqual({ visible: false, identity: { admin: false, addresses: [] } });
  });

  it('takes the remembered session without a context within the maximum (control)', async () => {
    await signIn();
    jar.delete('jmap_stalwart_ctx');
    at('15:59:59');
    expect((await settingsGet()).status).toBe(200);
    expect((await approvalStatus()).status).toBe(200);
    expect((await instanceDetails()).visible).toBe(true);
  });

  it('keeps answering without a maximum', async () => {
    maxHours = 0;
    await signIn();
    at('23:00:00');
    expect((await settingsGet()).status).toBe(200);
    expect((await approvalStatus()).status).toBe(200);
  });

  it("counts an impersonation login against the target account's maximum", async () => {
    const { setStalwartAuthContextInStore, readCurrentStalwartAuthContext } = await import('@/lib/stalwart/auth-context');
    const store = await (await import('next/headers')).cookies();
    setStalwartAuthContextInStore(store as never, 3, { serverUrl: SERVER, username: `${USER}%admin@example.org`, authHeader: 'Basic aW1wZXJzb25hdGlvbg==' });
    at('15:59:59');
    expect(await readCurrentStalwartAuthContext(store as never, 3)).not.toBeNull();
    at('16:00:00');
    expect(await readCurrentStalwartAuthContext(store as never, 3)).toBeNull();
    expect(jar.has('jmap_stalwart_ctx_3')).toBe(false);
  });
});
