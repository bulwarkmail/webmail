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
vi.mock('@/lib/plugin-secrets/vault', () => ({
  VaultFullError: class extends Error {},
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

beforeEach(() => {
  deleted.length = 0;
  session.signedIn = false;
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('DELETE /api/plugin-secrets?all=true', () => {
  it('in the desktop app takes a dropped account by who it was, with no cookie', async () => {
    vi.stubEnv('NEXT_PUBLIC_BULWARK_DESKTOP', '1');
    expect((await remove(EVICTED)).status).toBe(200);
    expect(deleted).toEqual([{ username: 'alice', serverUrl: 'https://mail.example.org' }]);
  });

  it('won\'t take it from another site', async () => {
    vi.stubEnv('NEXT_PUBLIC_BULWARK_DESKTOP', '1');
    expect((await remove(EVICTED, { 'sec-fetch-site': 'cross-site' })).status).toBe(403);
    expect(deleted).toEqual([]);
  });

  it('on an instance deletes nobody\'s, with a cookie or without', async () => {
    expect((await remove(EVICTED)).status).toBe(401);
    session.signedIn = true;
    await remove(EVICTED);
    expect(deleted).toEqual([]);
  });

  it('in the desktop app with a cookie and no name takes the signed-in account', async () => {
    vi.stubEnv('NEXT_PUBLIC_BULWARK_DESKTOP', '1');
    session.signedIn = true;
    expect((await remove('all=true')).status).toBe(200);
    expect(deleted).toEqual([{ username: 'me@example.org', serverUrl: 'https://mail.example.org' }]);
  });
});
