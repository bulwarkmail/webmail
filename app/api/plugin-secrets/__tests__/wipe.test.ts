/**
 * @vitest-environment node
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

// Deleting everything of one user, which only makes sense where the server and its
// files are on the device: the desktop app. On an instance the same request is a
// way to delete someone else's connected accounts, so it has to do nothing.

const deleted = vi.hoisted(() => [] as unknown[]);
const session = vi.hoisted(() => ({ signedIn: false }));
vi.mock('@/lib/stalwart/credentials', () => ({
  getStalwartCredentials: async () => (session.signedIn ? { accountName: 'me@example.org', serverUrl: 'https://mail.example.org', authHeader: 'x' } : null),
}));
vi.mock('@/lib/admin/config-manager', () => ({
  configManager: { ensureLoaded: async () => {}, get: () => undefined, getPolicy: () => ({ features: { pluginsEnabled: true } }) },
}));
vi.mock('@/lib/plugin-secrets/known-plugins', () => ({
  declaredUserCredential: async () => ({ inject: { type: 'bearer' } }),
}));
vi.mock('@/lib/plugin-secrets/proxy', () => ({
  adminCredentialOrigins: async () => [],
  adminCredentialStatus: async () => [],
}));
vi.mock('@/lib/plugin-secrets/vault', () => ({
  VaultFullError: class extends Error {},
  userKey: (user: { username: string; serverUrl: string }) => `${Buffer.from(`${user.username}:${user.serverUrl}`).toString('hex')}0000000000000000`.slice(0, 64),
  deleteAllUserCredentials: vi.fn(async (user: unknown) => { deleted.push(user); }),
  deleteUserCredentials: vi.fn(async () => {}),
  listUserCredentials: vi.fn(async () => []),
  putUserCredential: vi.fn(async () => {}),
}));

async function remove(query: string, headers: Record<string, string> = { 'sec-fetch-site': 'same-origin' }): Promise<Response> {
  vi.resetModules();
  const { DELETE } = await import('../route');
  return DELETE(new NextRequest(`https://app.local/api/plugin-secrets?${query}`, { method: 'DELETE', headers }));
}

const EVICTED = 'all=true&username=alice&server=https%3A%2F%2Fmail.example.org';
const SAME_ORIGIN = { 'sec-fetch-site': 'same-origin' };

/** The proof cookie an account gets while signed in, as `name=value`. */
async function proofFor(username: string): Promise<string> {
  vi.resetModules();
  const { setWipeProof } = await import('@/lib/plugin-secrets/wipe-proof');
  const { NextResponse } = await import('next/server');
  const answer = NextResponse.json({});
  setWipeProof(answer, { username, serverUrl: 'https://mail.example.org' });
  const cookie = answer.cookies.getAll()[0];
  return `${cookie.name}=${cookie.value}`;
}

beforeEach(() => {
  deleted.length = 0;
  session.signedIn = false;
  vi.stubEnv('SESSION_SECRET', 'wipe-test-session-secret-wipe-test-session-secret');
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('DELETE /api/plugin-secrets?all=true', () => {
  it('in the desktop app takes a dropped account by who it was, with the proof it got while signed in', async () => {
    vi.stubEnv('NEXT_PUBLIC_BULWARK_DESKTOP', '1');
    const answer = await remove(EVICTED, { ...SAME_ORIGIN, cookie: await proofFor('alice') });
    expect(answer.status).toBe(200);
    expect(deleted).toEqual([{ username: 'alice', serverUrl: 'https://mail.example.org' }]);
    expect(answer.headers.get('set-cookie')).toMatch(/Max-Age=0/i);
  });

  it('in the desktop app won\'t take any name on its own', async () => {
    vi.stubEnv('NEXT_PUBLIC_BULWARK_DESKTOP', '1');
    expect((await remove(EVICTED)).status).toBe(401);
    expect(deleted).toEqual([]);
  });

  it('in the desktop app won\'t take another account\'s proof, or the signed-in account\'s session, for that name', async () => {
    vi.stubEnv('NEXT_PUBLIC_BULWARK_DESKTOP', '1');
    session.signedIn = true;
    const bob = await proofFor('bob');
    const aliceName = (await proofFor('alice')).split('=')[0];
    expect((await remove(EVICTED, { ...SAME_ORIGIN, cookie: `${aliceName}=${bob.split('=').slice(1).join('=')}` })).status).toBe(401);
    expect((await remove(EVICTED, { ...SAME_ORIGIN, cookie: `${aliceName}=forged` })).status).toBe(401);
    expect(deleted).toEqual([]);
  });

  it('won\'t take it from another site', async () => {
    vi.stubEnv('NEXT_PUBLIC_BULWARK_DESKTOP', '1');
    const cookie = await proofFor('alice');
    expect((await remove(EVICTED, { 'sec-fetch-site': 'cross-site', cookie })).status).toBe(403);
    expect(deleted).toEqual([]);
  });

  it('gives the proof when an account lists what it has, in the desktop app only', async () => {
    session.signedIn = true;
    const list = async () => {
      vi.resetModules();
      const vault = await import('@/lib/plugin-secrets/vault');
      vi.mocked(vault.listUserCredentials).mockResolvedValueOnce([{ pluginId: 'p' } as never]);
      const { GET } = await import('../route');
      return GET(new NextRequest('https://app.local/api/plugin-secrets', { headers: SAME_ORIGIN }));
    };
    expect((await list()).headers.get('set-cookie')).toBeNull();
    vi.stubEnv('NEXT_PUBLIC_BULWARK_DESKTOP', '1');
    expect((await list()).headers.get('set-cookie')).toMatch(/^jmap_psp_/);
  });

  it('on an instance deletes nobody\'s, with a cookie or without', async () => {
    expect((await remove(EVICTED)).status).toBe(401);
    session.signedIn = true;
    await remove(EVICTED);
    expect(deleted).toEqual([]);
    await remove(EVICTED, { ...SAME_ORIGIN, cookie: await proofFor('alice') });
    expect(deleted).toEqual([]);
  });

  it('in the desktop app with a cookie and no name takes the signed-in account', async () => {
    vi.stubEnv('NEXT_PUBLIC_BULWARK_DESKTOP', '1');
    session.signedIn = true;
    expect((await remove('all=true')).status).toBe(200);
    expect(deleted).toEqual([{ username: 'me@example.org', serverUrl: 'https://mail.example.org' }]);
  });
});
