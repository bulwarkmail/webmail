// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

// A Bearer login may claim a bare local part ("john"). The settings route
// keyed synced settings on the claim, so on a multi-domain server
// john@b.example's token could read and overwrite the settings of the
// john@a.example who signs in as "john". The context cookie now carries the
// canonical account name and the route keys on it.

vi.mock('@/lib/auth/session-secret', () => ({
  getSessionSecret: () => 's'.repeat(64),
  hasSessionSecret: () => true,
}));
vi.mock('@/lib/logger', () => ({
  logger: { warn: () => {}, error: () => {}, info: () => {}, debug: () => {} },
}));
vi.mock('@/lib/admin/config-manager', () => ({
  configManager: {
    ensureLoaded: async () => {},
    get: (key: string, fallback: unknown) => (key === 'settingsSyncEnabled' ? true : fallback),
    getPolicy: () => ({ restrictions: {} }),
  },
}));

const jar = new Map<string, string>();
vi.mock('next/headers', () => ({
  cookies: async () => ({
    get: (name: string) => (jar.has(name) ? { name, value: jar.get(name)! } : undefined),
    set: (name: string, value: string) => { jar.set(name, value); },
    delete: (name: string) => { jar.delete(name); },
    getAll: () => [...jar].map(([name, value]) => ({ name, value })),
  }),
}));

const store = new Map<string, Record<string, unknown>>();
vi.mock('@/lib/settings-sync', () => ({
  loadUserSettings: async (username: string, serverUrl: string) => store.get(`${username}|${serverUrl}`) ?? null,
  saveUserSettings: async (username: string, serverUrl: string, settings: Record<string, unknown>) => {
    store.set(`${username}|${serverUrl}`, settings);
  },
  deleteUserSettings: async (username: string, serverUrl: string) => { store.delete(`${username}|${serverUrl}`); },
}));

const SERVER = 'https://mail.example.org';
const SAME_ORIGIN = { 'sec-fetch-site': 'same-origin', 'content-type': 'application/json' };

async function signIn(context: { username: string; accountName?: string }) {
  jar.clear();
  const { setStalwartAuthContextInStore } = await import('@/lib/stalwart/auth-context');
  const cookieStore = {
    get: (n: string) => (jar.has(n) ? { name: n, value: jar.get(n)! } : undefined),
    set: (n: string, v: string) => { jar.set(n, v); },
    delete: (n: string) => { jar.delete(n); },
  };
  setStalwartAuthContextInStore(cookieStore as never, 0, { serverUrl: SERVER, authHeader: 'Bearer t', ...context });
}

beforeEach(() => {
  store.clear();
  process.env.SETTINGS_SYNC_ENABLED = 'true';
});

describe('settings route keys on the account the credential belongs to', () => {
  it('saves a bare Bearer claim under the canonical account name', async () => {
    await signIn({ username: 'john', accountName: 'john@b.example' });
    const { POST } = await import('@/app/api/settings/route');
    const res = await POST(new NextRequest('https://webmail.example/api/settings', {
      method: 'POST',
      headers: SAME_ORIGIN,
      body: JSON.stringify({ username: 'john', serverUrl: SERVER, settings: { theme: 'dark' } }),
    }));
    expect(res.status).toBe(200);
    expect([...store.keys()]).toEqual([`john@b.example|${SERVER}`]);
  });

  it("does not read the settings of the john who signs in with a password", async () => {
    store.set(`john|${SERVER}`, { signature: 'john@a.example private' });
    await signIn({ username: 'john', accountName: 'john@b.example' });
    const { GET } = await import('@/app/api/settings/route');
    const res = await GET(new NextRequest('https://webmail.example/api/settings', {
      headers: { 'x-settings-username': 'john', 'x-settings-server': SERVER },
    }));
    expect(await res.json()).toEqual({ settings: null });
  });

  it('keys on the canonical account even when a remember-me session cookie carries the bare claim', async () => {
    // /api/auth/session writes both cookies for a token login; the session
    // cookie only knows the claim, the context the account it resolved to.
    store.set(`john|${SERVER}`, { signature: 'john@a.example private' });
    await signIn({ username: 'john', accountName: 'john@b.example' });
    const { encryptSession } = await import('@/lib/auth/crypto');
    const { sessionCookieName } = await import('@/lib/auth/session-cookie');
    jar.set(sessionCookieName(0), encryptSession(SERVER, 'john', { token: 't' }));
    const { GET, POST } = await import('@/app/api/settings/route');
    const read = await GET(new NextRequest('https://webmail.example/api/settings', {
      headers: { 'x-settings-username': 'john', 'x-settings-server': SERVER },
    }));
    expect(await read.json()).toEqual({ settings: null });
    await POST(new NextRequest('https://webmail.example/api/settings', {
      method: 'POST',
      headers: SAME_ORIGIN,
      body: JSON.stringify({ username: 'john', serverUrl: SERVER, settings: { theme: 'dark' } }),
    }));
    expect(store.get(`john|${SERVER}`)).toEqual({ signature: 'john@a.example private' });
    expect(store.get(`john@b.example|${SERVER}`)).toEqual({ theme: 'dark' });
  });

  it('refuses to key on a bare token-login claim when no context cookie resolves it', async () => {
    jar.clear();
    const { encryptSession } = await import('@/lib/auth/crypto');
    const { sessionCookieName } = await import('@/lib/auth/session-cookie');
    jar.set(sessionCookieName(0), encryptSession(SERVER, 'john', { token: 't' }));
    const { GET } = await import('@/app/api/settings/route');
    const res = await GET(new NextRequest('https://webmail.example/api/settings', {
      headers: { 'x-settings-username': 'john', 'x-settings-server': SERVER },
    }));
    expect(res.status).toBe(403);
  });

  it('keeps keying on the login name when the context names no other account', async () => {
    await signIn({ username: 'alice@example.org' });
    const { POST } = await import('@/app/api/settings/route');
    await POST(new NextRequest('https://webmail.example/api/settings', {
      method: 'POST',
      headers: SAME_ORIGIN,
      body: JSON.stringify({ username: 'alice@example.org', serverUrl: SERVER, settings: { theme: 'light' } }),
    }));
    expect([...store.keys()]).toEqual([`alice@example.org|${SERVER}`]);
  });

  it('refuses a settings blob over the size cap before parsing it', async () => {
    // One blob per account, re-read on every sync: it was accepted at any size.
    await signIn({ username: 'alice@example.org' });
    const { POST } = await import('@/app/api/settings/route');
    const big = JSON.stringify({ username: 'alice@example.org', serverUrl: SERVER, settings: { signature: 'x'.repeat(2 * 1024 * 1024 + 10) } });
    const res = await POST(new NextRequest('https://webmail.example/api/settings', { method: 'POST', headers: SAME_ORIGIN, body: big }));
    expect(res.status).toBe(413);
    expect(store.size).toBe(0);
    const claimed = await POST(new NextRequest('https://webmail.example/api/settings', {
      method: 'POST',
      headers: { ...SAME_ORIGIN, 'content-length': String(3 * 1024 * 1024) },
      body: JSON.stringify({ username: 'alice@example.org', serverUrl: SERVER, settings: { theme: 'dark' } }),
    }));
    expect(claimed.status).toBe(413);
  });

  it('keeps one blob per account however many slashes end the server address', async () => {
    // The address is matched with its trailing slashes stripped but was
    // stored as sent, so each extra slash wrote another blob of up to 2 MB.
    await signIn({ username: 'alice@example.org' });
    const { GET, POST } = await import('@/app/api/settings/route');
    for (const slashes of [0, 1, 2, 3, 7]) {
      const res = await POST(new NextRequest('https://webmail.example/api/settings', {
        method: 'POST',
        headers: SAME_ORIGIN,
        body: JSON.stringify({ username: 'alice@example.org', serverUrl: SERVER + '/'.repeat(slashes), settings: { n: slashes } }),
      }));
      expect(res.status).toBe(200);
    }
    // Clients send the address with or without one slash; both keep their blob.
    expect([...store.keys()].sort()).toEqual([`alice@example.org|${SERVER}`, `alice@example.org|${SERVER}/`]);
    const read = await GET(new NextRequest('https://webmail.example/api/settings', {
      headers: { 'x-settings-username': 'alice@example.org', 'x-settings-server': `${SERVER}//` },
    }));
    expect(await read.json()).toEqual({ settings: { n: 7 } });
  });
});
