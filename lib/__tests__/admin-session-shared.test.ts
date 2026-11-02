/**
 * @vitest-environment node
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

// With a shared store (#1066) an admin signed out on one replica has to be
// refused on every other one at once, a new admin password has to sign out
// every old session everywhere, and two replicas writing the admin state at
// the same moment must not drop each other's sign-outs.

const jar = new Map<string, string>();
vi.mock('next/headers', () => ({
  cookies: async () => ({
    get: (name: string) => (jar.has(name) ? { name, value: jar.get(name)! } : undefined),
    set: (name: string, value: string) => { jar.set(name, value); },
    delete: (name: string) => { jar.delete(name); },
  }),
}));
vi.mock('@/lib/admin/audit', () => ({ auditLog: async () => {} }));

import {
  changeAdminPassword,
  getAdminSessionGeneration,
  initAdminPassword,
  isAdminEnabled,
  resetAdminCacheForTests,
  revokeAdminSession,
  setInitialAdminPassword,
  updateLastLogin,
  verifyAdminPassword,
} from '@/lib/admin/password';
import { clearAdminSessionCookie, requireAdminAuth, setAdminSessionCookie, verifyAdminSession } from '@/lib/admin/session';
import { adminConfigDocs, adminStateDocs } from '@/lib/admin/admin-store';
import { setStoreForTests } from '@/lib/shared-store';
import { resetLocalStoreForTests } from '@/lib/shared-store/local';
import { INIT_EPOCH, markEpochsSeen, pollChanges, resetChangesForTests } from '@/lib/shared-store/changes';
import type { AdminStateData } from '@/lib/admin/types';
import { separateFakeStore } from '@/lib/admin/__tests__/shared-store-fake';

const COOKIE = 'admin_session';
let dir: string;
let store: ReturnType<typeof separateFakeStore>;

beforeEach(async () => {
  jar.clear();
  dir = mkdtempSync(path.join(tmpdir(), 'bw-admin-shared-'));
  vi.stubEnv('SESSION_SECRET', 'a'.repeat(64));
  vi.stubEnv('ADMIN_CONFIG_DIR', path.join(dir, 'config'));
  vi.stubEnv('ADMIN_STATE_DIR', path.join(dir, 'state'));
  vi.stubEnv('ADMIN_PASSWORD', '');
  resetLocalStoreForTests();
  resetChangesForTests();
  resetAdminCacheForTests();
  store = separateFakeStore(path.join(dir, 'store'));
  setStoreForTests(store);
  await store.epochs.bump(INIT_EPOCH);
  await markEpochsSeen();
});

afterEach(() => {
  setStoreForTests(null);
  resetChangesForTests();
  resetLocalStoreForTests();
  resetAdminCacheForTests();
  vi.unstubAllEnvs();
  rmSync(dir, { recursive: true, force: true });
});

const post = (url: string) => new Request(`http://localhost${url}`, {
  method: 'POST',
  headers: { 'sec-fetch-site': 'same-origin' },
});

async function signIn(): Promise<string> {
  await setAdminSessionCookie(post('/api/admin/auth'));
  return jar.get(COOKIE)!;
}

/** The status an admin request with this cookie gets: 200 when it goes through. */
async function statusFor(token: string): Promise<number> {
  jar.set(COOKIE, token);
  const result = await requireAdminAuth(post('/api/admin/config'));
  return 'error' in result ? result.error.status : 200;
}

async function storedState(): Promise<AdminStateData> {
  const doc = await adminStateDocs().get('admin-state.json');
  return JSON.parse(doc!.data.toString('utf-8'));
}

/** What another replica's write to the admin state does. */
async function otherReplicaUpdatesState(change: (state: AdminStateData) => AdminStateData) {
  await adminStateDocs().update('admin-state.json', (current) =>
    JSON.stringify(change(current ? JSON.parse(current.toString('utf-8')) : { createdAt: '', lastLogin: null, passwordChangedAt: '' })),
  );
}

describe('admin sessions with a shared store', () => {
  it('refuses a token signed out on another replica, without a restart', async () => {
    await setInitialAdminPassword('first-password-1');
    const token = await signIn();
    expect(await statusFor(token)).toBe(200);

    const { sid, exp } = verifyAdminSession(token)!;
    await otherReplicaUpdatesState((state) => ({ ...state, revokedSessions: { ...state.revokedSessions, [sid]: exp } }));

    expect(await statusFor(token)).toBe(401);
  });

  it('keeps a sign-out from this replica for a replica that starts later', async () => {
    await setInitialAdminPassword('first-password-1');
    const token = await signIn();
    jar.set(COOKIE, token);
    await clearAdminSessionCookie();
    expect(Object.keys((await storedState()).revokedSessions ?? {})).toEqual([verifyAdminSession(token)!.sid]);

    resetAdminCacheForTests(); // a fresh process
    expect(await statusFor(token)).toBe(401);
  });

  it('moves the session generation on in the store when the password changes', async () => {
    await setInitialAdminPassword('first-password-1');
    const before = (await storedState()).sessionGeneration ?? 0;
    const token = await signIn();
    expect(await changeAdminPassword('first-password-1', 'second-password-2')).toBe(true);
    expect((await storedState()).sessionGeneration).toBe(before + 1);

    resetAdminCacheForTests();
    expect(await statusFor(token)).toBe(401);
    expect(await verifyAdminPassword('first-password-1')).toBe(false);
    expect(await verifyAdminPassword('second-password-2')).toBe(true);
    expect(await getAdminSessionGeneration()).toBe(before + 1);
  });

  it('keeps both of two sign-outs that land at the same moment', async () => {
    await setInitialAdminPassword('first-password-1');
    const exp = Math.floor(Date.now() / 1000) + 3600;
    await Promise.all([revokeAdminSession('sid-a', exp), revokeAdminSession('sid-b', exp)]);
    expect(Object.keys((await storedState()).revokedSessions ?? {}).sort()).toEqual(['sid-a', 'sid-b']);
  });

  it('does not undo another replica\'s sign-out or password change when signing in here', async () => {
    await setInitialAdminPassword('first-password-1');
    await initAdminPassword();
    const generation = (await storedState()).sessionGeneration ?? 0;
    await otherReplicaUpdatesState((state) => ({
      ...state,
      sessionGeneration: generation + 1,
      revokedSessions: { 'sid-elsewhere': Math.floor(Date.now() / 1000) + 3600 },
    }));

    await updateLastLogin();

    const state = await storedState();
    expect(state.sessionGeneration).toBe(generation + 1);
    expect(state.revokedSessions).toHaveProperty('sid-elsewhere');
    expect(state.lastLogin).not.toBeNull();
  });

  it('checks the password against the stored admin.json, not this replica\'s copy', async () => {
    await setInitialAdminPassword('first-password-1');
    const first = await adminConfigDocs().get('admin.json');
    await setInitialAdminPassword('second-password-2', { allowOverwrite: true });
    // Another replica put the first password back.
    await adminConfigDocs().put('admin.json', first!.data);
    expect(await verifyAdminPassword('first-password-1')).toBe(true);
    expect(await verifyAdminPassword('second-password-2')).toBe(false);
  });

  it('sees an admin password another replica\'s setup wizard created', async () => {
    // An admin.json as another replica's wizard writes it.
    setStoreForTests(separateFakeStore(path.join(dir, 'elsewhere')));
    await setInitialAdminPassword('wizard-password-1');
    const created = await adminConfigDocs().get('admin.json');
    setStoreForTests(store);
    resetChangesForTests();
    await markEpochsSeen();
    resetAdminCacheForTests();

    expect(await initAdminPassword()).toBe(false);
    expect(isAdminEnabled()).toBe(false);

    // The wizard on the other replica saves it and announces it.
    await adminConfigDocs().put('admin.json', created!.data);
    await store.epochs.bump('admin');
    await pollChanges();

    expect(isAdminEnabled()).toBe(true);
    expect(await initAdminPassword()).toBe(true);
    expect(await verifyAdminPassword('wizard-password-1')).toBe(true);
  });

  it('refuses every admin request with 503 while the store is down', async () => {
    await setInitialAdminPassword('first-password-1');
    const token = await signIn();
    store.down = true;
    expect(await statusFor(token)).toBe(503);
    store.down = false;
    expect(await statusFor(token)).toBe(200);
  });

  it('says so when a sign-out could not be stored', async () => {
    await setInitialAdminPassword('first-password-1');
    const token = await signIn();
    store.down = true;
    const { DELETE } = await import('@/app/api/admin/auth/route');
    const res = await DELETE(new NextRequest('http://localhost/api/admin/auth', { method: 'DELETE', headers: { 'sec-fetch-site': 'same-origin' } }));
    expect(res.status).toBe(503);
    expect((await res.json()).error).toMatch(/could not be saved/);
    expect(jar.has(COOKIE)).toBe(false);
    store.down = false;
    // As said: the copy still works.
    expect(await statusFor(token)).toBe(200);
  });

  it('refuses the second of two password changes at once with 409, not "incorrect"', async () => {
    await setInitialAdminPassword('first-password-1');
    await signIn();
    const { POST } = await import('@/app/api/admin/change-password/route');
    const change = (newPassword: string) => POST(new NextRequest('http://localhost/api/admin/change-password', {
      method: 'POST',
      headers: { 'sec-fetch-site': 'same-origin', 'content-type': 'application/json' },
      body: JSON.stringify({ currentPassword: 'first-password-1', newPassword }),
    }));
    const statuses = (await Promise.all([change('second-password-2'), change('third-password-3')])).map((r) => r.status);
    expect(statuses.sort()).toEqual([200, 409]);
    expect([await verifyAdminPassword('second-password-2'), await verifyAdminPassword('third-password-3')].filter(Boolean)).toHaveLength(1);
  });
});
