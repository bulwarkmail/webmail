// @vitest-environment node
import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { setStoreForTests } from '@/lib/shared-store';
import { resetLocalStoreForTests } from '@/lib/shared-store/local';
import { SETTINGS_COLLECTION, settingsId } from '@/lib/settings-sync';
import { separateDiskStore, type SeparateDiskStore } from './helpers/separate-disk-store';

// Synced settings with a shared store (#1066): every replica reads and
// writes the one store, never its own disk.

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

const SERVER = 'https://mail.example.org';
const USER = 'alice@example.org';

let disks: string;
let store: SeparateDiskStore;

/** Point this process at one replica's own data dir. */
function onReplica(name: 'a' | 'b') {
  vi.stubEnv('SETTINGS_DATA_DIR', path.join(disks, name, 'settings'));
}

beforeEach(async () => {
  disks = mkdtempSync(path.join(tmpdir(), 'bw-settings-replicas-'));
  store = separateDiskStore();
  setStoreForTests(store);
  vi.stubEnv('SETTINGS_SYNC_ENABLED', 'true');
  onReplica('a');
  jar.clear();
  const { setStalwartAuthContextInStore } = await import('@/lib/stalwart/auth-context');
  setStalwartAuthContextInStore({
    get: (n: string) => (jar.has(n) ? { name: n, value: jar.get(n)! } : undefined),
    set: (n: string, v: string) => { jar.set(n, v); },
    delete: (n: string) => { jar.delete(n); },
  } as never, 0, { serverUrl: SERVER, authHeader: 'Bearer t', username: USER });
});

afterEach(() => {
  setStoreForTests(null);
  resetLocalStoreForTests();
  vi.unstubAllEnvs();
  store.cleanup();
  rmSync(disks, { recursive: true, force: true });
});

function template(id: string) {
  const at = '2026-10-01T00:00:00.000Z';
  return { id, name: id, subject: '', body: '', isHTML: false, category: '', isFavorite: false, createdAt: at, updatedAt: at };
}

async function push(settings: Record<string, unknown>) {
  const { POST } = await import('@/app/api/settings/route');
  return POST(new NextRequest('https://webmail.example/api/settings', {
    method: 'POST',
    headers: { 'sec-fetch-site': 'same-origin', 'content-type': 'application/json' },
    body: JSON.stringify({ username: USER, serverUrl: SERVER, settings }),
  }));
}

async function fetchSettings() {
  const { GET } = await import('@/app/api/settings/route');
  return GET(new NextRequest('https://webmail.example/api/settings', {
    headers: { 'x-settings-username': USER, 'x-settings-server': SERVER },
  }));
}

function storedDoc() {
  return store.collection('settings', SETTINGS_COLLECTION).get(settingsId(USER, SERVER));
}

describe('settings with a shared store', () => {
  it('loads on replica B what was saved through replica A', async () => {
    expect((await push({ theme: 'dark' })).status).toBe(200);

    onReplica('b');
    const res = await fetchSettings();
    expect(res.status).toBe(200);
    expect((await res.json()).settings).toEqual({ theme: 'dark' });
  });

  it('deletes them for every replica', async () => {
    await push({ theme: 'dark' });
    onReplica('b');
    const { DELETE } = await import('@/app/api/settings/route');
    const res = await DELETE(new NextRequest('https://webmail.example/api/settings', {
      method: 'DELETE',
      headers: { 'sec-fetch-site': 'same-origin', 'content-type': 'application/json' },
      body: JSON.stringify({ username: USER, serverUrl: SERVER }),
    }));
    expect(res.status).toBe(200);
    onReplica('a');
    expect((await (await fetchSettings()).json()).settings).toBeNull();
  });

  it('moves a stored document that does not decrypt aside in the store before a save, keeping its bytes', async () => {
    const garbage = Buffer.alloc(64, 7);
    const id = settingsId(USER, SERVER);
    await store.collection('settings', SETTINGS_COLLECTION).put(id, garbage);

    expect((await (await fetchSettings()).json()).settings).toBeNull();
    expect((await push({ theme: 'light' })).status).toBe(200);
    expect((await (await fetchSettings()).json()).settings).toEqual({ theme: 'light' });

    // In the store, not on this replica's disk.
    const aside = readdirSync(path.join(store.root, 'settings')).filter((f) => f.startsWith(`${id}.unreadable-`));
    expect(aside).toHaveLength(1);
    const asideId = aside[0].slice(0, -'.enc'.length);
    expect((await store.collection('settings', SETTINGS_COLLECTION).get(asideId))?.data.equals(garbage)).toBe(true);
  });

  it('answers 503 and writes nothing while the store is down', async () => {
    await push({ theme: 'dark' });
    const before = (await storedDoc())!.data;

    store.down = true;
    expect((await push({ theme: 'light' })).status).toBe(503);
    expect((await fetchSettings()).status).toBe(503);
    store.down = false;

    expect((await storedDoc())!.data.equals(before)).toBe(true);
  });
});

// Two saves at once, each from a tab that added a template the other
// doesn't know yet. The route used to load, merge and save without a lock,
// so the second save put its merge over the first: one template was lost,
// with two tabs on one instance as well as across replicas.
async function twoConcurrentSaves() {
  await push({ templates: [], deletedTemplateIds: {} });
  const [a, b] = await Promise.all([
    push({ templates: [template('from-a')], deletedTemplateIds: {} }),
    push({ templates: [template('from-b')], deletedTemplateIds: {} }),
  ]);
  expect([a.status, b.status]).toEqual([200, 200]);
  const saved = (await (await fetchSettings()).json()).settings as { templates: { id: string }[] };
  return saved.templates.map((t) => t.id).sort();
}

describe('two saves at once', () => {
  it('keep both templates with a shared store', async () => {
    expect(await twoConcurrentSaves()).toEqual(['from-a', 'from-b']);
  });

  it('keep both templates on a single instance', async () => {
    setStoreForTests(null);
    expect(await twoConcurrentSaves()).toEqual(['from-a', 'from-b']);
  });
});
