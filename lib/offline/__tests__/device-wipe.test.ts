import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it, vi } from 'vitest';

// What a wipe removes and what makes one happen. Real auth store, real offline
// mode, the store's real engine, real IndexedDB (fake-indexeddb): only the
// network is a stub, and the OPFS pool, which jsdom doesn't have.

vi.mock('@/lib/compose-flush-registry', () => ({ flushComposers: vi.fn(async () => ({ total: 0, settled: 0, failed: 0, timedOut: false })) }));
const purge = vi.hoisted(() => ({ files: 0 }));
vi.mock('@/lib/store/client/purge', async () => {
  const keys = await vi.importActual<typeof import('@/lib/store/client/keys')>('@/lib/store/client/keys');
  return { purgeStoreFiles: async () => { purge.files += 1; keys.deleteKeyDatabase(); }, deleteStorePool: async () => {} };
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
      return id ? json(404, { error: 'unknown_device' }) : json(200, { id: BOB_ROW, secret: SECRET });
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
    respond = () => json(200, { id: ROW, secret: SECRET });
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
    respond = () => json(200, { id: ROW, secret: SECRET });
    await wipe.checkInDue(true);
    expect(sent).toHaveLength(1);
  });

  it('the desktop app on its own has no instance to ask', async () => {
    (window as { bulwarkDesktop?: unknown }).bulwarkDesktop = { version: 1, platform: 'win32', mode: 'standalone' };
    await wipe.checkInDue(true);
    expect(sent).toEqual([]);
  });

  it('a cleared key database means a new row', async () => {
    respond = () => json(200, { id: ROW, secret: SECRET });
    await wipe.checkInDue(true);
    keys.deleteKeyDatabase();
    respond = () => json(200, { id: BOB_ROW, secret: SECRET });
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

describe('a refused login (lib/offline/credentials-rejected.ts)', () => {
  it('takes everything beyond the store too, and tells the instance why', async () => {
    await openDb('smime-plugin-store');
    respond = (url) => (url.endsWith('/wiped') ? json(200, { ok: true }) : noWipe());
    wipe.registerDeviceWipe();
    rejected.noteCredentialsRejected(ALICE);
    await vi.waitFor(() => expect(sent.some((call) => call.url.endsWith('/wiped'))).toBe(true));
    expect(sent.find((call) => call.url.endsWith('/wiped'))?.body).toMatchObject({ reason: 'rejected', id: ROW });
    await vi.waitFor(async () => expect(await databases()).not.toContain('smime-plugin-store'));
    // The auth store is on its way with its own sign-out.
    expect(useAccountStore.getState().accounts.map((account) => account.id)).toEqual([ALICE]);
  });

  it('names the lost mail, as for any sign-out nobody asked for, and leaves no count note', async () => {
    await queue.queueSend(ALICE, { subject: 'Unsent', to: [] }, { kind: 'email', args: [] });
    const lost = await import('../lost');
    wipe.registerDeviceWipe();
    rejected.noteCredentialsRejected(ALICE);
    await vi.waitFor(() => expect(purge.files).toBeGreaterThan(0));
    await vi.waitFor(() => expect(wipeState.readPendingWipes()).toEqual({}));
    expect(lost.consumeLost()).toEqual(['Unsent']);
    expect(wipeState.consumeWipeNote()).toBeNull();
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

    it.each([
      ['invalid_grant', 'invalid_grant'],
      ['the session limit', 'session_expired'],
    ])('%s fires it and wipes', async (_name, error) => {
      wipe.registerDeviceWipe();
      token(() => json(401, { error, maxHours: 8 }));
      await useAuthStore.getState().refreshAccessToken({ accountId: ALICE });
      expect(heard).toEqual([ALICE]);
      await vi.waitFor(() => expect(purge.files).toBeGreaterThan(0));
    });
  });

  it('a password refused for a day goes, unless it signed in again', async () => {
    const heard: string[] = [];
    rejected.onCredentialsRejected((account) => heard.push(account));
    state.markEvicted(ALICE);
    state.writeEnabled([ALICE]);
    const at = Date.now();
    wipeState.markLoginRefused(ALICE, at);

    await wipe.sweepRefusedLogins(at + wipeState.REFUSED_KEEP_MS - 1000);
    expect(heard).toEqual([]);
    expect(purge.files).toBe(0);

    state.clearEvicted(ALICE);
    await wipe.sweepRefusedLogins(at + wipeState.REFUSED_KEEP_MS + 1000);
    expect(heard).toEqual([]);
    expect(purge.files).toBe(0);
    expect(wipeState.readRefusedLogins()).toEqual({});

    state.markEvicted(ALICE);
    wipeState.markLoginRefused(ALICE, at);
    wipe.registerDeviceWipe();
    await wipe.sweepRefusedLogins(at + wipeState.REFUSED_KEEP_MS + 1000);
    expect(heard).toEqual([ALICE]);
    expect(purge.files).toBeGreaterThan(0);
    expect(state.useOfflineStore.getState().enabled).toEqual([]);
    expect(wipeState.readRefusedLogins()).toEqual({});
  });
});

describe('other windows', () => {
  it('a window showing the wiped account reloads, one showing another stays, and the wiping window keeps going', async () => {
    const reload = vi.fn();
    vi.stubGlobal('location', { ...window.location, reload });
    const stop = wipe.startDeviceWipe();
    const other = new BroadcastChannel('bulwark-device-wipe');

    other.postMessage({ account: BOB });
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(reload).not.toHaveBeenCalled();

    other.postMessage({ account: ALICE });
    await vi.waitFor(() => expect(reload).toHaveBeenCalledTimes(1));

    other.close();
    stop();
    vi.unstubAllGlobals();
    vi.stubGlobal('fetch', vi.fn(async () => noWipe()));
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
