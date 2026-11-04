import 'fake-indexeddb/auto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// What a wipe removes and what makes one happen. Real auth store, real offline
// mode, the store's real engine, real IndexedDB (fake-indexeddb): only the
// network is a stub, and the OPFS pool, which jsdom doesn't have.

vi.mock('@/lib/compose-flush-registry', () => ({ flushComposers: vi.fn(async () => ({ total: 0, settled: 0, failed: 0, timedOut: false })) }));
const purge = vi.hoisted(() => ({ files: 0, fail: false, during: null as null | (() => void) }));
vi.mock('@/lib/store/client/purge', async () => {
  const keys = await vi.importActual<typeof import('@/lib/store/client/keys')>('@/lib/store/client/keys');
  return {
    purgeStoreFiles: async () => {
      purge.during?.();
      if (purge.fail) throw new Error('The files are held');
      purge.files += 1;
      keys.deleteKeyDatabase();
    },
    deleteStorePool: async () => {},
  };
});

// A store and a full sign-out in each test: slow on a machine doing other work.
vi.setConfig({ testTimeout: 60_000 });

const ALICE = 'alice@mail.example.test';
const BOB = 'bob@mail.example.test';
const ROW = `${'a'.repeat(64)}/${'b'.repeat(32)}`;
const SECRET = 'c'.repeat(64);
const BOB_ROW = `${'d'.repeat(64)}/${'e'.repeat(32)}`;

let wipe: typeof import('../device-wipe');
let useAuthStore: typeof import('@/stores/auth-store').useAuthStore;
let useAccountStore: typeof import('@/stores/account-store').useAccountStore;
let state: typeof import('../state');
let keys: typeof import('@/lib/store/client/keys');
let wipeState: typeof import('@/lib/devices/wipe-state');
let rejected: typeof import('../credentials-rejected');
let registry: typeof import('../wipe-registry');
let queue: typeof import('../queue');
let store: import('@/lib/store/__tests__/helpers/in-process-store').InProcessStore;

type Respond = (url: string, init?: RequestInit) => Response | Promise<Response>;
let respond: Respond;
let sent: Array<{ url: string; body: Record<string, unknown>; headers: Record<string, string> }>;

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
const noWipe = () => json(200, { wipe: null });
/** What the route gives a new row. */
const newRow = (id = ROW) => json(200, { id, secret: SECRET, user: 'alice', server: 'https://mail.example.test' });
const wipeNow = () => json(200, { wipe: { requestedAt: '2026-11-03T00:00:00.000Z' } });

function entry(id: string, cookieSlot: number) {
  return {
    id, label: id, serverUrl: 'https://mail.example.test', username: id.split('@mail')[0], authMode: 'basic', rememberMe: true,
    displayName: id, email: id, lastLoginAt: 1, isConnected: true, hasError: false, isDefault: cookieSlot === 0, cookieSlot, avatarColor: '#000',
  };
}

function openDb(name: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(name, 1);
    request.onupgradeneeded = () => { request.result.createObjectStore('s'); };
    request.onsuccess = () => { request.result.close(); resolve(); };
    request.onerror = () => reject(request.error);
  });
}

async function databases(): Promise<string[]> {
  return (await indexedDB.databases()).map((database) => database.name ?? '').sort();
}

async function freshIndexedDb(): Promise<void> {
  for (const { name } of await indexedDB.databases()) {
    if (name) await new Promise((resolve) => { const request = indexedDB.deleteDatabase(name); request.onsuccess = request.onerror = () => resolve(null); });
  }
}

beforeEach(async () => {
  vi.resetModules();
  purge.files = 0;
  purge.fail = false;
  purge.during = null;
  localStorage.clear();
  sessionStorage.clear();
  await freshIndexedDb();
  sent = [];
  respond = () => noWipe();
  vi.stubGlobal('fetch', vi.fn(async (input: unknown, init?: RequestInit) => {
    const url = String(input);
    if (url.includes('/api/devices')) sent.push({ url, body: init?.body ? JSON.parse(String(init.body)) : {}, headers: (init?.headers ?? {}) as Record<string, string> });
    return respond(url, init);
  }));
  delete (window as { bulwarkDesktop?: unknown }).bulwarkDesktop;

  ({ useAuthStore } = await import('@/stores/auth-store'));
  ({ useAccountStore } = await import('@/stores/account-store'));
  state = await import('../state');
  keys = await import('@/lib/store/client/keys');
  wipeState = await import('@/lib/devices/wipe-state');
  rejected = await import('../credentials-rejected');
  registry = await import('../wipe-registry');
  queue = await import('../queue');
  wipe = await import('../device-wipe');
  const browserNavigation = await import('@/lib/browser-navigation');
  vi.spyOn(browserNavigation, 'replaceWindowLocation').mockImplementation(() => {});
  const { InProcessStore } = await import('@/lib/store/__tests__/helpers/in-process-store');
  const { setStoreBackend } = await import('@/lib/store/client/api');
  store = new InProcessStore();
  setStoreBackend(store);

  useAccountStore.setState({ accounts: [entry(ALICE, 0)], activeAccountId: ALICE, defaultAccountId: ALICE } as never);
  useAuthStore.setState({ isAuthenticated: true, activeAccountId: ALICE, authMode: 'basic', serverUrl: 'https://mail.example.test', username: 'alice' });
  state.writeEnabled([ALICE]);
  await keys.openAccountKey(ALICE);
  await keys.putDeviceRecord({ account: ALICE, id: ROW, secret: SECRET, createdAt: 1 });
}, 60_000);

// A wipe that goes on behind a start's budget must not finish in the next test: it would find
// that test's shell, fetch stub, storage and windows, and restart, report or reload there.
afterEach(async () => {
  await wipe?.wipesIdleForTests();
}, 60_000);

/** The wipe goes on behind the start's budget, and takes its time under load. */
async function waitForNoAccounts(): Promise<void> {
  await vi.waitFor(() => expect(useAccountStore.getState().accounts).toEqual([]), { timeout: 20_000 });
}

function expectUntouched(): void {
  expect(purge.files).toBe(0);
  expect(store.removed).toEqual([]);
  expect(state.useOfflineStore.getState().enabled).toEqual([ALICE]);
  expect(useAccountStore.getState().accounts.map((account) => account.id)).toEqual([ALICE]);
  expect(wipeState.readPendingWipes()).toEqual({});
}

describe('with the app lock', () => {
  const vaultDb = 'bulwark-app-lock';

  async function vaultOf(): Promise<typeof import('@/lib/app-lock/vault')> {
    return import('@/lib/app-lock/vault');
  }

  it('a wipe of one account leaves the others their way in', async () => {
    const vault = await vaultOf();
    (await vault.createVault('correct-pin')).fill(0);
    useAccountStore.setState({ accounts: [entry(ALICE, 0), entry(BOB, 1)], activeAccountId: ALICE, defaultAccountId: ALICE } as never);
    respond = () => noWipe();
    await keys.putDeviceRecord({ account: BOB, id: BOB_ROW, secret: SECRET, createdAt: 1 });
    await wipe.wipeAccountFromDevice(BOB, 'admin');
    expect(await databases()).toContain(vaultDb);
    expect(await vault.readVault()).not.toBeNull();
  });

  it('what was sealed goes with it: a device told to remove an account keeps none of its text', async () => {
    const vault = await vaultOf();
    (await vault.createVault('correct-pin')).fill(0);
    await vault.sealDraft({ subject: 'Text of a wiped account' });
    useAccountStore.setState({ accounts: [entry(ALICE, 0), entry(BOB, 1)], activeAccountId: ALICE, defaultAccountId: ALICE } as never);
    respond = () => noWipe();
    await keys.putDeviceRecord({ account: BOB, id: BOB_ROW, secret: SECRET, createdAt: 1 });
    await wipe.wipeAccountFromDevice(BOB, 'admin');
    expect(await vault.countSealed()).toBe(0);
  });

  it('with no account left, the vault and the lock go too', async () => {
    const vault = await vaultOf();
    (await vault.createVault('correct-pin')).fill(0);
    localStorage.setItem('bulwark-app-lock', JSON.stringify({ on: true, locked: true }));
    useAccountStore.setState({ accounts: [entry(ALICE, 0)], activeAccountId: ALICE, defaultAccountId: ALICE } as never);
    respond = () => noWipe();
    await keys.putDeviceRecord({ account: ALICE, id: ROW, secret: SECRET, createdAt: 1 });
    await wipe.wipeAccountFromDevice(ALICE, 'admin');
    await vi.waitFor(async () => expect(await databases()).not.toContain(vaultDb));
    expect(localStorage.getItem('bulwark-app-lock')).toBeNull();
  });

  it('also when the last account isn\'t the active one, as at a lock screen where nothing has started', async () => {
    const vault = await vaultOf();
    (await vault.createVault('correct-pin')).fill(0);
    localStorage.setItem('bulwark-app-lock', JSON.stringify({ on: true, locked: true }));
    wipe.setWipeReloadForTests(() => {});
    useAccountStore.setState({ accounts: [entry(BOB, 1)], activeAccountId: null, defaultAccountId: null } as never);
    useAuthStore.setState({ activeAccountId: null });
    respond = () => noWipe();
    await keys.putDeviceRecord({ account: BOB, id: BOB_ROW, secret: SECRET, createdAt: 1 });
    await wipe.wipeAccountFromDevice(BOB, 'admin');
    wipe.setWipeReloadForTests(null);
    await vi.waitFor(async () => expect(await databases()).not.toContain(vaultDb));
    expect(localStorage.getItem('bulwark-app-lock')).toBeNull();
  });

  it('a wipe of the whole device takes them as well', async () => {
    const vault = await vaultOf();
    (await vault.createVault('correct-pin')).fill(0);
    localStorage.setItem('bulwark-app-lock', JSON.stringify({ on: true, locked: true }));
    respond = () => noWipe();
    await wipe.wipeWholeDevice('user');
    await vi.waitFor(async () => expect(await databases()).not.toContain(vaultDb));
    expect(localStorage.getItem('bulwark-app-lock')).toBeNull();
  });

  it('a device at the lock screen hears a wipe: the check-in runs with no key and no session', async () => {
    const vault = await vaultOf();
    let reloads = 0;
    wipe.setWipeReloadForTests(() => { reloads += 1; });
    (await vault.createVault('correct-pin')).fill(0);
    localStorage.setItem('bulwark-app-lock', JSON.stringify({ on: true, locked: true }));
    useAccountStore.setState({ accounts: [entry(ALICE, 0), entry(BOB, 1)], activeAccountId: ALICE, defaultAccountId: ALICE } as never);
    await keys.putDeviceRecord({ account: BOB, id: BOB_ROW, secret: SECRET, createdAt: 1 });
    respond = (url, init) => (url.includes('/api/devices') && JSON.parse(String(init?.body ?? '{}')).id === BOB_ROW ? wipeNow() : noWipe());
    await wipe.checkInDue(true);
    await vi.waitFor(async () => expect(await keys.getDeviceRecord(BOB)).toBeNull());
    expect(await vault.readVault(), 'Alice still has to get in').not.toBeNull();
    await vi.waitFor(() => expect(reloads, 'nothing started for Alice stays in memory').toBe(1));
    wipe.setWipeReloadForTests(null);
  });
});

describe('wipe on the next connect', () => {
  beforeEach(() => {
    respond = (url) => (url.endsWith('/api/devices/wiped') ? json(200, { ok: true }) : wipeNow());
  });

  it('removes the store and every key, signs out, and tells the instance', async () => {
    await queue.queueSend(ALICE, { subject: 'Secret plans', to: [] }, { kind: 'email', args: [] });
    await wipe.runDeviceGate();
    await waitForNoAccounts();

    expect(purge.files).toBeGreaterThan(0);
    expect(state.useOfflineStore.getState().enabled).toEqual([]);
    expect(await databases()).not.toContain('bulwark-store');
    expect(useAuthStore.getState().isAuthenticated).toBe(false);

    const report = sent.find((call) => call.url.endsWith('/api/devices/wiped'));
    expect(report?.body).toMatchObject({ id: ROW, secret: SECRET, reason: 'admin', unsent: 1 });
    expect(wipeState.readWipeConfirmations()).toEqual([]);
    expect(wipeState.readPendingWipes()).toEqual({});
  });

  it('notes the count for the next sign-in, and no subject anywhere', async () => {
    await queue.queueSend(ALICE, { subject: 'Secret plans', to: [] }, { kind: 'email', args: [] });
    await wipe.runDeviceGate();
    await waitForNoAccounts();
    expect(JSON.stringify({ ...localStorage })).not.toContain('Secret plans');
    expect(JSON.stringify({ ...sessionStorage })).not.toContain('Secret plans');
    expect(wipeState.consumeWipeNote()).toEqual({ unsent: 1 });
    expect(wipeState.consumeWipeNote()).toBeNull();
  });

  it('leaves a note with no count when nothing was waiting', async () => {
    await wipe.runDeviceGate();
    await waitForNoAccounts();
    expect(wipeState.consumeWipeNote()).toEqual({ unsent: 0 });
  });

  it('deletes S/MIME and OpenPGP keys by name, plugin data and handoffs, keeping the plugins themselves', async () => {
    for (const name of ['smime-plugin-store', 'bulwark-openpgp', 'made-by-some-plugin']) await openDb(name);
    const { fileStorage } = await import('@/lib/plugin-storage');
    const clearFiles = vi.spyOn(fileStorage, 'clearFiles').mockResolvedValue();
    const { pluginStoragePrefix } = await import('@/lib/plugin-sandbox/storage-scope');
    localStorage.setItem(`${pluginStoragePrefix('notes', ALICE)}note`, 'mine');
    localStorage.setItem('notification-center', '[{"title":"From Eve"}]');
    const { usePluginStore } = await import('@/stores/plugin-store');
    usePluginStore.setState({ plugins: [{ id: 'managed', managed: true, settings: { apiKey: 'k' } }] as never });
    const handoffs = await import('@/lib/launch-handoff');
    const clearHandoffs = vi.spyOn(handoffs, 'clearHandoffs');

    await wipe.runDeviceGate();
    await waitForNoAccounts();

    const left = await databases();
    for (const name of ['smime-plugin-store', 'bulwark-openpgp', 'made-by-some-plugin']) expect(left).not.toContain(name);
    expect(localStorage.getItem(`${pluginStoragePrefix('notes', ALICE)}note`)).toBeNull();
    expect(localStorage.getItem('notification-center') ?? '[]').toBe('[]');
    expect(usePluginStore.getState().plugins[0].settings).toEqual({});
    expect(clearFiles).toHaveBeenCalled();
    expect(clearHandoffs).toHaveBeenCalled();
  });

  it('runs what features registered, edit-in-place\'s files for one, with the account', async () => {
    const cleaned: Array<string | null> = [];
    registry.onDeviceWipe(async (account) => { cleaned.push(account); });
    await wipe.runDeviceGate();
    await waitForNoAccounts();
    expect(cleaned).toEqual([ALICE]);
  });

  it('a feature that fails or hangs doesn\'t stop the wipe', async () => {
    registry.onDeviceWipe(() => { throw new Error('no'); });
    await wipe.runDeviceGate();
    await waitForNoAccounts();
    expect(purge.files).toBeGreaterThan(0);
  });

  it('only takes the account it was told, and keeps the other\'s store and row', async () => {
    useAccountStore.setState({ accounts: [entry(ALICE, 0), entry(BOB, 1)] } as never);
    state.writeEnabled([ALICE, BOB]);
    await keys.openAccountKey(BOB);
    await keys.putDeviceRecord({ account: BOB, id: BOB_ROW, secret: SECRET, createdAt: 1 });
    respond = (url, init) => {
      if (url.endsWith('/api/devices/wiped')) return json(200, { ok: true });
      return JSON.parse(String(init?.body)).id === ROW ? wipeNow() : noWipe();
    };

    await wipe.runDeviceGate();
    await vi.waitFor(() => expect(useAccountStore.getState().accounts.map((account) => account.id)).toEqual([BOB]));

    expect(state.useOfflineStore.getState().enabled).toEqual([BOB]);
    expect(store.removed).toContain(ALICE);
    expect(store.removed).not.toContain(BOB);
    expect(await keys.getDeviceRecord(ALICE)).toBeNull();
    expect((await keys.getDeviceRecord(BOB))?.id).toBe(BOB_ROW);
  });

  it('after the last of several accounts goes, the rest keep their row', async () => {
    useAccountStore.setState({ accounts: [entry(ALICE, 0), entry(BOB, 1)] } as never);
    // Bob keeps nothing here but has a row: the desktop app, say.
    await keys.putDeviceRecord({ account: BOB, id: BOB_ROW, secret: SECRET, createdAt: 1 });
    respond = (url, init) => {
      if (url.endsWith('/api/devices/wiped')) return json(200, { ok: true });
      return JSON.parse(String(init?.body)).id === ROW ? wipeNow() : noWipe();
    };
    await wipe.runDeviceGate();
    await vi.waitFor(() => expect(useAccountStore.getState().accounts.map((account) => account.id)).toEqual([BOB]));
    expect((await keys.getDeviceRecord(BOB))?.id).toBe(BOB_ROW);
  });

  it('reaches an account dropped earlier, whose data waits and which has no cookies', async () => {
    useAccountStore.setState({ accounts: [] } as never);
    useAuthStore.setState({ isAuthenticated: false, activeAccountId: null });
    state.markEvicted(ALICE);
    await wipe.runDeviceGate();
    await vi.waitFor(() => expect(state.useOfflineStore.getState().enabled).toEqual([]));
    expect(purge.files).toBeGreaterThan(0);
    expect(state.isEvicted(ALICE)).toBe(false);
  });
});

describe('the report', () => {
  it('goes out again at the next contact when it failed, with no account and no cookies', async () => {
    let reportWorks = false;
    respond = (url) => {
      if (url.endsWith('/api/devices/wiped')) return reportWorks ? json(200, { ok: true }) : json(503, {});
      return wipeNow();
    };
    await wipe.runDeviceGate();
    await waitForNoAccounts();
    expect(wipeState.readWipeConfirmations().map((entry) => entry.id)).toEqual([ROW]);

    // A new page load, the sign-in page: everything else about the account is gone.
    reportWorks = true;
    await wipe.checkInDue(true);
    await vi.waitFor(() => expect(wipeState.readWipeConfirmations()).toEqual([]));
    const reports = sent.filter((call) => call.url.endsWith('/api/devices/wiped'));
    expect(reports.length).toBeGreaterThanOrEqual(2);
    expect(reports.at(-1)?.body).toMatchObject({ id: ROW, secret: SECRET });
  });
});

describe('what never wipes', () => {
  it.each([
    ['a 500', () => json(500, { error: 'Internal server error' })],
    ['a 503 page', () => new Response('<html>Bad gateway</html>', { status: 503 })],
    ['an older instance with no such route', () => new Response('<html>Not found</html>', { status: 404 })],
    ['a 401', () => json(401, { error: 'Not authenticated' })],
    ['a 200 that says nothing', () => json(200, {})],
  ])('%s', async (_name, answer) => {
    respond = answer;
    await wipe.runDeviceGate();
    await new Promise((resolve) => setTimeout(resolve, 20));
    expectUntouched();
  });

  it('no network, and the row keeps waiting at the instance: nothing was reported', async () => {
    respond = () => { throw new TypeError('Failed to fetch'); };
    await wipe.runDeviceGate();
    await new Promise((resolve) => setTimeout(resolve, 20));
    expectUntouched();
    expect(sent.filter((call) => call.url.endsWith('/api/devices/wiped'))).toEqual([]);
  });

  it('a browser that says it\'s offline doesn\'t even ask', async () => {
    vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(false);
    await wipe.runDeviceGate();
    vi.restoreAllMocks();
    expect(sent).toEqual([]);
    expectUntouched();
  });

  it('a forgotten row: this device registers anew and keeps its data', async () => {
    respond = (_url, init) => {
      const { id } = JSON.parse(String(init?.body)) as { id?: string };
      return id ? json(404, { error: 'unknown_device' }) : newRow(BOB_ROW);
    };
    await wipe.runDeviceGate();
    expectUntouched();
    expect(await keys.getDeviceRecord(ALICE)).toBeNull();
    await wipe.checkInDue(true);
    await vi.waitFor(async () => expect((await keys.getDeviceRecord(ALICE))?.id).toBe(BOB_ROW));
  });
});

describe('a start', () => {
  it('waits for the answer, at most for its budget, and a late yes still wipes', async () => {
    let release: (response: Response) => void = () => {};
    respond = (url) => {
      if (url.endsWith('/api/devices/wiped')) return json(200, { ok: true });
      return new Promise<Response>((resolve) => { release = resolve; });
    };
    const started = Date.now();
    await wipe.runDeviceGate();
    const waited = Date.now() - started;
    expect(waited).toBeGreaterThanOrEqual(wipe.BOOT_CHECK_IN_BUDGET_MS - 50);
    expect(waited).toBeLessThan(wipe.BOOT_CHECK_IN_BUDGET_MS + 1500);
    expectUntouched();

    // The rest of the wipe's requests (the sign-out's) are answered.
    respond = (url) => (url.endsWith('/api/devices/wiped') ? json(200, { ok: true }) : noWipe());
    release(wipeNow());
    await waitForNoAccounts();
    expect(purge.files).toBeGreaterThan(0);
  });

  it('finishes a wipe a closed window cut short, with no network and before anything else', async () => {
    wipeState.markWipePending(ALICE, 'admin');
    respond = () => { throw new TypeError('Failed to fetch'); };
    await wipe.runDeviceGate();
    expect(purge.files).toBeGreaterThan(0);
    expect(useAccountStore.getState().accounts).toEqual([]);
    expect(wipeState.readPendingWipes()).toEqual({});
  });
});

describe('registering', () => {
  beforeEach(async () => {
    await keys.deleteDeviceRecord(ALICE);
  });

  it('a browser with offline on registers, once, naming its cookie slot', async () => {
    respond = () => newRow();
    await Promise.all([wipe.checkInDue(true), wipe.checkInDue(true)]);
    expect(sent).toHaveLength(1);
    expect(sent[0].headers['X-JMAP-Cookie-Slot']).toBe('0');
    expect(await keys.getDeviceRecord(ALICE)).toMatchObject({ id: ROW, secret: SECRET });
  });

  it('a browser with offline off doesn\'t', async () => {
    state.writeEnabled([]);
    await wipe.checkInDue(true);
    expect(sent).toEqual([]);
    expect(await databases()).toContain('bulwark-store'); // From this test's own setup.
  });

  it('a desktop app on an instance does, with offline off too', async () => {
    state.writeEnabled([]);
    (window as { bulwarkDesktop?: unknown }).bulwarkDesktop = { version: 1, platform: 'win32', mode: 'instance' };
    respond = () => newRow();
    await wipe.checkInDue(true);
    expect(sent).toHaveLength(1);
  });

  it('the desktop app on its own has no instance to ask', async () => {
    (window as { bulwarkDesktop?: unknown }).bulwarkDesktop = { version: 1, platform: 'win32', mode: 'standalone' };
    await wipe.checkInDue(true);
    expect(sent).toEqual([]);
  });

  it('a cleared key database means a new row', async () => {
    respond = () => newRow();
    await wipe.checkInDue(true);
    keys.deleteKeyDatabase();
    respond = () => newRow(BOB_ROW);
    await wipe.checkInDue(true);
    expect((await keys.getDeviceRecord(ALICE))?.id).toBe(BOB_ROW);
  });

  it('a device id doesn\'t survive a wipe: the next sign-in is a new row', async () => {
    await keys.putDeviceRecord({ account: ALICE, id: ROW, secret: SECRET, createdAt: 1 });
    respond = (url) => (url.endsWith('/wiped') ? json(200, { ok: true }) : wipeNow());
    await wipe.runDeviceGate();
    await waitForNoAccounts();
    expect(await keys.listDeviceRecords()).toEqual([]);
  });

  it.each([
    ['someone else\'s row', { user: 'mallory', server: 'https://mail.example.test' }],
    ['another server\'s row', { user: 'alice', server: 'https://other.example.test' }],
  ])('drops %s: no record here, and the row goes back', async (_name, owner) => {
    respond = (url) => (url.endsWith('/wiped') ? json(200, { ok: true }) : json(200, { id: BOB_ROW, secret: SECRET, ...owner }));
    await wipe.checkInDue(true);
    expect(await keys.getDeviceRecord(ALICE)).toBeNull();
    await vi.waitFor(() => expect(sent.find((call) => call.url.endsWith('/wiped'))?.body).toMatchObject({ id: BOB_ROW, secret: SECRET, drop: true }));
  });

  it.each([
    ['the same name in other case', { user: 'ALICE', server: 'https://mail.example.test/' }],
    ['the whole address for a bare name', { user: 'alice@mail.example.test', server: 'https://mail.example.test' }],
  ])('takes %s as the same owner', async (_name, owner) => {
    respond = () => json(200, { id: ROW, secret: SECRET, ...owner });
    await wipe.checkInDue(true);
    expect((await keys.getDeviceRecord(ALICE))?.id).toBe(ROW);
  });

  it('a row that was wiped already: the record goes, nothing else does, and it registers anew', async () => {
    await keys.putDeviceRecord({ account: ALICE, id: ROW, secret: SECRET, createdAt: 1 });
    respond = (_url, init) => (JSON.parse(String(init?.body)).id ? json(200, { wipe: null, wiped: true }) : newRow(BOB_ROW));
    await wipe.checkInDue(true);
    expect(await keys.getDeviceRecord(ALICE)).toBeNull();
    expectUntouched();
    await wipe.checkInDue(true);
    expect((await keys.getDeviceRecord(ALICE))?.id).toBe(BOB_ROW);
    expect(wipeState.consumeWipeNote()).toBeNull();
  });

  it('isn\'t tried again every minute when it can\'t', async () => {
    respond = () => json(401, {});
    const now = Date.now();
    await wipe.checkInDue(false, now);
    await wipe.checkInDue(false, now + 60_000);
    expect(sent).toHaveLength(1);
    await wipe.checkInDue(false, now + 16 * 60_000);
    expect(sent).toHaveLength(2);
  });
});

describe('check-ins while running', () => {
  it('come at most once an hour for a row', async () => {
    const now = Date.now();
    await wipe.checkInDue(false, now);
    await wipe.checkInDue(false, now + 60_000);
    expect(sent).toHaveLength(1);
    await wipe.checkInDue(false, now + 61 * 60_000);
    expect(sent).toHaveLength(2);
  });
});

/** What the auth store does around the hook. */
function refuse(account = ALICE, certain = true): void {
  wipeState.markLoginRefused(account, { certain });
  rejected.noteCredentialsRejected(account, certain);
  useAccountStore.getState().removeAccount(account, 'evicted');
}

async function policyAsksForDeletion(): Promise<void> {
  const { usePolicyStore } = await import('@/stores/policy-store');
  const policy = { organisation: { devices: { wipeOnForcedSignOut: true } } };
  usePolicyStore.setState({ policy, rawPolicy: policy, subject: null, loaded: true, source: 'server', partial: false, resolveFor: () => policy } as never);
}

const DAY = 24 * 60 * 60 * 1000;

describe('a refused login (lib/offline/credentials-rejected.ts)', () => {
  it('hides the data and deletes nothing: everyone\'s keys, plugin settings and the store stay', async () => {
    await openDb('smime-plugin-store');
    await openDb('bulwark-openpgp');
    const { usePluginStore } = await import('@/stores/plugin-store');
    usePluginStore.setState({ plugins: [{ id: 'managed', settings: { apiKey: 'k' } }] as never });
    wipe.registerDeviceWipe();
    refuse();
    await vi.waitFor(() => expect(wipeState.readRefusedLogins()[ALICE]?.unsent).toBe(0));

    expect(state.isEvicted(ALICE)).toBe(true);
    expect(state.visibleAccounts()).toEqual([]);
    expect(purge.files).toBe(0);
    expect(store.removed).toEqual([]);
    expect(await databases()).toEqual(expect.arrayContaining(['smime-plugin-store', 'bulwark-openpgp']));
    expect(usePluginStore.getState().plugins[0].settings).toEqual({ apiKey: 'k' });
    expect(sent.filter((call) => call.url.endsWith('/wiped'))).toEqual([]);
    expect(wipeState.readPendingWipes()).toEqual({});
  });

  it('two weeks later a sign-in with the new password finds everything, unsent mail included', async () => {
    await queue.queueSend(ALICE, { subject: 'Unsent', to: [] }, { kind: 'email', args: [] });
    wipe.registerDeviceWipe();
    const at = Date.now();
    refuse();
    await vi.waitFor(() => expect(wipeState.readRefusedLogins()[ALICE]?.unsent).toBe(1));

    const offline = await import('../offline-mode');
    const later = at + 14 * DAY;
    await offline.sweepAccountsGone(later);
    await wipe.sweepRefusedLogins();
    expect(purge.files).toBe(0);
    expect(store.removed).toEqual([]);

    // What the sign-in page says, in numbers only.
    const [wait] = wipeState.refusedWaits();
    expect(wait).toEqual({ unsent: 1, until: expect.any(Number), kind: 'refused' });
    expect(wait.until).toBeGreaterThanOrEqual(at + state.EVICTED_KEEP_MS);
    expect(wait.until).toBeLessThanOrEqual(at + state.EVICTED_KEEP_MS + 60_000);
    expect(JSON.stringify({ ...localStorage })).not.toContain('"Unsent"');

    useAccountStore.getState().addAccount(entry(ALICE, 0) as never);
    expect(state.isEvicted(ALICE)).toBe(false);
    expect(state.visibleAccounts()).toEqual([ALICE]);
    expect((await queue.readQueue(ALICE)).outbox.map((row) => row.summary.subject)).toEqual(['Unsent']);
    // Signed in: the page says nothing from here on, even before the next look.
    expect(wipeState.refusedWaits()).toEqual([]);

    await wipe.sweepRefusedLogins();
    expect(wipeState.readRefusedLogins()).toEqual({});
    expect(wipeState.refusedWaits()).toEqual([]);
  });

  it('with no sign-in for 30 days it goes, and names nothing to whoever is here', async () => {
    await queue.queueSend(ALICE, { subject: 'Unsent', to: [] }, { kind: 'email', args: [] });
    wipe.registerDeviceWipe();
    const at = Date.now();
    refuse();
    await vi.waitFor(() => expect(wipeState.readRefusedLogins()[ALICE]?.unsent).toBe(1));
    const offline = await import('../offline-mode');
    await offline.sweepAccountsGone(at + 29 * DAY);
    expect(purge.files).toBe(0);
    await offline.sweepAccountsGone(at + 31 * DAY);
    expect(purge.files).toBeGreaterThan(0);
    await wipe.sweepRefusedLogins();
    expect(wipeState.refusedWaits()).toEqual([]);
    const lost = await import('../lost');
    expect(lost.consumeLost()).toEqual([]);
  });

  it('a count it can\'t get is unknown, not none, and is tried again at the next look', async () => {
    await queue.queueSend(ALICE, { subject: 'Unsent', to: [] }, { kind: 'email', args: [] });
    store.failArea = () => true;
    wipe.registerDeviceWipe();
    refuse();
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(wipeState.refusedWaits()[0].unsent).toBeNull();
    store.failArea = null;
    await wipe.sweepRefusedLogins();
    expect(wipeState.refusedWaits()[0].unsent).toBe(1);
  });

  it('keeps no wait for an account with nothing kept here', async () => {
    state.writeEnabled([]);
    wipe.registerDeviceWipe();
    useAccountStore.getState().removeAccount(ALICE, 'evicted');
    rejected.noteCredentialsRejected(ALICE, true);
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(wipeState.refusedWaits()).toEqual([]);
    expect(purge.files).toBe(0);
  });

  describe('with the organisation asking for deletion at once', () => {
    beforeEach(async () => {
      await policyAsksForDeletion();
      respond = (url) => (url.endsWith('/wiped') ? json(200, { ok: true }) : noWipe());
    });

    it('takes that account\'s data and nothing shared, and tells the instance why', async () => {
      useAccountStore.setState({ accounts: [entry(ALICE, 0), entry(BOB, 1)] } as never);
      state.writeEnabled([ALICE, BOB]);
      await keys.openAccountKey(BOB);
      await keys.putDeviceRecord({ account: BOB, id: BOB_ROW, secret: SECRET, createdAt: 1 });
      await openDb('smime-plugin-store');
      await openDb('bulwark-openpgp');
      const { fileStorage } = await import('@/lib/plugin-storage');
      const clearFiles = vi.spyOn(fileStorage, 'clearFiles').mockResolvedValue();
      const handoffs = await import('@/lib/launch-handoff');
      const clearHandoffs = vi.spyOn(handoffs, 'clearHandoffs');
      const { pluginStoragePrefix } = await import('@/lib/plugin-sandbox/storage-scope');
      localStorage.setItem(`${pluginStoragePrefix('notes', ALICE)}note`, 'hers');
      localStorage.setItem(`${pluginStoragePrefix('notes', BOB)}note`, 'his');
      localStorage.setItem('notification-center', '[{"title":"From Eve"}]');
      localStorage.setItem('template-storage', '{"templates":[]}');
      const { usePluginStore } = await import('@/stores/plugin-store');
      usePluginStore.setState({ plugins: [{ id: 'managed', settings: { apiKey: 'k' } }] as never });

      wipe.registerDeviceWipe();
      refuse();
      await vi.waitFor(() => expect(sent.find((call) => call.url.endsWith('/wiped'))?.body).toMatchObject({ reason: 'rejected', id: ROW }));
      await vi.waitFor(() => expect(wipeState.readPendingWipes()).toEqual({}));

      expect(store.removed).toEqual([ALICE]);
      expect(await databases()).toEqual(expect.arrayContaining(['smime-plugin-store', 'bulwark-openpgp']));
      expect(usePluginStore.getState().plugins[0].settings).toEqual({ apiKey: 'k' });
      expect(localStorage.getItem(`${pluginStoragePrefix('notes', ALICE)}note`)).toBeNull();
      expect(localStorage.getItem(`${pluginStoragePrefix('notes', BOB)}note`)).toBe('his');
      expect(localStorage.getItem('notification-center')).not.toBeNull();
      expect(localStorage.getItem('template-storage')).not.toBeNull();
      expect(clearFiles).not.toHaveBeenCalled();
      expect(clearHandoffs).not.toHaveBeenCalled();
      expect((await keys.getDeviceRecord(BOB))?.id).toBe(BOB_ROW);
      expect(state.useOfflineStore.getState().enabled).toEqual([BOB]);
    });

    it('with offline off touches nothing but what\'s the account\'s own', async () => {
      state.writeEnabled([]);
      await openDb('smime-plugin-store');
      const handoffs = await import('@/lib/launch-handoff');
      const clearHandoffs = vi.spyOn(handoffs, 'clearHandoffs');
      const { pluginStoragePrefix } = await import('@/lib/plugin-sandbox/storage-scope');
      localStorage.setItem(`${pluginStoragePrefix('notes', ALICE)}note`, 'hers');
      localStorage.setItem('notification-center', '[{"title":"From Eve"}]');
      wipe.registerDeviceWipe();
      rejected.noteCredentialsRejected(ALICE, true);
      await vi.waitFor(() => expect(localStorage.getItem(`${pluginStoragePrefix('notes', ALICE)}note`)).toBeNull());
      await vi.waitFor(() => expect(wipeState.readPendingWipes()).toEqual({}));
      expect(purge.files).toBe(0);
      expect(store.removed).toEqual([]);
      expect(await databases()).toContain('smime-plugin-store');
      expect(localStorage.getItem('notification-center')).not.toBeNull();
      expect(clearHandoffs).not.toHaveBeenCalled();
    });

    it('records a real count for the audit, however it\'s named here', async () => {
      await queue.queueSend(ALICE, { subject: 'Unsent', to: [] }, { kind: 'email', args: [] });
      wipe.registerDeviceWipe();
      refuse();
      await vi.waitFor(() => expect(sent.find((call) => call.url.endsWith('/wiped'))?.body).toMatchObject({ reason: 'rejected', unsent: 1 }));
    });

    it('doesn\'t delete on a refusal that hasn\'t lasted: one bad answer at a start only hides', async () => {
      wipe.registerDeviceWipe();
      refuse(ALICE, false);
      await vi.waitFor(() => expect(wipeState.readRefusedLogins()[ALICE]?.unsent).toBe(0));
      expect(purge.files).toBe(0);
      expect(store.removed).toEqual([]);
    });

    it('reaches a refusal from before the policy said so', async () => {
      const { usePolicyStore } = await import('@/stores/policy-store');
      const none = { organisation: { devices: {} } };
      usePolicyStore.setState({ policy: none, rawPolicy: none, resolveFor: () => none } as never);
      const stop = wipe.startDeviceWipe();
      refuse();
      await vi.waitFor(() => expect(wipeState.readRefusedLogins()[ALICE]?.unsent).toBe(0));
      expect(purge.files).toBe(0);
      await policyAsksForDeletion();
      await vi.waitFor(() => expect(purge.files).toBeGreaterThan(0));
      stop();
    });
  });

  describe('from a running renewal', () => {
    let heard: string[];

    beforeEach(() => {
      heard = [];
      rejected.onCredentialsRejected((account) => heard.push(account));
      useAccountStore.setState({ accounts: [{ ...entry(ALICE, 0), authMode: 'oauth' }] } as never);
      useAuthStore.setState({ authMode: 'oauth' });
    });

    const token = (next: () => Response) => { respond = (url) => (url.includes('/api/auth/token') ? next() : noWipe()); };

    it.each([
      ['a 500', () => json(500, { error: 'Internal server error' })],
      ['a 503', () => json(503, { error: 'unavailable' })],
      // What the route answers for a 400 invalid_client from the server.
      ['a refusal other than invalid_grant', () => json(401, { error: 'Refresh failed' })],
    ])('%s leaves the hook alone', async (_name, answer) => {
      wipe.registerDeviceWipe();
      token(answer);
      await useAuthStore.getState().refreshAccessToken({ accountId: ALICE });
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(heard).toEqual([]);
      expect(purge.files).toBe(0);
      expect(wipeState.readPendingWipes()).toEqual({});
    });

    it('invalid_grant fires it, signs out and hides: nothing is deleted', async () => {
      wipe.registerDeviceWipe();
      token(() => json(401, { error: 'invalid_grant' }));
      await useAuthStore.getState().refreshAccessToken({ accountId: ALICE });
      expect(heard).toEqual([ALICE]);
      await vi.waitFor(() => expect(useAccountStore.getState().getAccountById(ALICE)).toBeUndefined());
      expect(state.isEvicted(ALICE)).toBe(true);
      expect(purge.files).toBe(0);
      expect(store.removed).toEqual([]);
      expect(state.useOfflineStore.getState().enabled).toEqual([ALICE]);
    });

    it('the session limit hides too, as what it is, not as a refusal', async () => {
      wipe.registerDeviceWipe();
      token(() => json(401, { error: 'session_expired', maxHours: 8 }));
      await useAuthStore.getState().refreshAccessToken({ accountId: ALICE });
      expect(heard).toEqual([ALICE]);
      await vi.waitFor(() => expect(state.isEvicted(ALICE)).toBe(true));
      await vi.waitFor(() => expect(useAccountStore.getState().getAccountById(ALICE)).toBeUndefined());
      expect(purge.files).toBe(0);
      expect(store.removed).toEqual([]);
      expect(wipeState.readRefusedLogins()[ALICE]).toMatchObject({ kind: 'session' });
    });
  });
});

describe('other windows', () => {
  it('a window showing the wiped account reloads at the end, and only then', async () => {
    const reload = vi.fn();
    vi.stubGlobal('location', { ...window.location, reload });
    const stop = wipe.startDeviceWipe();
    const other = new BroadcastChannel('bulwark-device-wipe');

    other.postMessage({ account: ALICE, phase: 'start' });
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(reload).not.toHaveBeenCalled();
    other.postMessage({ account: ALICE, phase: 'end' });
    await vi.waitFor(() => expect(reload).toHaveBeenCalledTimes(1));

    other.close();
    stop();
    vi.unstubAllGlobals();
    vi.stubGlobal('fetch', vi.fn(async () => noWipe()));
  });

  it.each(['start', 'end'])('a window showing another account lets go of the wiped one at the %s, in place', async (phase) => {
    const reload = vi.fn();
    vi.stubGlobal('location', { ...window.location, reload });
    useAccountStore.setState({ accounts: [entry(ALICE, 0), entry(BOB, 1)] } as never);
    state.writeEnabled([ALICE, BOB]);
    await keys.putDeviceRecord({ account: BOB, id: BOB_ROW, secret: SECRET, createdAt: 1 });
    const stop = wipe.startDeviceWipe();
    const other = new BroadcastChannel('bulwark-device-wipe');
    await vi.waitFor(() => expect(sent.length).toBeGreaterThan(0));
    sent.length = 0;

    other.postMessage({ account: BOB, phase });
    await vi.waitFor(() => expect(useAccountStore.getState().getAccountById(BOB)).toBeUndefined());

    // Its own registry won't write it back, and the wiping window's work isn't done over here.
    expect(reload).not.toHaveBeenCalled();
    expect(state.useOfflineStore.getState().enabled).toEqual([ALICE]);
    expect(state.isEvicted(BOB)).toBe(false);
    expect(store.removed).toEqual([]);
    expect(purge.files).toBe(0);
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(sent.filter((call) => call.url.endsWith('/wiped'))).toEqual([]);
    expect((await keys.getDeviceRecord(BOB))?.id).toBe(BOB_ROW);
    expect(JSON.parse(localStorage.getItem('account-registry') ?? '{"state":{"accounts":[]}}').state.accounts.map((a: { id: string }) => a.id)).not.toContain(BOB);

    other.close();
    stop();
    vi.unstubAllGlobals();
    vi.stubGlobal('fetch', vi.fn(async () => noWipe()));
  });

  it('a wipe tells the others when it starts and when it ends', async () => {
    const heard: unknown[] = [];
    const other = new BroadcastChannel('bulwark-device-wipe');
    other.onmessage = (event) => heard.push(event.data);
    respond = (url) => (url.endsWith('/wiped') ? json(200, { ok: true }) : noWipe());
    purge.during = () => { heard.push('deleting'); };
    await wipe.wipeAccountFromDevice(ALICE, 'admin');
    await vi.waitFor(() => expect(heard.at(-1)).toEqual({ account: ALICE, phase: 'end' }));
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(heard).toContainEqual({ account: ALICE, phase: 'start' });
    other.close();
  });

  it('the window that wipes doesn\'t hear its own message', async () => {
    const reload = vi.fn();
    vi.stubGlobal('location', { ...window.location, reload });
    const stop = wipe.startDeviceWipe();
    respond = () => json(200, { ok: true });
    await wipe.wipeWholeDevice('user');
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(reload).not.toHaveBeenCalled();
    stop();
    vi.unstubAllGlobals();
    vi.stubGlobal('fetch', vi.fn(async () => noWipe()));
  });
});

describe('what the desktop app keeps outside the page', () => {
  const shell = { clearSurfaces: vi.fn(), clearClipboardFiles: vi.fn(async () => {}) };

  beforeEach(() => {
    shell.clearSurfaces.mockClear();
    shell.clearClipboardFiles.mockClear();
    (window as { bulwarkDesktop?: unknown }).bulwarkDesktop = {
      version: 1,
      platform: 'win32',
      mode: 'instance',
      os: { clearSurfaces: shell.clearSurfaces },
      clipboard: { clearFiles: shell.clearClipboardFiles },
    };
  });

  it('goes with a remote wipe', async () => {
    respond = (url) => (url.endsWith('/wiped') ? json(200, { ok: true }) : wipeNow());
    await wipe.runDeviceGate();
    await waitForNoAccounts();
    expect(shell.clearSurfaces).toHaveBeenCalled();
    expect(shell.clearClipboardFiles).toHaveBeenCalled();
  });

  it('goes with a wipe from settings', async () => {
    respond = () => json(200, { ok: true });
    await wipe.wipeWholeDevice('user');
    expect(shell.clearSurfaces).toHaveBeenCalled();
    expect(shell.clearClipboardFiles).toHaveBeenCalled();
  });

  it('the import from this computer goes too, and the shell hears it before the record is gone', async () => {
    const order: string[] = [];
    const { readStoredJob, writeStoredJob } = await import('@/lib/mail-import/checkpoints');
    await writeStoredJob(ALICE, { id: 'job', scope: ALICE });
    const localImport = {
      release: vi.fn(async () => {}),
      releaseAll: vi.fn(async () => {
        order.push(`releaseAll, record ${JSON.stringify(await readStoredJob(ALICE))}`);
      }),
    };
    const window2 = window as { bulwarkDesktop?: { localImport?: unknown } };
    window2.bulwarkDesktop = { ...window2.bulwarkDesktop, localImport };
    respond = () => json(200, { ok: true });
    await wipe.wipeWholeDevice('user');
    expect(order).toEqual([`releaseAll, record ${JSON.stringify({ id: 'job', scope: ALICE })}`]);
    expect(await readStoredJob(ALICE)).toBeNull();
  });

  it('a wipe of one account releases that account\'s import in the shell', async () => {
    const { writeStoredJob } = await import('@/lib/mail-import/checkpoints');
    await writeStoredJob(ALICE, { id: 'job', scope: ALICE });
    const localImport = { release: vi.fn(async () => {}), releaseAll: vi.fn(async () => {}) };
    const window2 = window as { bulwarkDesktop?: { localImport?: unknown } };
    window2.bulwarkDesktop = { ...window2.bulwarkDesktop, localImport };
    respond = (url) => (url.endsWith('/wiped') ? json(200, { ok: true }) : wipeNow());
    await wipe.runDeviceGate();
    await waitForNoAccounts();
    expect(localImport.release).toHaveBeenCalledWith('job');
  });

  it('a shell without those calls wipes all the same', async () => {
    (window as { bulwarkDesktop?: unknown }).bulwarkDesktop = { version: 1, platform: 'win32', mode: 'instance' };
    respond = (url) => (url.endsWith('/wiped') ? json(200, { ok: true }) : wipeNow());
    await wipe.runDeviceGate();
    await waitForNoAccounts();
    expect(purge.files).toBeGreaterThan(0);
  });

  it('a call that fails leaves the wipe going', async () => {
    shell.clearClipboardFiles.mockRejectedValueOnce(new Error('held by a program'));
    respond = () => json(200, { ok: true });
    await wipe.wipeWholeDevice('user');
    expect(purge.files).toBeGreaterThan(0);
  });
});

describe('the wipe from settings', () => {
  it('takes everything, reports to the instance, and leaves no note: the user was there', async () => {
    respond = () => json(200, { ok: true });
    await wipe.wipeWholeDevice('user');
    expect(purge.files).toBeGreaterThan(0);
    expect(useAccountStore.getState().accounts).toEqual([]);
    expect(sent.find((call) => call.url.endsWith('/wiped'))?.body).toMatchObject({ reason: 'user', id: ROW });
    expect(wipeState.consumeWipeNote()).toBeNull();
  });

  it('marks that the user signed out, so a provider session doesn\'t sign them straight back in', async () => {
    respond = () => json(200, { ok: true });
    await wipe.wipeWholeDevice('user');
    expect(sessionStorage.getItem('signed_out')).toBe('true');
  });
});

describe('the report and the deletion', () => {
  beforeEach(() => {
    respond = (url) => (url.endsWith('/wiped') ? json(200, { ok: true }) : wipeNow());
  });

  it('is queued before anything is deleted, and not sent until it\'s done', async () => {
    let queuedWhenDeleting: string[] = [];
    let sentWhenDeleting = -1;
    purge.during = () => {
      // The first time is the wipe's. The sign-out purges too, when all is done.
      if (sentWhenDeleting >= 0) return;
      queuedWhenDeleting = wipeState.readWipeConfirmations().map((entry) => entry.id);
      sentWhenDeleting = sent.filter((call) => call.url.endsWith('/wiped')).length;
    };
    await wipe.wipeAccountFromDevice(ALICE, 'admin');
    expect(queuedWhenDeleting).toEqual([ROW]);
    expect(sentWhenDeleting).toBe(0);
    expect(sent.filter((call) => call.url.endsWith('/wiped'))).toHaveLength(1);
    expect(wipeState.readWipeConfirmations()).toEqual([]);
  });

  it('another contact during the wipe doesn\'t send it early', async () => {
    let early = -1;
    respond = (url) => (url.endsWith('/wiped') ? json(200, { ok: true }) : noWipe());
    registry.onDeviceWipe(async () => {
      await wipe.checkInDue(true);
      early = sent.filter((call) => call.url.endsWith('/wiped')).length;
    });
    await wipe.wipeAccountFromDevice(ALICE, 'admin');
    expect(early).toBe(0);
    expect(sent.filter((call) => call.url.endsWith('/wiped'))).toHaveLength(1);
  });

  it('a deletion that fails isn\'t reported as done: it stays pending and is finished at the next start', async () => {
    purge.fail = true;
    await wipe.wipeAccountFromDevice(ALICE, 'admin');
    expect(sent.filter((call) => call.url.endsWith('/wiped'))).toEqual([]);
    expect(wipeState.readPendingWipes()).toEqual({ [ALICE]: 'admin' });
    expect(wipeState.readWipeConfirmations().map((entry) => entry.id)).toEqual([ROW]);
    // Signed out all the same: nothing more is shown.
    expect(useAccountStore.getState().accounts).toEqual([]);

    purge.fail = false;
    await wipe.finishInterruptedWipes();
    expect(purge.files).toBeGreaterThan(0);
    expect(wipeState.readPendingWipes()).toEqual({});
    expect(sent.find((call) => call.url.endsWith('/wiped'))?.body).toMatchObject({ id: ROW, reason: 'admin' });
  });

  it('a plugin database a frame holds open isn\'t reported as wiped until it\'s gone', async () => {
    const held = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open('smime-plugin-store', 1);
      request.onupgradeneeded = () => { request.result.createObjectStore('s'); };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    await wipe.wipeAccountFromDevice(ALICE, 'admin');
    expect(Object.keys(wipeState.readBlockedDatabases())).toEqual(['smime-plugin-store']);
    expect(sent.filter((call) => call.url.endsWith('/wiped'))).toEqual([]);
    expect(wipeState.readWipeConfirmations().map((entry) => entry.id)).toEqual([ROW]);

    held.close();
    await wipe.finishInterruptedWipes();
    await wipe.checkInDue(true);
    await vi.waitFor(() => expect(sent.filter((call) => call.url.endsWith('/wiped'))).toHaveLength(1));
    expect(wipeState.readBlockedDatabases()).toEqual({});
    expect(await databases()).not.toContain('smime-plugin-store');
  });
});

describe('two wipes at once', () => {
  beforeEach(async () => {
    useAccountStore.setState({ accounts: [entry(ALICE, 0), entry(BOB, 1)] } as never);
    state.writeEnabled([ALICE, BOB]);
    await keys.openAccountKey(BOB);
    await keys.putDeviceRecord({ account: BOB, id: BOB_ROW, secret: SECRET, createdAt: 1 });
    respond = () => json(200, { ok: true });
  });

  it('neither puts back the row the other just removed', async () => {
    await Promise.all([wipe.wipeAccountFromDevice(ALICE, 'admin'), wipe.wipeAccountFromDevice(BOB, 'admin')]);
    expect(await keys.listDeviceRecords()).toEqual([]);
    expect(useAccountStore.getState().accounts).toEqual([]);
    expect(wipeState.readPendingWipes()).toEqual({});
    expect(sent.filter((call) => call.url.endsWith('/wiped')).map((call) => call.body.id).sort()).toEqual([ROW, BOB_ROW].sort());
  });

  it('one runs after the other: they don\'t overlap', async () => {
    const running: string[] = [];
    let overlapped = false;
    registry.onDeviceWipe(async (account) => {
      if (running.length > 0) overlapped = true;
      running.push(String(account));
      await new Promise((resolve) => setTimeout(resolve, 20));
      running.pop();
    });
    await Promise.all([wipe.wipeAccountFromDevice(ALICE, 'admin'), wipe.wipeAccountFromDevice(BOB, 'admin')]);
    expect(overlapped).toBe(false);
  });

  it('a wipe heard twice is done once: the second finds the row gone', async () => {
    let cleaned = 0;
    registry.onDeviceWipe(() => { cleaned += 1; });
    await wipe.wipeAccountFromDevice(ALICE, 'admin', { ifRow: ROW });
    expect(cleaned).toBe(1);
    const reports = sent.filter((call) => call.url.endsWith('/wiped')).length;
    expect(wipeState.consumeWipeNote()).toEqual({ unsent: 0 });
    await wipe.wipeAccountFromDevice(ALICE, 'admin', { ifRow: ROW });
    expect(cleaned).toBe(1);
    expect(sent.filter((call) => call.url.endsWith('/wiped'))).toHaveLength(reports);
    expect(wipeState.consumeWipeNote()).toBeNull();
    expect(wipeState.readPendingWipes()).toEqual({});
  });

  it('takes the Web Lock where the browser has one', async () => {
    const names: string[] = [];
    vi.stubGlobal('navigator', Object.assign(Object.create(navigator), {
      locks: { request: async (name: string, work: () => Promise<unknown>) => { names.push(name); return work(); } },
    }));
    await wipe.wipeAccountFromDevice(ALICE, 'admin');
    vi.stubGlobal('navigator', Object.getPrototypeOf(navigator));
    expect(names).toContain('bulwark-device-wipe');
  });
});

describe('a sign-out', () => {
  beforeEach(() => {
    respond = () => json(200, { ok: true });
  });

  it('drops the row with its secret', async () => {
    wipe.registerDeviceWipe();
    await useAuthStore.getState().logout({ endProviderSession: false });
    await vi.waitFor(() => expect(sent.find((call) => call.url.endsWith('/wiped'))?.body).toEqual({ id: ROW, secret: SECRET, drop: true }));
    expect(wipeState.readWipeConfirmations()).toEqual([]);
  });

  it('has its row on the way before the key database goes with the rest', async () => {
    respond = () => json(503, {});
    let queuedAtPurge: string[] | null = null;
    purge.during = () => { queuedAtPurge ??= wipeState.readWipeConfirmations().map((entry) => entry.id); };
    wipe.registerDeviceWipe();
    await useAuthStore.getState().logout({ endProviderSession: false });
    await vi.waitFor(() => expect(purge.files).toBeGreaterThan(0));
    expect(queuedAtPurge).toEqual([ROW]);
  });

  it('removing another account drops its row too, and keeps this one\'s', async () => {
    useAccountStore.setState({ accounts: [entry(ALICE, 0), entry(BOB, 1)] } as never);
    await keys.putDeviceRecord({ account: BOB, id: BOB_ROW, secret: SECRET, createdAt: 1 });
    wipe.registerDeviceWipe();
    useAuthStore.getState().removeAccount(BOB);
    await vi.waitFor(() => expect(sent.find((call) => call.url.endsWith('/wiped'))?.body).toEqual({ id: BOB_ROW, secret: SECRET, drop: true }));
    expect(await keys.getDeviceRecord(BOB)).toBeNull();
    expect((await keys.getDeviceRecord(ALICE))?.id).toBe(ROW);
  });

  it('a sign-out that keeps the data keeps the row: an admin can still reach it', async () => {
    wipe.registerDeviceWipe();
    await useAuthStore.getState().logout({ endProviderSession: false, keepLocalData: true });
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(sent.filter((call) => call.url.endsWith('/wiped'))).toEqual([]);
    expect((await keys.getDeviceRecord(ALICE))?.id).toBe(ROW);
  });

  it('gets through at the next contact when the instance was out of reach', async () => {
    respond = () => json(503, {});
    wipe.registerDeviceWipe();
    await useAuthStore.getState().logout({ endProviderSession: false });
    await vi.waitFor(() => expect(wipeState.readWipeConfirmations().map((entry) => entry.id)).toEqual([ROW]));
    respond = () => json(200, { ok: true });
    await wipe.checkInDue(true);
    await vi.waitFor(() => expect(wipeState.readWipeConfirmations()).toEqual([]));
  });
});

describe('counting what a wipe loses', () => {
  const offline = () => import('../offline-mode');

  it('per account: each row reports its own, not the device\'s total', async () => {
    useAccountStore.setState({ accounts: [entry(ALICE, 0), entry(BOB, 1)] } as never);
    state.writeEnabled([ALICE, BOB]);
    await keys.openAccountKey(BOB);
    await keys.putDeviceRecord({ account: BOB, id: BOB_ROW, secret: SECRET, createdAt: 1 });
    await queue.queueSend(ALICE, { subject: 'One', to: [] }, { kind: 'email', args: [] });
    await queue.queueSend(ALICE, { subject: 'Two', to: [] }, { kind: 'email', args: [] });
    respond = () => json(200, { ok: true });
    await wipe.wipeWholeDevice('user');
    const reports = sent.filter((call) => call.url.endsWith('/wiped')).map((call) => call.body);
    expect(reports.find((body) => body.id === ROW)).toMatchObject({ unsent: 2 });
    expect(reports.find((body) => body.id === BOB_ROW)).toMatchObject({ unsent: 0 });
  });

  it('a store that can\'t answer gives unknown, not nought', async () => {
    store.failArea = () => true;
    expect(await (await offline()).unsentForWipe(ALICE)).toBeNull();
  });

  it('a store that doesn\'t answer in time gives unknown, not nought', async () => {
    const api = await import('@/lib/store/client/api');
    vi.spyOn(api.getStore(), 'area').mockImplementation(() => new Promise(() => {}));
    expect(await (await offline()).unsentForWipe(ALICE, 20)).toBeNull();
    vi.restoreAllMocks();
  });

  it('waits longer for it than a sign-out does', async () => {
    expect((await offline()).UNSENT_FOR_WIPE_MS).toBeGreaterThanOrEqual(10_000);
  });

  it('reports an unknown count as such, and says so at the next sign-in', async () => {
    store.failArea = () => true;
    respond = (url) => (url.endsWith('/wiped') ? json(200, { ok: true }) : noWipe());
    await wipe.wipeAccountFromDevice(ALICE, 'admin');
    expect(sent.find((call) => call.url.endsWith('/wiped'))?.body).toMatchObject({ unsent: null });
    expect(wipeState.consumeWipeNote()).toEqual({ unsent: 0, unknown: true });
  });

  it('counts an account nobody can see too: it goes with the device', async () => {
    await queue.queueSend(ALICE, { subject: 'Hidden', to: [] }, { kind: 'email', args: [] });
    state.markEvicted(ALICE);
    expect(await (await offline()).unsentForWipe('all')).toBe(1);
  });
});

describe('what else goes with a wipe', () => {
  const ACCOUNT_KEYS = [
    'pro-tabs', 'search-history-storage', 'files-favorites', 'files-recent-files', 'files-last-parent-id', 'files-path-stack',
    'bulwark-delegate-names', 'calendar-notification-storage', 'identity-storage', 'contact-storage', 'calendar-storage',
    'webdav-favorites', 'webdav-recent-files', 'webdav-last-path', 'template-storage',
  ];
  let closed: string[];
  let unsubscribed: number;
  let deletedCaches: string[];

  function plant(): void {
    for (const key of ACCOUNT_KEYS) localStorage.setItem(key, 'x');
    localStorage.setItem('settings-storage', 'device preference');
    localStorage.setItem('theme-storage', 'device preference');
    localStorage.setItem('email-snapshot', JSON.stringify({ account: ALICE, emails: [{ subject: 'From Eve' }] }));
    sessionStorage.setItem('bulwark-rescued-drafts', JSON.stringify([{ subject: 'Half written', body: 'text' }]));
  }

  beforeEach(() => {
    respond = (url) => (url.endsWith('/wiped') ? json(200, { ok: true }) : noWipe());
    closed = [];
    unsubscribed = 0;
    deletedCaches = [];
    plant();
    const registration = {
      getNotifications: async () => [{ title: 'From Eve', close() { closed.push(this.title); } }],
      pushManager: { getSubscription: async () => ({ unsubscribe: async () => { unsubscribed += 1; return true; } }) },
    };
    Object.defineProperty(navigator, 'serviceWorker', { configurable: true, value: { getRegistration: async () => registration, controller: null } });
    vi.stubGlobal('caches', {
      keys: async () => ['bulwark-push-state-v1', 'unrelated'],
      delete: async (name: string) => { deletedCaches.push(name); return true; },
      open: async () => ({ put: async () => {} }),
    });
  });

  afterEach(() => {
    delete (navigator as { serviceWorker?: unknown }).serviceWorker;
    vi.unstubAllGlobals();
  });

  it('an admin wipe takes them, closes what\'s on screen, and the last account ends Web Push', async () => {
    const { saveForwardApprovals, forwardApprovals } = await import('@/lib/plugin-sandbox/forward-approvals');
    saveForwardApprovals('forwarder', ALICE, ['eve@example.org']);
    await wipe.wipeAccountFromDevice(ALICE, 'admin');
    for (const key of ACCOUNT_KEYS) expect([key, localStorage.getItem(key)]).toEqual([key, null]);
    expect(localStorage.getItem('email-snapshot')).toBeNull();
    expect(sessionStorage.getItem('bulwark-rescued-drafts')).toBeNull();
    expect(forwardApprovals('forwarder', ALICE)).toEqual([]);
    expect(closed).toEqual(['From Eve']);
    expect(deletedCaches).toContain('bulwark-push-state-v1');
    expect(unsubscribed).toBe(1);
    expect(localStorage.getItem('settings-storage')).toBe('device preference');
    expect(localStorage.getItem('theme-storage')).toBe('device preference');
  });

  it('with another account left, Web Push stays: it\'s shared', async () => {
    useAccountStore.setState({ accounts: [entry(ALICE, 0), entry(BOB, 1)] } as never);
    await wipe.wipeAccountFromDevice(ALICE, 'admin');
    expect(closed).toEqual(['From Eve']);
    expect(unsubscribed).toBe(0);
    // No full sign-out comes along to clean up behind it. A store may write itself back, empty.
    for (const key of ['pro-tabs', 'search-history-storage', 'files-favorites', 'files-recent-files', 'files-last-parent-id', 'files-path-stack',
      'bulwark-delegate-names', 'calendar-notification-storage', 'webdav-favorites', 'webdav-recent-files', 'webdav-last-path', 'template-storage']) {
      expect([key, localStorage.getItem(key)]).not.toEqual([key, 'x']);
    }
    expect(deletedCaches).toContain('bulwark-push-state-v1');
  });

  it('a wipe from settings takes them too', async () => {
    await wipe.wipeWholeDevice('user');
    for (const key of ACCOUNT_KEYS) expect([key, localStorage.getItem(key)]).toEqual([key, null]);
    expect(unsubscribed).toBe(1);
  });

  it('a deletion after a refused login leaves all of it: only the account\'s own snapshot goes', async () => {
    await policyAsksForDeletion();
    wipe.registerDeviceWipe();
    refuse();
    await vi.waitFor(() => expect(store.removed.length + purge.files).toBeGreaterThan(0));
    await vi.waitFor(() => expect(wipeState.readPendingWipes()).toEqual({}));
    expect(localStorage.getItem('email-snapshot')).toBeNull();
    for (const key of ACCOUNT_KEYS) expect([key, localStorage.getItem(key)]).toEqual([key, 'x']);
    expect(closed).toEqual([]);
    expect(unsubscribed).toBe(0);
  });
});

describe('the desktop app\'s main process in a wipe', () => {
  /** What the real preload hands out, once. */
  function shellWith(localWipe: (request: { reason: string; account: string | null }) => Promise<{ failed: string[] }>) {
    const finish = vi.fn(async () => {});
    const calls: string[] = [];
    const wrapped = vi.fn(async (request: { reason: string; account: string | null }) => {
      calls.push('main');
      return localWipe(request);
    });
    (window as unknown as { bulwarkDesktop: unknown }).bulwarkDesktop = {
      version: 1,
      platform: 'win32',
      mode: 'standalone',
      appLock: {
        status: async () => ({ wrap: false }),
        forget: async () => true,
        claim: () => ({ lock() {}, osUnlock: async () => ({ ok: false }), localWipe: wrapped, finishLocalWipe: finish }),
      },
    };
    return { run: wrapped, finish, calls };
  }

  afterEach(() => {
    delete (window as unknown as { bulwarkDesktop?: unknown }).bulwarkDesktop;
  });

  it('a wipe from settings asks main for everything, and restarts when all went', async () => {
    const { run, finish } = shellWith(async () => ({ failed: [] }));
    await wipe.wipeWholeDevice('user');
    expect(run).toHaveBeenCalledWith({ reason: 'settings', account: null });
    expect(finish).toHaveBeenCalledTimes(1);
    expect(wipeState.readPendingWipes()).toEqual({});
  });

  it('a remote wipe of the last account does too, tells the instance after main answered, and keeps the note if it could not', async () => {
    const order: string[] = [];
    respond = (url) => {
      if (url.endsWith('/wiped')) {
        order.push('report');
        return json(500, {});
      }
      return noWipe();
    };
    const { run, finish } = shellWith(async () => {
      order.push('main');
      return { failed: [] };
    });
    await wipe.wipeAccountFromDevice(ALICE, 'admin');
    expect(run).toHaveBeenCalledWith({ reason: 'remote', account: null });
    expect(order).toEqual(['main', 'report']);
    // The instance hasn't heard: the id and secret have to outlive the restart.
    expect(finish).toHaveBeenCalledWith({ keepLocalStorage: true });
  });

  it('a step main could not finish: not reported as done, tried again, and no restart', async () => {
    const { finish } = shellWith(async () => ({ failed: ['edited files'] }));
    const reports: unknown[] = [];
    respond = (url, init) => {
      if (url.endsWith('/wiped')) reports.push(init?.body);
      return url.endsWith('/wiped') ? json(200, { ok: true }) : noWipe();
    };
    await wipe.wipeAccountFromDevice(ALICE, 'admin');
    expect(reports).toEqual([]);
    expect(wipeState.readPendingWipes()).toEqual({ [ALICE]: 'admin' });
    expect(finish).not.toHaveBeenCalled();
  });

  it('main never answering counts as a step that failed', async () => {
    // Only that wait is shortened: the promise itself never settles.
    const real = globalThis.setTimeout;
    vi.stubGlobal('setTimeout', (run: () => void, ms?: number) => real(run, ms === wipe.MAIN_WIPE_BUDGET_MS ? 50 : ms));
    try {
      const { finish } = shellWith(() => new Promise(() => {}));
      await wipe.wipeWholeDevice('user');
      expect(finish).not.toHaveBeenCalled();
      expect(wipeState.WHOLE_DEVICE in wipeState.readPendingWipes()).toBe(true);
    } finally {
      vi.stubGlobal('setTimeout', real);
    }
  });

  it('one account with another still signed in: only that account, and no restart', async () => {
    useAccountStore.setState({ accounts: [entry(ALICE, 0), entry(BOB, 1)] } as never);
    const { run, finish } = shellWith(async () => ({ failed: [] }));
    await wipe.wipeAccountFromDevice(ALICE, 'admin');
    expect(run).toHaveBeenCalledWith({ reason: 'remote', account: ALICE });
    expect(finish).not.toHaveBeenCalled();
  });

  it('a deletion after a refused login stays with the account, also the last one', async () => {
    const { run, finish } = shellWith(async () => ({ failed: [] }));
    await wipe.wipeAccountFromDevice(ALICE, 'rejected');
    expect(run).toHaveBeenCalledWith({ reason: 'remote', account: ALICE });
    expect(finish).not.toHaveBeenCalled();
  });

  it('an older shell has no such call: the wipe still finishes', async () => {
    (window as unknown as { bulwarkDesktop: unknown }).bulwarkDesktop = {
      version: 1, platform: 'win32', mode: 'standalone', appLock: { status: async () => ({ wrap: false }), forget: async () => true, claim: () => ({ lock() {}, osUnlock: async () => ({ ok: false }) }) },
    };
    await wipe.wipeWholeDevice('user');
    expect(wipeState.readPendingWipes()).toEqual({});
  });
});

describe('the HTTP cache in the desktop app', () => {
  it('goes with a wipe, also of one account with another still signed in', async () => {
    const clear = vi.fn(async () => {});
    (window as unknown as { bulwarkDesktop: unknown }).bulwarkDesktop = { version: 1, platform: 'win32', mode: 'standalone', httpCache: { clear } };
    useAccountStore.setState({ accounts: [entry(ALICE, 0), entry(BOB, 1)] } as never);
    try {
      await wipe.wipeAccountFromDevice(ALICE, 'user');
      expect(clear).toHaveBeenCalled();
    } finally {
      delete (window as unknown as { bulwarkDesktop?: unknown }).bulwarkDesktop;
    }
  });
});

describe('the 30 days', () => {
  it('run out in an app that stays open too', async () => {
    const offline = await import('../offline-mode');
    const stop = offline.startOfflineMode();
    try {
      state.markEvicted(ALICE, Date.now() - 31 * 24 * 60 * 60 * 1000);
      useAccountStore.setState({ accounts: [] } as never);
      const before = purge.files;
      expect(offline.EVICTED_SWEEP_MS).toBeLessThanOrEqual(60 * 60 * 1000);
      const spy = vi.spyOn(globalThis, 'setInterval');
      stop();
      const again = offline.startOfflineMode();
      const tick = spy.mock.calls.find((call) => call[1] === offline.EVICTED_SWEEP_MS)?.[0] as (() => void) | undefined;
      expect(tick).toBeTypeOf('function');
      spy.mockRestore();
      tick!();
      await vi.waitFor(() => expect(purge.files).toBeGreaterThan(before));
      again();
    } finally {
      stop();
    }
  });
});

describe('a shell that never answers about shown notifications', () => {
  // Electron has no answer to getNotifications(): the promise stays pending for good.
  beforeEach(() => {
    respond = (url) => (url.endsWith('/wiped') ? json(200, { ok: true }) : noWipe());
    const registration = {
      getNotifications: () => new Promise<Notification[]>(() => {}),
      pushManager: { getSubscription: async () => null },
    };
    Object.defineProperty(navigator, 'serviceWorker', { configurable: true, value: { getRegistration: async () => registration, controller: null } });
  });

  afterEach(() => {
    delete (navigator as { serviceWorker?: unknown }).serviceWorker;
  });

  const ended = (work: Promise<void>) => Promise.race([
    work.then(() => 'finished'),
    new Promise((resolve) => setTimeout(() => resolve('hung'), 20_000)),
  ]);

  it('a wipe of the whole device still gets to the keys and the files', async () => {
    const before = purge.files;
    expect(await ended(wipe.wipeWholeDevice('user'))).toBe('finished');
    expect(purge.files).toBeGreaterThan(before);
    expect(wipeState.readPendingWipes()).toEqual({});
    expect(useAuthStore.getState().isAuthenticated).toBe(false);
  });

  it('a wipe of one account gets past them too, to its sign-out', async () => {
    expect(await ended(wipe.wipeAccountFromDevice(ALICE, 'admin'))).toBe('finished');
    expect(wipeState.readPendingWipes()).toEqual({});
    expect(useAccountStore.getState().accounts.some((account) => account.id === ALICE)).toBe(false);
  });
});

describe('the session timers', () => {
  const timerSignOut = () => useAuthStore.getState().logoutAll({ endProviderSession: false, keepLocalData: true, sessionLimit: true });

  it('leave the outbox whole, and a sign-in brings it back', async () => {
    await queue.queueSend(ALICE, { subject: 'Unsent', to: [] }, { kind: 'email', args: [] });
    wipe.registerDeviceWipe();
    const lost = await import('../lost');
    const at = Date.now();
    await timerSignOut();

    expect(useAccountStore.getState().accounts).toEqual([]);
    expect(useAuthStore.getState().isAuthenticated).toBe(false);
    expect(state.isEvicted(ALICE)).toBe(true);
    expect(state.visibleAccounts()).toEqual([]);
    expect(purge.files).toBe(0);
    expect(store.removed).toEqual([]);
    expect(state.useOfflineStore.getState().enabled).toEqual([ALICE]);
    expect(lost.consumeLost()).toEqual([]);
    await vi.waitFor(() => expect(wipeState.refusedWaits()).toEqual([{ unsent: 1, until: expect.any(Number), kind: 'session' }]));

    const offline = await import('../offline-mode');
    await offline.sweepAccountsGone(at + 14 * DAY);
    expect(purge.files).toBe(0);

    useAccountStore.getState().addAccount(entry(ALICE, 0) as never);
    expect(state.visibleAccounts()).toEqual([ALICE]);
    expect((await queue.readQueue(ALICE)).outbox.map((row) => row.summary.subject)).toEqual(['Unsent']);
    expect(wipeState.refusedWaits()).toEqual([]);
    await wipe.sweepRefusedLogins();
    expect(wipeState.readRefusedLogins()).toEqual({});
  });

  it('with no sign-in for 30 days it goes', async () => {
    await queue.queueSend(ALICE, { subject: 'Unsent', to: [] }, { kind: 'email', args: [] });
    wipe.registerDeviceWipe();
    const at = Date.now();
    await timerSignOut();
    const offline = await import('../offline-mode');
    await offline.sweepAccountsGone(at + 31 * DAY);
    expect(purge.files).toBeGreaterThan(0);
  });

  it('keep S/MIME and OpenPGP keys and the row: an admin can still reach the device', async () => {
    await openDb('smime-plugin-store');
    wipe.registerDeviceWipe();
    await timerSignOut();
    expect(await databases()).toContain('smime-plugin-store');
    expect((await keys.getDeviceRecord(ALICE))?.id).toBe(ROW);
    expect(sent.filter((call) => call.url.endsWith('/wiped'))).toEqual([]);
  });

  it('with the organisation asking for deletion, it goes at once, only that account\'s, named as the session limit', async () => {
    await policyAsksForDeletion();
    respond = (url) => (url.endsWith('/wiped') ? json(200, { ok: true }) : noWipe());
    await openDb('smime-plugin-store');
    wipe.registerDeviceWipe();
    await timerSignOut();
    await vi.waitFor(() => expect(sent.find((call) => call.url.endsWith('/wiped'))?.body).toMatchObject({ reason: 'session', id: ROW }));
    await vi.waitFor(() => expect(wipeState.readPendingWipes()).toEqual({}));
    expect(state.useOfflineStore.getState().enabled).toEqual([]);
    expect(await databases()).toContain('smime-plugin-store');
  });

  it('a sign-out the user asks for still deletes', async () => {
    await queue.queueSend(ALICE, { subject: 'Unsent', to: [] }, { kind: 'email', args: [] });
    await useAuthStore.getState().logoutAll({ endProviderSession: false });
    expect(state.isEvicted(ALICE)).toBe(false);
    await vi.waitFor(() => expect(purge.files).toBeGreaterThan(0));
    expect(wipeState.readRefusedLogins()).toEqual({});
  });
});

describe('a refused account with another still signed in', () => {
  beforeEach(async () => {
    useAccountStore.setState({ accounts: [entry(ALICE, 0), entry(BOB, 1)] } as never);
    state.writeEnabled([ALICE, BOB]);
    await keys.openAccountKey(BOB);
    await queue.queueSend(BOB, { subject: 'Unsent', to: [] }, { kind: 'email', args: [] });
  });

  /** What the auth store writes down, with who was there to read it. */
  function refuseBob(): void {
    wipeState.markLoginRefused(BOB, { certain: true, seenBy: [ALICE], label: BOB, username: 'bob' });
    rejected.noteCredentialsRejected(BOB, true);
    useAccountStore.getState().removeAccount(BOB, 'evicted');
  }

  it('is there for the one who was signed in beside it, with its count and date', async () => {
    wipe.registerDeviceWipe();
    const at = Date.now();
    refuseBob();
    await vi.waitFor(() => expect(wipeState.siblingWaits(ALICE)[0]?.unsent).toBe(1));
    const [wait] = wipeState.siblingWaits(ALICE);
    expect(wait).toMatchObject({ label: BOB, username: 'bob', kind: 'refused' });
    expect(wait.until).toBeGreaterThanOrEqual(at + state.EVICTED_KEEP_MS);
  });

  it('isn\'t for anyone who signs in here later, and goes when the account is back', async () => {
    wipe.registerDeviceWipe();
    refuseBob();
    await vi.waitFor(() => expect(wipeState.siblingWaits(ALICE)).toHaveLength(1));
    expect(wipeState.siblingWaits('someone-else')).toEqual([]);
    useAccountStore.getState().addAccount(entry(BOB, 1) as never);
    expect(wipeState.siblingWaits(ALICE)).toEqual([]);
  });

  it('says so once, when the count is known', async () => {
    wipe.registerDeviceWipe();
    expect(wipeState.takeSiblingToasts(ALICE)).toEqual([]);
    refuseBob();
    expect(wipeState.takeSiblingToasts(ALICE)).toEqual([]);
    await vi.waitFor(() => expect(wipeState.siblingWaits(ALICE)[0]?.unsent).toBe(1));
    expect(wipeState.takeSiblingToasts(ALICE)).toEqual([expect.objectContaining({ label: BOB, unsent: 1 })]);
    expect(wipeState.takeSiblingToasts(ALICE)).toEqual([]);
  });

  it('says so with no number when the store can\'t give one', async () => {
    store.failArea = () => true;
    wipe.registerDeviceWipe();
    refuseBob();
    await vi.waitFor(() => expect(wipeState.takeSiblingToasts(ALICE)).toEqual([expect.objectContaining({ unsent: null })]));
  });
});
