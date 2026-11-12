import 'fake-indexeddb/auto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FakeCaches, loadWorker } from '@/lib/__tests__/sw-harness';

// A wipe of one login and the service worker's store (`bulwark-push-state-v1`). An
// admin's remote wipe is per device row, so per account: with two logins in the
// browser it removes one, and the other stays signed in with the app lock still on.
// The store keeps what the staying login's notifications go by: the app lock's state
// and its "Email notifications off / do not disturb" answer. Only the wiped login's
// entries go, and the whole store only when nobody stays. The page tells the worker
// the lock's state again afterwards.
//
// The page and the worker are the real ones and share one Cache API stand-in.
// Setup as in device-wipe.test.ts: real auth store, real offline mode, real IndexedDB.

vi.mock('@/lib/compose-flush-registry', () => ({ flushComposers: vi.fn(async () => ({ total: 0, settled: 0, failed: 0, timedOut: false })) }));
vi.mock('@/lib/store/client/purge', async () => {
  const keys = await vi.importActual<typeof import('@/lib/store/client/keys')>('@/lib/store/client/keys');
  return {
    purgeStoreFiles: async () => { keys.deleteKeyDatabase(); },
    deleteStorePool: async () => {},
  };
});

vi.setConfig({ testTimeout: 60_000 });

const ORIGIN = 'https://mail.example.com';
const PUSH_CACHE = 'bulwark-push-state-v1';
const ALICE = 'alice@mail.example.test';
const BOB = 'bob@mail.example.test';
const ROW = `${'a'.repeat(64)}/${'b'.repeat(32)}`;
const BOB_ROW = `${'d'.repeat(64)}/${'e'.repeat(32)}`;
const SECRET = 'c'.repeat(64);
const PREVIEW = { unreadTotal: 1, slot: 1, login: 'fp', email: { id: 'e1', threadId: 't1', subject: 'Secret subject for Bob', from: [{ name: 'Secret sender', email: 's@example.org' }] } };
const pushForBob = { kind: 'jmap-email-push', accountId: 'b', emailIds: ['e1'], accountLabel: 'bob' };

let wipe: typeof import('../device-wipe');
let useAuthStore: typeof import('@/stores/auth-store').useAuthStore;
let useAccountStore: typeof import('@/stores/account-store').useAccountStore;
let state: typeof import('../state');
let keys: typeof import('@/lib/store/client/keys');
let cacheStore: FakeCaches;

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

function entry(id: string, cookieSlot: number) {
  return {
    id, label: id, serverUrl: 'https://mail.example.test', username: id.split('@mail')[0], authMode: 'basic', rememberMe: true,
    displayName: id, email: id, lastLoginAt: 1, isConnected: true, hasError: false, isDefault: cookieSlot === 0, cookieSlot, avatarColor: '#000',
  };
}

async function freshIndexedDb(): Promise<void> {
  for (const { name } of await indexedDB.databases()) {
    if (name) await new Promise((resolve) => { const request = indexedDB.deleteDatabase(name); request.onsuccess = request.onerror = () => resolve(null); });
  }
}

beforeEach(async () => {
  vi.resetModules();
  localStorage.clear();
  sessionStorage.clear();
  await freshIndexedDb();
  cacheStore = new FakeCaches();
  vi.stubGlobal('caches', cacheStore);
  vi.stubGlobal('fetch', vi.fn(async (input: unknown) => {
    const url = String(input);
    if (url.endsWith('/api/devices/wiped')) return json(200, { ok: true });
    return json(200, { wipe: null });
  }));
  delete (window as { bulwarkDesktop?: unknown }).bulwarkDesktop;

  ({ useAuthStore } = await import('@/stores/auth-store'));
  ({ useAccountStore } = await import('@/stores/account-store'));
  state = await import('../state');
  keys = await import('@/lib/store/client/keys');
  wipe = await import('../device-wipe');
  wipe.setWipeReloadForTests(() => {});
  const browserNavigation = await import('@/lib/browser-navigation');
  vi.spyOn(browserNavigation, 'replaceWindowLocation').mockImplementation(() => {});
  const { InProcessStore } = await import('@/lib/store/__tests__/helpers/in-process-store');
  const { setStoreBackend } = await import('@/lib/store/client/api');
  setStoreBackend(new InProcessStore());

  // Two logins, the app lock on and open, offline mail for the one the admin will wipe.
  useAccountStore.setState({ accounts: [entry(ALICE, 0), entry(BOB, 1)], activeAccountId: BOB, defaultAccountId: ALICE } as never);
  useAuthStore.setState({ isAuthenticated: true, activeAccountId: BOB, authMode: 'basic', serverUrl: 'https://mail.example.test', username: 'bob' });
  state.writeEnabled([ALICE]);
  await keys.openAccountKey(ALICE);
  await keys.putDeviceRecord({ account: ALICE, id: ROW, secret: SECRET, createdAt: 1 });
  await keys.putDeviceRecord({ account: BOB, id: BOB_ROW, secret: SECRET, createdAt: 1 });
  const vault = await import('@/lib/app-lock/vault');
  (await vault.createVault('correct-pin')).fill(0);
  localStorage.setItem('bulwark-app-lock', JSON.stringify({ on: true, locked: false }));
}, 60_000);

afterEach(async () => {
  await wipe?.wipesIdleForTests();
  vi.unstubAllGlobals();
  delete (navigator as { serviceWorker?: unknown }).serviceWorker;
}, 60_000);

function worker(clients: Array<{ id: string }>) {
  const fetchMock = vi.fn(async () => new Response(JSON.stringify(PREVIEW), { status: 200 }));
  const loaded = loadWorker({ buildId: 'b', caches: cacheStore, clients, fetch: fetchMock });
  return { ...loaded, fetchMock };
}

/** What the page tells the service worker from here on. */
function pageMessages(): Array<Record<string, unknown>> {
  const posted: Array<Record<string, unknown>> = [];
  Object.defineProperty(navigator, 'serviceWorker', {
    configurable: true,
    value: { controller: { postMessage: (message: Record<string, unknown>) => posted.push(message) }, getRegistration: async () => undefined },
  });
  return posted;
}

async function stored(path: string): Promise<unknown> {
  const response = await (await cacheStore.open(PUSH_CACHE)).match(`${ORIGIN}/__push-state/${path}`);
  return response ? response.json() : undefined;
}

describe('an admin wipe of one login, with another staying under the app lock', () => {
  it('control: before the wipe a push for the staying login says nothing once the browser is closed', async () => {
    const clients = [{ id: 'app' }];
    const sw = worker(clients);
    await sw.dispatch('message', { source: clients[0], data: { type: 'app-lock', state: 'unlocked' } });
    clients.length = 0;
    await sw.dispatch('push', { data: { json: () => pushForBob } });
    expect(JSON.stringify(sw.shown)).not.toContain('Secret');
    expect(sw.fetchMock).not.toHaveBeenCalled();
  });

  it('still says nothing after the other login was wiped from the device', async () => {
    const clients = [{ id: 'app' }];
    const sw = worker(clients);
    await sw.dispatch('message', { source: clients[0], data: { type: 'app-lock', state: 'unlocked' } });

    await wipe.wipeAccountFromDevice(ALICE, 'admin');
    expect(useAccountStore.getState().accounts.map((account) => account.id)).toEqual([BOB]);
    // The lock is still on for Bob.
    expect(JSON.parse(localStorage.getItem('bulwark-app-lock') ?? '{}').on).toBe(true);

    // The browser is closed (nothing can say "locked" then), and mail comes for Bob.
    clients.length = 0;
    await sw.dispatch('push', { data: { json: () => pushForBob } });
    expect(JSON.stringify(sw.shown)).not.toContain('Secret');
    expect(sw.fetchMock).not.toHaveBeenCalled();
  });

  it("keeps the staying login's do not disturb", async () => {
    // What the page left for the worker while Bob had notifications off (lib/push-preferences.ts writeLoginQuiet).
    const cache = await cacheStore.open(PUSH_CACHE);
    await cache.put(`${ORIGIN}/__push-state/quiet-logins`, new Response(JSON.stringify({ bob: true })));
    // No app lock in this one: only the quiet answer decides.
    localStorage.removeItem('bulwark-app-lock');
    await (await import('@/lib/app-lock/vault')).deleteVault();

    await wipe.wipeAccountFromDevice(ALICE, 'admin');
    expect(useAccountStore.getState().accounts.map((account) => account.id)).toEqual([BOB]);

    const sw = worker([]);
    await sw.dispatch('push', { data: { json: () => pushForBob } });
    expect(JSON.stringify(sw.shown)).not.toContain('Secret');
  });
});

describe("what a wipe of one login takes from the worker's store", () => {
  it("takes the wiped login's entries and leaves the others'", async () => {
    const cache = await cacheStore.open(PUSH_CACHE);
    const put = (path: string, value: unknown) => cache.put(`${ORIGIN}/__push-state/${path}`, new Response(JSON.stringify(value)));
    await put('app-lock', { state: 'unlocked', clients: ['app'] });
    await put('prefs', { sound: false });
    await put('actions', { archiveEnabled: true });
    await put('quiet-logins', { alice: true, bob: true });
    await put('relay-registrations', {
      applicationServerKey: 'KEY',
      entries: { a: { relay: 'https://relay.example', subscriptionId: 'd1', accountLabel: 'alice' }, b: { relay: 'https://relay.example', subscriptionId: 'd2', accountLabel: 'bob' } },
    });
    await put('notified/a', { ids: ['m1'] });
    await put('notified/b', { ids: ['m2'] });

    await wipe.wipeAccountFromDevice(ALICE, 'admin');

    expect(await stored('quiet-logins')).toEqual({ bob: true });
    expect(await stored('relay-registrations')).toEqual({
      applicationServerKey: 'KEY',
      entries: { b: { relay: 'https://relay.example', subscriptionId: 'd2', accountLabel: 'bob' } },
    });
    expect(await stored('notified/a')).toBeUndefined();
    expect(await stored('notified/b')).toEqual({ ids: ['m2'] });
    expect(await stored('app-lock')).toEqual({ state: 'unlocked', clients: ['app'] });
    expect(await stored('prefs')).toEqual({ sound: false });
    expect(await stored('actions')).toEqual({ archiveEnabled: true });
  });

  it('takes the whole store with the last login', async () => {
    useAccountStore.setState({ accounts: [entry(ALICE, 0)], activeAccountId: ALICE, defaultAccountId: ALICE } as never);
    useAuthStore.setState({ activeAccountId: ALICE, username: 'alice' });
    const sw = worker([{ id: 'app' }]);
    await sw.dispatch('message', { data: { type: 'app-lock', state: 'unlocked' } });
    expect(await cacheStore.has(PUSH_CACHE)).toBe(true);

    await wipe.wipeAccountFromDevice(ALICE, 'admin');
    expect(useAccountStore.getState().accounts).toEqual([]);
    expect(await stored('app-lock')).toBeUndefined();
  });

  it('keeps the worker at "locked" for a wipe heard at the lock screen', async () => {
    localStorage.setItem('bulwark-app-lock', JSON.stringify({ on: true, locked: true }));
    const clients = [{ id: 'app' }];
    const sw = worker(clients);
    await sw.dispatch('message', { source: clients[0], data: { type: 'app-lock', state: 'locked' } });

    await wipe.wipeAccountFromDevice(ALICE, 'admin');
    expect(useAccountStore.getState().accounts.map((account) => account.id)).toEqual([BOB]);

    // The lock screen is still up in the app's tab.
    await sw.dispatch('push', { data: { json: () => pushForBob } });
    expect(JSON.stringify(sw.shown)).not.toContain('Secret');
    expect(sw.fetchMock).not.toHaveBeenCalled();
  });
});

describe('what the page tells the worker after a wipe', () => {
  const lockStates = (posted: Array<Record<string, unknown>>) => posted.filter((message) => message.type === 'app-lock').map((message) => message.state);

  it('"unlocked" from a page in use, with the other login staying', async () => {
    const posted = pageMessages();
    await wipe.wipeAccountFromDevice(ALICE, 'admin');
    expect(lockStates(posted)).toEqual(['unlocked']);
  });

  it('"locked" from a page at the lock screen', async () => {
    localStorage.setItem('bulwark-app-lock', JSON.stringify({ on: true, locked: true }));
    const posted = pageMessages();
    await wipe.wipeAccountFromDevice(ALICE, 'admin');
    expect(lockStates(posted)).toEqual(['locked']);
  });

  it('"off" once the whole device is wiped and the lock with it', async () => {
    const posted = pageMessages();
    await wipe.wipeWholeDevice('admin');
    expect(lockStates(posted)).toEqual(['off']);
  });
});
