// @vitest-environment node
//
// "Sign in to the admin console as a Stalwart admin" (stalwartAdminAccess,
// on by default) asks the mail server the user is signed in to whether they
// are its superuser. With several servers on the sign-in list, only the
// instance's own server (jmapServerUrl) may answer that, unless the admin
// marked another entry with `adminAccess: true`: a listed server may be run
// by someone else, and its superuser would get the whole console. A
// superuser of any other listed server is an ordinary user of this webmail.
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { resetLocalStoreForTests } from '@/lib/shared-store/local';
import {
  grantsAdminAccess,
  parseJmapServers,
  redactJmapServers,
  redactJmapServersForAdmin,
} from '@/lib/admin/jmap-servers';

vi.mock('@/lib/logger', () => ({
  logger: { warn: () => {}, error: () => {}, info: () => {}, debug: () => {} },
}));
vi.mock('@/lib/auth/session-secret', () => ({
  getSessionSecret: () => 's'.repeat(64),
  hasSessionSecret: () => true,
}));
vi.mock('@/lib/telemetry/login-tracker', () => ({ recordLogin: () => {} }));
vi.mock('@/lib/admin/audit', () => ({ auditLog: async () => {} }));

const OWN = 'https://mail.example.org';
const PARTNER = 'https://partner.example';
let servers: Record<string, unknown>[] = [];
vi.mock('@/lib/admin/config-manager', () => ({
  configManager: {
    ensureLoaded: async () => {},
    get: (key: string, fallback?: unknown) => ({ jmapServerUrl: OWN, jmapServers: servers } as Record<string, unknown>)[key] ?? fallback,
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

const SAME_ORIGIN = { 'sec-fetch-site': 'same-origin', 'sec-fetch-mode': 'cors', 'sec-fetch-dest': 'empty', 'content-type': 'application/json' };

/** Both servers call whoever asks a superuser: each operator decides what its server answers. */
function mailServers(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const url = new URL(String(input));
  if (url.pathname === '/.well-known/jmap') {
    return Promise.resolve(Response.json({
      apiUrl: `${url.origin}/jmap/`,
      username: `root@${url.host}`,
      accounts: { p1: { name: `root@${url.host}` } },
      primaryAccounts: { 'urn:ietf:params:jmap:mail': 'p1' },
    }));
  }
  const [name, , id] = JSON.parse(String(init?.body)).methodCalls[0] as [string, unknown, string];
  return Promise.resolve(Response.json({ methodResponses: [[name, { ids: [] }, id]] }));
}

async function signInAt(serverUrl: string) {
  const { POST: signIn } = await import('@/app/api/auth/session/route');
  const signedIn = await signIn(new NextRequest('https://webmail.example/api/auth/session', {
    method: 'POST',
    headers: SAME_ORIGIN,
    body: JSON.stringify({ serverUrl, username: `root@${new URL(serverUrl).host}`, password: 'pw', slot: 0 }),
  }));
  expect(signedIn.status).toBe(200);
}

/** Signs in at `serverUrl` and asks for the admin console as a Stalwart admin. */
async function adminSignInThrough(serverUrl: string) {
  await signInAt(serverUrl);
  const { POST: adminLogin } = await import('@/app/api/admin/auth/route');
  const res = await adminLogin(new NextRequest('https://webmail.example/api/admin/auth', {
    method: 'POST',
    headers: { ...SAME_ORIGIN, 'X-JMAP-Cookie-Slot': '0' },
    body: JSON.stringify({ stalwartAuth: true }),
  }));
  const adminCookie = [...jar.keys()].find((name) => /admin/i.test(name) && !/device/i.test(name));
  return { status: res.status, adminCookie };
}

/** What the app's status check (GET) says after signing in at `serverUrl`. */
async function adminStatusThrough(serverUrl: string) {
  await signInAt(serverUrl);
  const { GET } = await import('@/app/api/admin/auth/route');
  const res = await GET(new NextRequest('https://webmail.example/api/admin/auth', { headers: { 'X-JMAP-Cookie-Slot': '0' } }));
  return (await res.json()) as { stalwartAdmin: boolean; stalwartAutoLogin: boolean };
}

describe('which server\'s superusers are admins of the webmail', () => {
  const stateDir = mkdtempSync(path.join(tmpdir(), 'bw-admin-listed-'));
  afterAll(() => rmSync(stateDir, { recursive: true, force: true }));
  beforeAll(() => {
    process.env.ADMIN_STATE_DIR = stateDir;
    process.env.ADMIN_CONFIG_DIR = stateDir;
  });
  beforeEach(() => {
    vi.resetModules();
    jar = new Map();
    servers = [
      { id: 'own', label: 'Our mail', url: OWN },
      { id: 'partner', label: 'Partner', url: PARTNER },
    ];
    resetLocalStoreForTests();
    vi.stubGlobal('fetch', vi.fn(mailServers));
  });
  afterEach(() => vi.unstubAllGlobals());

  it('a superuser of another listed server gets no admin session', async () => {
    const { status, adminCookie } = await adminSignInThrough(PARTNER);
    expect(status).toBe(403);
    expect(adminCookie).toBeUndefined();
  });

  it('and the status check says the same', async () => {
    expect(await adminStatusThrough(PARTNER)).toMatchObject({ stalwartAdmin: false, stalwartAutoLogin: false });
  });

  it('a superuser of the instance\'s own server still does (control)', async () => {
    const { status, adminCookie } = await adminSignInThrough(OWN);
    expect(status).toBe(200);
    expect(adminCookie).toBeDefined();
    jar = new Map();
    expect(await adminStatusThrough(OWN)).toMatchObject({ stalwartAdmin: true, stalwartAutoLogin: true });
  });

  it('so does one of a listed server the admin marked with adminAccess', async () => {
    servers = [
      { id: 'own', label: 'Our mail', url: OWN },
      { id: 'partner', label: 'Partner', url: PARTNER, adminAccess: true },
    ];
    const { status, adminCookie } = await adminSignInThrough(PARTNER);
    expect(status).toBe(200);
    expect(adminCookie).toBeDefined();
  });

  it('asks another listed server nothing', async () => {
    await signInAt(PARTNER);
    const fetchMock = vi.mocked(fetch);
    fetchMock.mockClear();
    const { GET } = await import('@/app/api/admin/auth/route');
    await GET(new NextRequest('https://webmail.example/api/admin/auth', { headers: { 'X-JMAP-Cookie-Slot': '0' } }));
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('grantsAdminAccess', () => {
  const list = parseJmapServers([
    { id: 'own', label: 'Own', url: 'https://mail.example.org' },
    { id: 'partner', label: 'Partner', url: 'https://partner.example' },
    { id: 'sister', label: 'Sister', url: 'https://sister.example/jmap', adminAccess: true },
  ]);

  it('takes the instance\'s own server however it is written', () => {
    for (const url of ['https://mail.example.org', 'https://mail.example.org/', 'https://MAIL.Example.ORG', 'https://Mail.example.org//']) {
      expect(grantsAdminAccess(url, 'https://mail.example.org/', list), url).toBe(true);
    }
  });

  it('takes the instance\'s own server when the list leaves it out', () => {
    const others = parseJmapServers([{ id: 'partner', label: 'Partner', url: 'https://partner.example' }]);
    expect(grantsAdminAccess('https://mail.example.org', 'https://mail.example.org', others)).toBe(true);
    expect(grantsAdminAccess('https://partner.example', 'https://mail.example.org', others)).toBe(false);
  });

  it('takes a listed server only when it is marked', () => {
    expect(grantsAdminAccess('https://partner.example', 'https://mail.example.org', list)).toBe(false);
    expect(grantsAdminAccess('https://SISTER.example/jmap/', 'https://mail.example.org', list)).toBe(true);
  });

  it('never takes a server that is not configured (one a user typed)', () => {
    expect(grantsAdminAccess('https://typed.example', 'https://mail.example.org', list)).toBe(false);
    expect(grantsAdminAccess('https://mail.example.org.evil.example', 'https://mail.example.org', list)).toBe(false);
  });

  it('without an own server, takes the only entry of a list of one, and no entry of a longer list unless marked', () => {
    const one = parseJmapServers([{ id: 'only', label: 'Only', url: 'https://only.example' }]);
    expect(grantsAdminAccess('https://only.example', '', one)).toBe(true);
    expect(grantsAdminAccess('https://partner.example', '', list)).toBe(false);
    expect(grantsAdminAccess('https://mail.example.org', '', list)).toBe(false);
    expect(grantsAdminAccess('https://sister.example/jmap', '', list)).toBe(true);
  });
});

describe('the adminAccess flag in the server list', () => {
  it('is kept only when it is true', () => {
    const parsed = parseJmapServers([
      { id: 'a', label: 'A', url: 'https://a.example', adminAccess: true },
      { id: 'b', label: 'B', url: 'https://b.example', adminAccess: 'true' },
      { id: 'c', label: 'C', url: 'https://c.example', adminAccess: 1 },
      { id: 'd', label: 'D', url: 'https://d.example', adminAccess: false },
    ]);
    expect(parsed.map((s) => s.adminAccess)).toEqual([true, undefined, undefined, undefined]);
  });

  it('goes to the admin dashboard, not to the login page', () => {
    const parsed = parseJmapServers([{ id: 'a', label: 'A', url: 'https://a.example', adminAccess: true }]);
    expect(redactJmapServersForAdmin(parsed)[0].adminAccess).toBe(true);
    expect(JSON.stringify(redactJmapServers(parsed))).not.toContain('adminAccess');
  });
});
