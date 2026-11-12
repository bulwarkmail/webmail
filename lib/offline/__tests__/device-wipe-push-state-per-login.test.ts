import 'fake-indexeddb/auto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FakeCaches } from '@/lib/__tests__/sw-harness';
import { loginFingerprint } from '@/lib/pwa-notify/login-fingerprint';

// A wipe of one login with another staying, and the service worker's store
// (`bulwark-push-state-v1`): what was the wiped login's goes, also when it's no longer
// in the account store, and the staying login keeps its own. Account ids repeat across
// servers, so the announced lists are kept per login (the user name a push carries), a
// reply typed on a notification and the tabs' login lists by the login's fingerprint.
// Setup as in device-wipe-push-state.test.ts: real auth store, real offline mode, real
// IndexedDB, the real wipe on a Cache API stand-in.

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
const SERVER = 'https://mail.example.test';
const ALICE = 'alice@mail.example.test';
const BOB = 'bob@mail.example.test';
const ROW = `${'a'.repeat(64)}/${'b'.repeat(32)}`;
const BOB_ROW = `${'d'.repeat(64)}/${'e'.repeat(32)}`;
const SECRET = 'c'.repeat(64);

let wipe: typeof import('../device-wipe');
let useAuthStore: typeof import('@/stores/auth-store').useAuthStore;
let useAccountStore: typeof import('@/stores/account-store').useAccountStore;
let state: typeof import('../state');
let keys: typeof import('@/lib/store/client/keys');
let cacheStore: FakeCaches;
let aliceLogin: string;
let bobLogin: string;

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

function entry(id: string, cookieSlot: number) {
  return {
    id, label: id, serverUrl: SERVER, username: id.split('@mail')[0], authMode: 'basic', rememberMe: true,
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

  useAccountStore.setState({ accounts: [entry(ALICE, 0), entry(BOB, 1)], activeAccountId: BOB, defaultAccountId: ALICE } as never);
  useAuthStore.setState({ isAuthenticated: true, activeAccountId: BOB, authMode: 'basic', serverUrl: SERVER, username: 'bob' });
  state.writeEnabled([ALICE]);
  await keys.openAccountKey(ALICE);
  await keys.putDeviceRecord({ account: ALICE, id: ROW, secret: SECRET, createdAt: 1 });
  await keys.putDeviceRecord({ account: BOB, id: BOB_ROW, secret: SECRET, createdAt: 1 });
  aliceLogin = await loginFingerprint(SERVER, 'alice');
  bobLogin = await loginFingerprint(SERVER, 'bob');
}, 60_000);

afterEach(async () => {
  await wipe?.wipesIdleForTests();
  vi.unstubAllGlobals();
}, 60_000);

async function put(path: string, value: unknown): Promise<void> {
  await (await cacheStore.open(PUSH_CACHE)).put(`${ORIGIN}/__push-state/${path}`, new Response(JSON.stringify(value)));
}

async function stored(path: string): Promise<unknown> {
  const response = await (await cacheStore.open(PUSH_CACHE)).match(`${ORIGIN}/__push-state/${path}`);
  return response ? response.json() : undefined;
}

const relays = {
  applicationServerKey: 'KEY',
  entries: { a: { relay: 'https://relay.example', subscriptionId: 'd1', accountLabel: 'alice' }, b: { relay: 'https://relay.example', subscriptionId: 'd2', accountLabel: 'bob' } },
};

describe("what of the wiped login goes from the worker's store", () => {
  it('a reply typed on one of its notifications', async () => {
    await put('pending-reply', { emailId: 'm1', text: 'Secret typed reply of Alice', login: aliceLogin, at: Date.now() });
    await wipe.wipeAccountFromDevice(ALICE, 'admin');
    expect(useAccountStore.getState().accounts.map((account) => account.id)).toEqual([BOB]);
    expect(await stored('pending-reply')).toBeUndefined();
  });

  it('a reply kept by an older worker, which names no login', async () => {
    await put('pending-reply', { emailId: 'm1', text: 'Secret typed reply of Alice', at: Date.now() });
    await put('relay-registrations', relays);
    await wipe.wipeAccountFromDevice(ALICE, 'admin');
    expect(await stored('pending-reply')).toBeUndefined();
  });

  it('its place in the tabs\' login lists', async () => {
    await put('client-logins', { 'tab-1': [aliceLogin, bobLogin], 'tab-2': [aliceLogin] });
    await wipe.wipeAccountFromDevice(ALICE, 'admin');
    expect(await stored('client-logins')).toEqual({ 'tab-1': [bobLogin], 'tab-2': [] });
  });

  it('when an alert last rang', async () => {
    await put('last-alert', { at: Date.now(), accountId: 'a' });
    await wipe.wipeAccountFromDevice(ALICE, 'admin');
    expect(await stored('last-alert')).toBeUndefined();
  });

  it('everything of a login that is no longer in the account store', async () => {
    // Alice was dropped by the app: her device row and her push entries are still here.
    useAccountStore.setState({ accounts: [entry(BOB, 1)], activeAccountId: BOB, defaultAccountId: BOB } as never);
    await put('quiet-logins', { alice: true, bob: true });
    await put('relay-registrations', relays);
    await put('notified/alice/a', { ids: ['m1'] });
    await put('notified/bob/b', { ids: ['m2'] });
    await put('pending-reply', { emailId: 'm1', text: 'Secret typed reply of Alice', login: aliceLogin, at: Date.now() });
    await wipe.wipeAccountFromDevice(ALICE, 'admin');
    expect(await stored('quiet-logins')).toEqual({ bob: true });
    expect(Object.keys((await stored('relay-registrations') as { entries: Record<string, unknown> }).entries)).toEqual(['b']);
    expect(await stored('notified/alice/a')).toBeUndefined();
    expect(await stored('notified/bob/b')).toEqual({ ids: ['m2'] });
    expect(await stored('pending-reply')).toBeUndefined();
  });

  it('the same through what its eviction kept, when its server address says more than its id', async () => {
    const server = 'https://mail.example.test:8443/jmap';
    useAccountStore.setState({ accounts: [entry(BOB, 1)], activeAccountId: BOB, defaultAccountId: BOB } as never);
    state.rememberEvictedOwner(ALICE, { username: 'alice', serverUrl: server });
    const evictedLogin = await loginFingerprint(server, 'alice');
    await put('client-logins', { 'tab-1': [evictedLogin, bobLogin] });
    await wipe.wipeAccountFromDevice(ALICE, 'admin');
    expect(await stored('client-logins')).toEqual({ 'tab-1': [bobLogin] });
  });
});

describe("what of the staying login stays in the worker's store", () => {
  it('its announced lists, also under the same account id as the wiped login\'s', async () => {
    await put('relay-registrations', { applicationServerKey: 'KEY', entries: { a: { relay: 'https://relay.example', subscriptionId: 'd1', accountLabel: 'alice' } } });
    await put('notified/alice/a', { ids: ['alice-m1'] });
    await put('notified/bob/a', { ids: ['bob-m1'] });
    // A list kept per account id alone, before lists were per login: it can't be told apart.
    await put('notified/a', { ids: ['bob-m0'] });
    await wipe.wipeAccountFromDevice(ALICE, 'admin');
    expect(await stored('notified/alice/a')).toBeUndefined();
    expect(await stored('notified/bob/a')).toEqual({ ids: ['bob-m1'] });
    expect(await stored('notified/a')).toEqual({ ids: ['bob-m0'] });
  });

  it('a reply typed on one of its notifications', async () => {
    await put('pending-reply', { emailId: 'm2', text: 'Reply of Bob', login: bobLogin, at: 1 });
    await wipe.wipeAccountFromDevice(ALICE, 'admin');
    expect(await stored('pending-reply')).toEqual({ emailId: 'm2', text: 'Reply of Bob', login: bobLogin, at: 1 });
  });
});
