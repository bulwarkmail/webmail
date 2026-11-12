// @vitest-environment node
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { resetLocalStoreForTests } from '@/lib/shared-store/local';

// Restoring a remembered sign-in (GET and PUT /api/auth/session) writes the
// slot's context again, with the account the sign-in resolved the login to.
// Two users who both signed in with an access token and the bare name `john`
// (john@a.example and john@b.example on one server) keep their own synced
// settings, which are keyed on that account.

vi.mock('@/lib/auth/session-secret', () => ({
  getSessionSecret: () => 's'.repeat(64),
  hasSessionSecret: () => true,
}));
vi.mock('@/lib/logger', () => ({
  logger: { warn: () => {}, error: () => {}, info: () => {}, debug: () => {} },
}));
vi.mock('@/lib/telemetry/login-tracker', () => ({ recordLogin: () => {} }));

const SERVER = 'https://mail.example.org';
vi.mock('@/lib/admin/config-manager', () => ({
  configManager: {
    ensureLoaded: async () => {},
    get: (key: string, fallback: unknown) => (key === 'jmapServerUrl' ? SERVER : fallback),
    getPolicy: () => ({}),
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

/** Session documents the mail server answered, by access token. */
let sessionRequests: string[];

/** One server with two accounts whose local part is `john`; each token belongs to one. */
function twoJohns(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const url = String(input);
  const auth = new Headers(init?.headers).get('authorization') ?? '';
  if (url.endsWith('/.well-known/jmap')) {
    sessionRequests.push(auth);
    const user = auth === 'Bearer AT-A' ? 'john@a.example' : auth === 'Bearer AT-B' ? 'john@b.example' : '';
    if (!user) return Promise.resolve(new Response('unauthorized', { status: 401 }));
    return Promise.resolve(Response.json({ apiUrl: `${SERVER}/jmap/`, username: user, accounts: { acc: { name: user } }, primaryAccounts: { 'urn:ietf:params:jmap:mail': 'acc' } }));
  }
  return Promise.resolve(Response.json({ methodResponses: [] }));
}

async function signIn(token: string) {
  jar = new Map();
  const { POST } = await import('@/app/api/auth/session/route');
  const res = await POST(new NextRequest('https://webmail.example/api/auth/session', {
    method: 'POST',
    headers: { ...SAME_ORIGIN, 'content-type': 'application/json' },
    body: JSON.stringify({ serverUrl: SERVER, username: 'john', token, slot: 0 }),
  }));
  expect(res.status).toBe(200);
}

/** A new browser session: the context cookie is gone, the remembered one restores it. */
async function restore(method: 'GET' | 'PUT' = 'GET') {
  jar.delete('jmap_stalwart_ctx');
  const route = await import('@/app/api/auth/session/route');
  return route[method](new NextRequest('https://webmail.example/api/auth/session', { method, headers: SAME_ORIGIN }));
}

/** A remembered session as sign-ins wrote it before the account went into it. */
async function rememberedFromBefore(token: string) {
  jar = new Map();
  const { encryptSession } = await import('@/lib/auth/crypto');
  jar.set('jmap_session', encryptSession(SERVER, 'john', { token }, Date.now()));
}

async function contextAccount() {
  const { readStalwartAuthContextFromStore } = await import('@/lib/stalwart/auth-context');
  const store = await (await import('next/headers')).cookies();
  return readStalwartAuthContextFromStore(store as never, 0)?.accountName;
}

async function saveSettings(value: string) {
  const { POST } = await import('@/app/api/settings/route');
  return POST(new NextRequest('https://webmail.example/api/settings', {
    method: 'POST',
    headers: { ...SAME_ORIGIN, 'content-type': 'application/json', origin: 'https://webmail.example' },
    body: JSON.stringify({ username: 'john', serverUrl: SERVER, settings: { note: value } }),
  }));
}

async function loadSettings() {
  const { GET } = await import('@/app/api/settings/route');
  const res = await GET(new NextRequest('https://webmail.example/api/settings', {
    headers: { ...SAME_ORIGIN, 'x-settings-username': 'john', 'x-settings-server': SERVER },
  }));
  return JSON.stringify(await res.json());
}

describe('restoring a remembered token sign-in that claimed a bare name', () => {
  const stateDir = mkdtempSync(path.join(tmpdir(), 'bw-restore-account-state-'));
  const settingsDir = mkdtempSync(path.join(tmpdir(), 'bw-restore-account-settings-'));
  afterAll(() => { rmSync(stateDir, { recursive: true, force: true }); rmSync(settingsDir, { recursive: true, force: true }); });
  // Loaded once up front, so no single test spends its time limit on it.
  beforeAll(async () => {
    process.env.ADMIN_STATE_DIR = stateDir;
    process.env.SETTINGS_DATA_DIR = settingsDir;
    process.env.SETTINGS_SYNC_ENABLED = 'true';
    await Promise.all([import('@/app/api/auth/session/route'), import('@/app/api/settings/route')]);
  }, 60_000);
  beforeEach(() => {
    resetLocalStoreForTests();
    rmSync(settingsDir, { recursive: true, force: true });
    sessionRequests = [];
    vi.stubGlobal('fetch', vi.fn(twoJohns));
  });
  afterEach(() => vi.unstubAllGlobals());

  it('keeps the account the sign-in resolved the bare login to, on GET and on PUT, without asking the mail server again', async () => {
    await signIn('AT-A');
    expect(await contextAccount()).toBe('john@a.example');
    sessionRequests = [];
    expect((await restore('GET')).status).toBe(200);
    expect(await contextAccount()).toBe('john@a.example');
    const put = await restore('PUT');
    expect(put.status).toBe(200);
    expect(await contextAccount()).toBe('john@a.example');
    // The browser gets the credentials as before, not the account name.
    expect(Object.keys(await put.json()).sort()).toEqual(['serverUrl', 'signedInAt', 'token', 'username']);
    expect(sessionRequests).toEqual([]);
  });

  it('keeps each user to their own settings without a restore (control)', async () => {
    await signIn('AT-A');
    expect((await saveSettings('SAVED-BY-JOHN-A-1')).status).toBe(200);
    await signIn('AT-B');
    expect(await loadSettings()).not.toContain('SAVED-BY-JOHN-A-1');
  });

  it('keeps each user to their own settings after a restore in each browser', async () => {
    await signIn('AT-A');
    expect((await restore()).status).toBe(200);
    expect((await saveSettings('SAVED-BY-JOHN-A-2')).status).toBe(200);
    await signIn('AT-B');
    expect((await restore()).status).toBe(200);
    expect(await loadSettings()).not.toContain('SAVED-BY-JOHN-A-2');
  });

  it('asks the mail server for the account of a remembered session from before it was kept', async () => {
    await rememberedFromBefore('AT-B');
    expect((await restore()).status).toBe(200);
    expect(await contextAccount()).toBe('john@b.example');
    expect(sessionRequests).toEqual(['Bearer AT-B']);
  });

  it('writes no context for such a session while the mail server can not be asked, and ends one it refuses', async () => {
    await rememberedFromBefore('AT-B');
    vi.stubGlobal('fetch', vi.fn(async () => { throw new TypeError('fetch failed'); }));
    expect((await restore()).status).toBe(200);
    expect(jar.has('jmap_stalwart_ctx')).toBe(false);

    await rememberedFromBefore('AT-REVOKED');
    vi.stubGlobal('fetch', vi.fn(twoJohns));
    expect((await restore()).status).toBe(401);
    expect(jar.has('jmap_session')).toBe(false);
    expect(jar.has('jmap_stalwart_ctx')).toBe(false);
  });

  it('serves settings saved under the bare name before the fix to neither user', async () => {
    // As the restore wrote it before: a context without the account.
    await signIn('AT-A');
    const { setStalwartAuthContextInStore } = await import('@/lib/stalwart/auth-context');
    const store = await (await import('next/headers')).cookies();
    setStalwartAuthContextInStore(store as never, 0, { serverUrl: SERVER, username: 'john', authHeader: 'Bearer AT-A' });
    expect((await saveSettings('SAVED-UNDER-THE-BARE-NAME')).status).toBe(200);

    await signIn('AT-B');
    expect((await restore()).status).toBe(200);
    expect(await loadSettings()).not.toContain('SAVED-UNDER-THE-BARE-NAME');

    await rememberedFromBefore('AT-A');
    expect((await restore()).status).toBe(200);
    expect(await loadSettings()).not.toContain('SAVED-UNDER-THE-BARE-NAME');
  });
});
