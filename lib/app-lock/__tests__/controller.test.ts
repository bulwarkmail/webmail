import 'fake-indexeddb/auto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { composeSnapshots, registerComposeFlush, registerComposeSnapshot, resetComposeFlushRegistry } from '@/lib/compose-flush-registry';
import { isAppLocked, setAppLockCheck } from '@/lib/desktop/app-lock-state';
import { configureStore, getStore, setStoreBackend, type StorePageHooks } from '@/lib/store/client/api';
import { deleteKeyDatabase, getAccountRecord, openAccountKey } from '@/lib/store/client/keys';
import {
  addOsUnlock,
  appLockHold,
  appLockUntilChoices,
  changeAppLockPin,
  appLockKeyLayers,
  bootAppLock,
  disableAppLock,
  disableHello,
  enableAppLock,
  enableHello,
  forgetEverything,
  getAppLockPhase,
  helloState,
  lockEverywhere,
  onStoreKeyMissing,
  resetAppLockForTests,
  setAppLockTimeout,
  setReloadForTests,
  startAppLock,
  STAY_RETRY_MS,
  storeKeyLayers,
  unlockWithHello,
  unlockWithOs,
  unlockWithPin,
} from '../controller';
import { importLockKey, LOCK_LAYER, lockLayer } from '../crypto';
import { appLockRequired, effectiveTimeout } from '../policy';
import { APP_LOCK_KEY, appLockBootScript, isAppLockedNow, readAppLockFile, setLockedHere } from '../state';
import { createVault, deleteVault, openVaultWithPin, pinBlockedUntil, readVault, rotateVaultKey, sealDraft, VaultExistsError, WrongPinError } from '../vault';

const PIN = 'correct-pin';

// Setting a PIN and unlocking each run PBKDF2 at 600,000 rounds: over 5 s on a busy machine.
vi.setConfig({ testTimeout: 30_000 });

class FakeChannel {
  static open = new Set<FakeChannel>();
  onmessage: ((event: MessageEvent) => void) | null = null;
  constructor(readonly name: string) {
    FakeChannel.open.add(this);
  }
  postMessage(data: unknown): void {
    for (const channel of FakeChannel.open) {
      if (channel !== this && channel.name === this.name) channel.onmessage?.({ data } as MessageEvent);
    }
  }
  close(): void {
    FakeChannel.open.delete(this);
  }
}

class FakeWorker {
  static all: FakeWorker[] = [];
  onmessage: ((event: MessageEvent) => void) | null = null;
  posted: Array<Record<string, unknown>> = [];
  terminated = false;
  constructor() {
    FakeWorker.all.push(this);
    // As the real one does with no other tab around.
    queueMicrotask(() => this.onmessage?.({ data: { kind: 'owner' } } as MessageEvent));
  }
  postMessage(message: Record<string, unknown>): void {
    this.posted.push(message);
    if (message.kind === 'open' || message.kind === 'release' || message.kind === 'prune-files') {
      queueMicrotask(() => this.onmessage?.({ data: { kind: 'result', id: message.id, result: message.kind === 'open' ? { created: false } : undefined } } as MessageEvent));
    }
  }
  terminate(): void {
    this.terminated = true;
  }
}

const hooks: StorePageHooks = {
  inputs: () => ({ session: { apiUrl: 'x' } as never, auth: 'Bearer token', invertedKeywordSort: null }),
  refreshAuth: async () => null,
  onEvent: () => {},
  keyLayers: appLockKeyLayers,
};

let reloads = 0;
let stopTab: () => void = () => {};

function bridge(overrides: Record<string, unknown> = {}) {
  const appLock = {
    status: vi.fn(async () => ({ locked: false, enrolled: true, os: 'hello', osEnrolled: true })),
    lock: vi.fn(),
    enroll: vi.fn(async () => true),
    prove: vi.fn(async () => true),
    disable: vi.fn(async () => true),
    forget: vi.fn(async () => true),
    clearOrphan: vi.fn(async () => true),
    osEnroll: vi.fn(async () => true),
    osRemove: vi.fn(async () => {}),
    osUnlock: vi.fn(async () => ({ ok: false as const, reason: 'denied' as const })),
    onLockRequest: vi.fn(() => () => {}),
    claim: vi.fn(() => ({ lock: appLock.lock, osUnlock: appLock.osUnlock })),
    wrap: vi.fn(async () => null),
    unwrap: vi.fn(async () => null),
    ...overrides,
  };
  (window as unknown as { bulwarkDesktop: unknown }).bulwarkDesktop = { version: 1, platform: 'win32', appLock };
  return appLock;
}

beforeEach(async () => {
  FakeChannel.open.clear();
  FakeWorker.all = [];
  vi.stubGlobal('BroadcastChannel', FakeChannel);
  vi.stubGlobal('Worker', FakeWorker);
  vi.stubGlobal('FileSystemFileHandle', class {});
  vi.stubGlobal('fetch', vi.fn(async () => new Response(null, { status: 200 })));
  Object.defineProperty(window.navigator, 'storage', { configurable: true, value: { getDirectory: async () => ({}) } });
  Object.defineProperty(window.navigator, 'locks', {
    configurable: true,
    value: {
      request: vi.fn(async (_name: string, ...rest: unknown[]) => {
        const run = rest[rest.length - 1] as () => unknown;
        return run();
      }),
      query: vi.fn(async () => ({ held: [], pending: [] })),
    },
  });
  localStorage.clear();
  sessionStorage.clear();
  reloads = 0;
  setReloadForTests(() => { reloads += 1; });
  resetAppLockForTests();
  resetComposeFlushRegistry();
  setStoreBackend(null);
  configureStore(hooks);
  await deleteVault();
  deleteKeyDatabase();
});

afterEach(() => {
  stopTab();
  stopTab = () => {};
  vi.unstubAllGlobals();
  setReloadForTests(null);
  setAppLockCheck(null);
  delete (window as unknown as { bulwarkDesktop?: unknown }).bulwarkDesktop;
  delete (window.navigator as { storage?: unknown }).storage;
  delete (window.navigator as { locks?: unknown }).locks;
  setStoreBackend(null);
  configureStore(null);
  setLockedHere(false);
});

/** A store open under the lock, as a running tab has it. */
async function runningLockedStore(account = 'acc') {
  await enableAppLock(PIN);
  await getStore().ensureOpen(account, { apiUrl: 'x' } as never);
  await vi.waitFor(() => expect(lastWorker().posted.some((m) => m.kind === 'open')).toBe(true));
  return lastWorker();
}

function lastWorker(): FakeWorker {
  return FakeWorker.all[FakeWorker.all.length - 1];
}

async function lockedAndReloaded(): Promise<void> {
  lockEverywhere();
  await vi.waitFor(() => expect(reloads).toBe(1));
}

/** The page a reload gives: new module state, the same storage. */
function asNewDocument(): void {
  resetAppLockForTests();
  bootAppLock();
}

describe('while locked', () => {
  it('the worker with the key is gone, the key with it, and reads fail until unlock', async () => {
    const worker = await runningLockedStore();
    const opened = worker.posted.find((m) => m.kind === 'open') as { params: { keyHex: string } };
    expect(opened.params.keyHex).toMatch(/^[0-9a-f]{64}$/);

    await lockedAndReloaded();

    expect(worker.posted.some((m) => m.kind === 'release')).toBe(true);
    expect(worker.terminated).toBe(true);
    const workers = FakeWorker.all.length;
    await expect(getStore().answer('acc', [])).rejects.toMatchObject({ name: 'StoreLockedError' });
    await expect(getStore().area('acc', 'x.y')).rejects.toMatchObject({ name: 'StoreLockedError' });
    expect(FakeWorker.all.length, 'no new worker while locked').toBe(workers);
    // In this tab's memory too: nothing gives the layer now.
    expect(() => appLockKeyLayers()).toThrow(expect.objectContaining({ name: 'StoreKeyLayerMissingError' }));
    await expect(openAccountKey('acc')).rejects.toMatchObject({ name: 'StoreKeyLayerMissingError' });

    await unlockWithPin(PIN);
    expect(isAppLockedNow()).toBe(false);
    await expect(openAccountKey('acc', appLockKeyLayers())).resolves.toMatchObject({ keyHex: opened.params.keyHex });
  });

  it('a stuck close doesn\'t keep the key: the worker is stopped after the wait', async () => {
    const worker = await runningLockedStore();
    worker.postMessage = function postMessage(message) { this.posted.push(message); };
    await getStore().lock?.(10);
    expect(worker.terminated).toBe(true);
  });

  it('a new start stays closed: the app is held back and nothing has the key', async () => {
    await enableAppLock(PIN);
    await lockedAndReloaded();
    asNewDocument();
    expect(getAppLockPhase()).toBe('locked');
    expect(appLockHold()).toBeInstanceOf(Promise);
    expect(isAppLockedNow()).toBe(true);
  });

  it('a running page isn\'t held back while it saves: composers stay mounted until the reload', async () => {
    await enableAppLock(PIN);
    let holdDuringSave: Promise<void> | null | undefined;
    registerComposeFlush(async () => { holdDuringSave = appLockHold(); });
    await lockedAndReloaded();
    expect(holdDuringSave).toBeNull();
  });

  it('the check the OS code asks follows the lock both ways', async () => {
    expect(isAppLocked()).toBe(false);
    await enableAppLock(PIN);
    asNewDocument();
    expect(isAppLocked()).toBe(true);
    await unlockWithPin(PIN);
    expect(isAppLocked()).toBe(false);
  });

  it('a start that finds the app locked takes subjects out of storage too: a quit or a crash left them there', async () => {
    await enableAppLock(PIN);
    await lockedAndReloaded();
    localStorage.setItem('email-snapshot', '{"emails":[{"subject":"Secret"}]}');
    localStorage.setItem('contact-storage', '{"state":{"contacts":[{"name":"Secret Person"}]}}');
    localStorage.setItem('notification-center', '[{"title":"Secret notice"}]');
    asNewDocument();
    await vi.waitFor(() => expect(JSON.stringify({ ...localStorage })).not.toContain('Secret'));
  });

  it('so does a start after a crash while unlocked, once it finds nobody holds the key', async () => {
    await enableAppLock(PIN);
    resetAppLockForTests();
    localStorage.setItem('email-snapshot', '{"emails":[{"subject":"Secret"}]}');
    localStorage.setItem('notification-center', '[{"title":"Secret notice"}]');
    bootAppLock();
    await vi.waitFor(() => expect(getAppLockPhase()).toBe('locked'));
    await vi.waitFor(() => expect(JSON.stringify({ ...localStorage })).not.toContain('Secret'));
  });

  it('a start where another tab holds the key leaves storage alone', async () => {
    await enableAppLock(PIN);
    resetAppLockForTests();
    localStorage.setItem('email-snapshot', '{"emails":[{"subject":"Kept"}]}');
    (window.navigator.locks.query as ReturnType<typeof vi.fn>).mockResolvedValue({ held: [{ name: 'bulwark-app-lock-holder' }], pending: [] });
    (window.navigator.locks.request as ReturnType<typeof vi.fn>).mockImplementation(() => new Promise(() => {}));
    bootAppLock();
    await vi.waitFor(() => expect(getAppLockPhase()).toBe('open'));
    expect(localStorage.getItem('email-snapshot')).toContain('Kept');
  });

  it('contacts and notifications come back at unlock, sealed while locked', async () => {
    await enableAppLock(PIN);
    localStorage.setItem('contact-storage', '{"state":{"contacts":[{"name":"Secret Person"}]},"version":0}');
    localStorage.setItem('notification-center', JSON.stringify([{ id: 'n', time: 1, level: 'info', title: 'Secret notice', body: '', read: false }]));
    await lockedAndReloaded();
    expect(JSON.stringify({ ...localStorage })).not.toContain('Secret');
    await unlockWithPin(PIN);
    expect(localStorage.getItem('contact-storage')).toContain('Secret Person');
    expect(localStorage.getItem('notification-center')).toContain('Secret notice');
    const { useNotificationCenterStore } = await import('@/stores/notification-center-store');
    expect(useNotificationCenterStore.getState().entries.map((entry) => entry.title)).toContain('Secret notice');
  });

  it('a newer copy replaces the sealed one instead of piling up', async () => {
    await enableAppLock(PIN);
    localStorage.setItem('notification-center', '[{"id":"n","title":"Old notice"}]');
    await lockedAndReloaded();
    localStorage.setItem('notification-center', '[{"id":"n","title":"New notice"}]');
    asNewDocument();
    await vi.waitFor(() => expect(localStorage.getItem('notification-center')).toBeNull());
    await unlockWithPin(PIN);
    expect(localStorage.getItem('notification-center')).toContain('New notice');
  });

  it('a browser closed without locking counts as locked: nobody holds the key', async () => {
    await enableAppLock(PIN);
    resetAppLockForTests();
    expect(readAppLockFile().locked).toBe(false);
    bootAppLock();
    expect(getAppLockPhase()).toBe('checking');
    await vi.waitFor(() => expect(getAppLockPhase()).toBe('locked'));
    expect(readAppLockFile().locked).toBe(true);
  });

  it('another tab holding the key lets this one start without any key', async () => {
    await enableAppLock(PIN);
    resetAppLockForTests();
    (window.navigator.locks.query as ReturnType<typeof vi.fn>).mockResolvedValue({ held: [{ name: 'bulwark-app-lock-holder' }], pending: [] });
    // Held elsewhere: a request for it waits.
    (window.navigator.locks.request as ReturnType<typeof vi.fn>).mockImplementation(() => new Promise(() => {}));
    bootAppLock();
    await vi.waitFor(() => expect(getAppLockPhase()).toBe('open'));
    expect(() => appLockKeyLayers()).toThrow(expect.objectContaining({ name: 'StoreKeyLayerMissingError' }));
  });
});

describe('locking', () => {
  it('saves what is being written before the store closes', async () => {
    const worker = await runningLockedStore();
    const order: string[] = [];
    registerComposeFlush(async () => { order.push(worker.terminated ? 'saved after close' : 'saved'); });
    await lockedAndReloaded();
    expect(order).toEqual(['saved']);
  });

  it('seals text the server didn\'t take, and it comes back only after unlock', async () => {
    await enableAppLock(PIN);
    registerComposeFlush(async () => { throw new Error('offline'); });
    registerComposeSnapshot({ ownWindow: false, state: () => ({ subject: 'Unsaved secret', unsaved: true }) as never, draft: () => null });
    await lockedAndReloaded();
    expect(JSON.stringify({ ...localStorage })).not.toContain('Unsaved secret');
    expect(JSON.stringify({ ...sessionStorage })).not.toContain('Unsaved secret');
    await unlockWithPin(PIN);
    await vi.waitFor(() => expect(sessionStorage.getItem('bulwark-rescued-drafts')).toContain('Unsaved secret'));
  });

  it('takes subjects out of plain browser storage', async () => {
    await enableAppLock(PIN);
    localStorage.setItem('email-snapshot', '{"emails":[{"subject":"Secret"}]}');
    localStorage.setItem('pro-tabs', '{"tabs":[{"title":"Secret"}]}');
    sessionStorage.setItem('bulwark-popout-compose:h1', '{"initialData":{"subject":"Secret"}}');
    await lockedAndReloaded();
    expect(localStorage.getItem('email-snapshot')).toBeNull();
    expect(localStorage.getItem('pro-tabs')).toBeNull();
    expect(sessionStorage.getItem('bulwark-popout-compose:h1')).toBeNull();
  });

  it('points a composer window at its saved draft, so nothing of the text stays in its address or session', async () => {
    await enableAppLock(PIN);
    registerComposeSnapshot({ ownWindow: true, state: () => ({ subject: 'x' }) as never, draft: () => ({ draftId: 'd7', localAccountId: 'alice' }) });
    await lockedAndReloaded();
    expect(window.location.search).toContain('draft=d7');
    expect(sessionStorage.getItem('bulwark-app-lock-drafts-saved')).toBe('1');
    expect(composeSnapshots()).toHaveLength(1);
    window.history.replaceState(null, '', '/');
  });

  it('reaches this tab from another, by the channel', async () => {
    await enableAppLock(PIN);
    stopTab = startAppLock();
    new FakeChannel('bulwark:app-lock').postMessage({ type: 'lock' });
    await vi.waitFor(() => expect(reloads).toBe(1));
    expect(isAppLockedNow()).toBe(true);
  });

  it('when the server is out of reach it stays on the page, off the screen, and reloads when it can', async () => {
    (fetch as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('offline'));
    await enableAppLock(PIN);
    lockEverywhere();
    await vi.waitFor(() => expect(getAppLockPhase()).toBe('locked-stay'));
    expect(reloads).toBe(0);
    (fetch as ReturnType<typeof vi.fn>).mockResolvedValue(new Response(null, { status: 200 }));
    window.dispatchEvent(new Event('online'));
    await vi.waitFor(() => expect(reloads).toBe(1));
  });

  it('asks in a way the service worker can answer: a GET that it knows is this probe', async () => {
    await enableAppLock(PIN);
    await lockedAndReloaded();
    const [, init] = (fetch as ReturnType<typeof vi.fn>).mock.calls.at(-1) as [string, RequestInit];
    expect(init.method).toBe('GET');
    expect(new Headers(init.headers).get('x-bulwark-reload-probe')).toBe('1');
  });

  it('a 5xx counts as out of reach: a reload would land on the error page', async () => {
    (fetch as ReturnType<typeof vi.fn>).mockResolvedValue(new Response(null, { status: 503 }));
    await enableAppLock(PIN);
    lockEverywhere();
    await vi.waitFor(() => expect(getAppLockPhase()).toBe('locked-stay'));
    expect(reloads).toBe(0);
  });

  it('keeps trying on a timer: nothing says "online" when only the server was down', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    try {
      (fetch as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('down'));
      await enableAppLock(PIN);
      lockEverywhere();
      await vi.waitFor(() => expect(getAppLockPhase()).toBe('locked-stay'));
      vi.advanceTimersByTime(STAY_RETRY_MS);
      await new Promise((resolve) => setTimeout(resolve, 10));
      expect(reloads, 'still down').toBe(0);
      (fetch as ReturnType<typeof vi.fn>).mockResolvedValue(new Response(null, { status: 200 }));
      vi.advanceTimersByTime(STAY_RETRY_MS);
      await vi.waitFor(() => expect(reloads).toBe(1));
    } finally {
      vi.useRealTimers();
    }
  });

  it('a pop-out that unlocks with no main window leaves sealed drafts sealed, for the main window', async () => {
    await enableAppLock(PIN);
    await sealDraft({ subject: 'Sealed text' });
    await lockedAndReloaded();
    window.history.replaceState(null, '', '/popout/compose');
    try {
      asNewDocument();
      await unlockWithPin(PIN);
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(sessionStorage.getItem('bulwark-rescued-drafts')).toBeNull();
    } finally {
      window.history.replaceState(null, '', '/');
    }
    lockEverywhere();
    asNewDocument();
    await unlockWithPin(PIN);
    await vi.waitFor(() => expect(sessionStorage.getItem('bulwark-rescued-drafts')).toContain('Sealed text'));
  });
});

describe('an unlock stays an unlock', () => {
  /** The page a lock reloads into: new module state, a new store, and offline mode not loaded yet. */
  async function lockedNewDocument(): Promise<void> {
    await runningLockedStore();
    await lockedAndReloaded();
    asNewDocument();
    setStoreBackend(null);
    configureStore(null);
    reloads = 0;
  }

  it('the store opens under the lock when the app asks before offline mode has loaded, and nothing locks again', async () => {
    await lockedNewDocument();
    await unlockWithPin(PIN);
    const opening = getStore().ensureOpen('acc', { apiUrl: 'x' } as never).catch(() => {});
    // Offline mode loads after the app starts, while the key is being read.
    configureStore({ ...hooks, onKeyLocked: onStoreKeyMissing });
    await opening;
    await vi.waitFor(() => expect(lastWorker().posted.some((m) => m.kind === 'open')).toBe(true));
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(readAppLockFile().locked).toBe(false);
    expect(getAppLockPhase()).toBe('open');
    expect(reloads).toBe(0);
  });

  it('nothing automatic locks again before the timeout has run, and a lock that soon is an error', async () => {
    await lockedNewDocument();
    configureStore(hooks);
    await unlockWithPin(PIN);
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      // The tab with the key told it had none: a bug, and it must not lock the user out.
      onStoreKeyMissing();
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(readAppLockFile().locked).toBe(false);
      expect(reloads).toBe(0);
      expect(errors).toHaveBeenCalledWith(expect.stringContaining('[app-lock]'));

      // The user's own lock goes through at once, and says it came quickly.
      errors.mockClear();
      lockEverywhere();
      await vi.waitFor(() => expect(reloads).toBe(1));
      expect(readAppLockFile().locked).toBe(true);
      expect(errors).toHaveBeenCalledWith(expect.stringContaining('[app-lock]'));
    } finally {
      errors.mockRestore();
    }
  });

  it('past the timeout the automatic locks work again', async () => {
    await lockedNewDocument();
    configureStore(hooks);
    const now = Date.now();
    const clock = vi.spyOn(Date, 'now').mockReturnValue(now);
    try {
      await unlockWithPin(PIN);
      clock.mockReturnValue(now + effectiveTimeout(undefined).minutes * 60_000 + 1);
      onStoreKeyMissing();
      await vi.waitFor(() => expect(reloads).toBe(1));
      expect(readAppLockFile().locked).toBe(true);
    } finally {
      clock.mockRestore();
    }
  });
});

describe('the store when a tab inherits it without the key', () => {
  it('asks for the lock instead of opening, or writing a key outside the layer', async () => {
    await enableAppLock(PIN);
    // This tab has no key: the one that had it went.
    resetAppLockForTests();
    (window.navigator.locks.query as ReturnType<typeof vi.fn>).mockResolvedValue({ held: [{ name: 'bulwark-app-lock-holder' }], pending: [] });
    (window.navigator.locks.request as ReturnType<typeof vi.fn>).mockImplementation(() => new Promise(() => {}));
    bootAppLock();
    await vi.waitFor(() => expect(getAppLockPhase()).toBe('open'));
    // The lock answers for itself: offline mode's hooks aren't asked about the key.
    const onKeyLocked = vi.fn();
    configureStore({ ...hooks, onKeyLocked });
    await getStore().ensureOpen('new-account', { apiUrl: 'x' } as never).catch(() => {});
    await vi.waitFor(() => expect(readAppLockFile().locked).toBe(true));
    expect(onKeyLocked).not.toHaveBeenCalled();
    expect(await getAccountRecord('new-account')).toBeNull();
    expect(lastWorker().posted.some((m) => m.kind === 'open')).toBe(false);
  });

  it('a new account after unlock gets its key under the lock', async () => {
    await enableAppLock(PIN);
    await getStore().ensureOpen('new-account', { apiUrl: 'x' } as never);
    await vi.waitFor(async () => expect((await getAccountRecord('new-account'))?.layers).toEqual(['applock']));
  });
});

describe('the desktop app\'s safeStorage on the store\'s key', () => {
  const shellBridge = () => bridge({
    status: vi.fn(async () => ({ locked: false, enrolled: true, os: null, osEnrolled: false, wrap: true })),
    wrap: vi.fn(async (data: Uint8Array) => Uint8Array.from([9, ...data])),
    unwrap: vi.fn(async (data: Uint8Array) => (data[0] === 9 ? data.slice(1) : null)),
  });

  it('wraps with the lock off too', async () => {
    shellBridge();
    const layers = await storeKeyLayers();
    expect(layers.map((layer) => layer.name)).toEqual(['safeStorage']);
    await openAccountKey('off', layers);
    expect((await getAccountRecord('off'))?.layers).toEqual(['safeStorage']);
  });

  it('a browser has no such layer', async () => {
    expect(await storeKeyLayers()).toEqual([]);
  });

  it('a shell whose storage only obfuscates has none either', async () => {
    bridge({ status: vi.fn(async () => ({ locked: false, enrolled: false, os: null, osEnrolled: false, wrap: false })) });
    expect(await storeKeyLayers()).toEqual([]);
  });

  it('turning the lock on asks for the mail to be re-encrypted; off again keeps the OS\'s layer', async () => {
    shellBridge();
    await openAccountKey('acc', await storeKeyLayers());
    await enableAppLock(PIN);
    let stored = await getAccountRecord('acc');
    expect(stored?.layers).toEqual(['safeStorage', 'applock']);
    expect(stored?.rekey).toBe(true);
    await disableAppLock(PIN);
    stored = await getAccountRecord('acc');
    expect(stored?.layers).toEqual(['safeStorage']);
  });
});

describe('changing the PIN', () => {
  it('makes a new lock key, so what an old copy of the PIN record opens opens nothing now', async () => {
    await openAccountKey('acc');
    await enableAppLock(PIN);
    const before = await readVault();
    const oldKey = await importLockKey(await openVaultWithPin(PIN));
    await changeAppLockPin(PIN, 'next-pin-5521');
    const record = await getAccountRecord('acc');
    expect(record?.layers).toEqual(['applock']);
    expect(record?.rekey).toBe(true);
    // Under the old lock key the record opens no more.
    await expect(lockLayer(oldKey).unwrap(record!.wrapped)).rejects.toBeDefined();
    expect((await readVault())?.pin.data).not.toEqual(before?.pin.data);
    expect((await readVault())?.previous).toBeUndefined();
    await expect(openVaultWithPin(PIN)).rejects.toBeInstanceOf(WrongPinError);
    // The store still opens, in this tab, with the key it holds now.
    await expect(openAccountKey('acc', appLockKeyLayers())).resolves.toMatchObject({ fresh: false });
  });

  it('survives a crash halfway: a record under the old key moves over at the next unlock', async () => {
    await openAccountKey('acc');
    await enableAppLock(PIN);
    const oldRaw = await openVaultWithPin(PIN);
    await rotateVaultKey('next-pin-5521', oldRaw);
    await lockedAndReloaded();
    await unlockWithPin('next-pin-5521');
    expect((await readVault())?.previous).toBeUndefined();
    await expect(openAccountKey('acc', appLockKeyLayers())).resolves.toMatchObject({ fresh: false });
    expect((await getAccountRecord('acc'))?.rekey).toBe(true);
  });

  it('the passkey and the OS\'s unlock wrapped the old key: they go, and the caller hears', async () => {
    const appLock = bridge({ status: vi.fn(async () => ({ locked: false, enrolled: true, os: 'hello', osEnrolled: true, wrap: false })) });
    await enableAppLock(PIN);
    const { reenroll } = await changeAppLockPin(PIN, 'next-pin-5521');
    expect(reenroll).toBe(true);
    expect((await readVault())?.prf).toBeUndefined();
    expect(appLock.disable).toHaveBeenCalledTimes(1);
    expect(appLock.enroll).toHaveBeenCalledTimes(2);
  });
});

describe('the renderer at a lock', () => {
  it('is replaced in the desktop app: a reload stays in the process with the old heap', async () => {
    const replaceRenderer = vi.fn();
    const appLock = bridge();
    appLock.claim = vi.fn(() => ({ lock: appLock.lock, osUnlock: appLock.osUnlock, replaceRenderer })) as never;
    setReloadForTests(null);
    const reload = vi.fn();
    Object.defineProperty(window, 'location', { configurable: true, value: { ...window.location, reload, href: window.location.href, origin: window.location.origin } });
    await enableAppLock(PIN);
    stopTab = startAppLock();
    lockEverywhere();
    await vi.waitFor(() => expect(replaceRenderer).toHaveBeenCalledTimes(1));
    expect(reload).not.toHaveBeenCalled();
  });
});

describe('the desktop app', () => {
  const settled = () => new Promise((resolve) => setTimeout(resolve, 50));

  it('asks main to clear a lock this profile has no PIN for', async () => {
    const appLock = bridge({ status: vi.fn(async () => ({ locked: true, enrolled: true, os: null, osEnrolled: false })) });
    bootAppLock();
    await settled();
    expect(appLock.clearOrphan).toHaveBeenCalledTimes(1);
    expect(appLock.forget).not.toHaveBeenCalled();
  });

  it('leaves main alone when there is a vault, so a real lock is never questioned', async () => {
    const raw = await createVault(PIN);
    raw.fill(0);
    const appLock = bridge({ status: vi.fn(async () => ({ locked: true, enrolled: true, os: null, osEnrolled: false })) });
    bootAppLock();
    await settled();
    expect(appLock.clearOrphan).not.toHaveBeenCalled();
  });

  it('asks nothing when main has no lock', async () => {
    const appLock = bridge({ status: vi.fn(async () => ({ locked: false, enrolled: false, os: null, osEnrolled: false })) });
    bootAppLock();
    await settled();
    expect(appLock.clearOrphan).not.toHaveBeenCalled();
  });

  it('a PIN unlock proves itself to main, and nothing can just say unlocked', async () => {
    const appLock = bridge();
    await enableAppLock(PIN);
    expect(appLock.enroll).toHaveBeenCalledTimes(1);
    const proof = appLock.enroll.mock.calls[0][0 as never] as unknown as Uint8Array;
    await lockedAndReloaded();
    expect(appLock.lock).toHaveBeenCalled();
    await unlockWithPin(PIN);
    expect(appLock.prove).toHaveBeenCalledTimes(1);
    expect(Array.from(appLock.prove.mock.calls[0][0 as never] as unknown as Uint8Array)).toEqual(Array.from(proof));
  });

  it('the screen locking locks the app', async () => {
    let request: () => void = () => {};
    bridge({ onLockRequest: vi.fn((listener: () => void) => { request = listener; return () => {}; }) });
    await enableAppLock(PIN);
    stopTab = startAppLock();
    request();
    await vi.waitFor(() => expect(reloads).toBe(1));
    expect(readAppLockFile().locked).toBe(true);
  });

  it('"when I sign out or restart" has no timeout and tells main to skip the screen lock; a timeout again undoes both', async () => {
    const setScreenLock = vi.fn(async () => true);
    const appLock = bridge();
    appLock.claim = vi.fn(() => ({ lock: appLock.lock, osUnlock: appLock.osUnlock, setScreenLock })) as never;
    expect(appLockUntilChoices()).toEqual(['screen', 'session']);
    // Before the lock goes on: the idle watcher keeps the clock it started with.
    const now = Date.now();
    const clock = vi.spyOn(Date, 'now').mockReturnValue(now);
    try {
      await enableAppLock(PIN);
      setAppLockTimeout('session');
      expect(setScreenLock).toHaveBeenLastCalledWith(false);
      expect(readAppLockFile().until).toBe('session');
      clock.mockReturnValue(now + 24 * 60 * 60_000);
      window.dispatchEvent(new Event('pointerdown'));
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(reloads).toBe(0);
      expect(readAppLockFile().locked).toBe(false);

      setAppLockTimeout(5);
      expect(setScreenLock).toHaveBeenLastCalledWith(true);
      expect(readAppLockFile().until).toBeUndefined();
      clock.mockReturnValue(now + 24 * 60 * 60_000 + 6 * 60_000);
      window.dispatchEvent(new Event('pointerdown'));
      await vi.waitFor(() => expect(reloads).toBe(1));
    } finally {
      clock.mockRestore();
    }
  });

  it('"when the screen locks" leaves main locking on it and needs no new shell; Linux has only the other', () => {
    const setScreenLock = vi.fn(async () => true);
    const appLock = bridge();
    appLock.claim = vi.fn(() => ({ lock: appLock.lock, osUnlock: appLock.osUnlock, setScreenLock })) as never;
    setAppLockTimeout('screen');
    expect(setScreenLock).toHaveBeenLastCalledWith(true);
    // An older shell can't be told to skip it.
    bridge();
    expect(appLockUntilChoices()).toEqual(['screen']);
    (window as unknown as { bulwarkDesktop: { platform: string } }).bulwarkDesktop.platform = 'linux';
    expect(appLockUntilChoices()).toEqual(['session']);
    delete (window as unknown as { bulwarkDesktop?: unknown }).bulwarkDesktop;
    expect(appLockUntilChoices()).toEqual([]);
  });

  it('a page in a tab can\'t lift a lock main still holds', async () => {
    const appLock = bridge({ status: vi.fn(async () => ({ locked: true, enrolled: true, os: null, osEnrolled: false })) });
    await enableAppLock(PIN);
    resetAppLockForTests();
    bootAppLock();
    stopTab = startAppLock();
    await vi.waitFor(() => expect(getAppLockPhase()).toBe('locked'));
    new FakeChannel('bulwark:app-lock').postMessage({ type: 'unlocked' });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(appLock.status).toHaveBeenCalled();
    expect(getAppLockPhase()).toBe('locked');
  });

  it('Windows Hello\'s yes opens with the key main hands over', async () => {
    let held: Uint8Array | null = null;
    const appLock = bridge({
      osEnroll: vi.fn(async (_proof: Uint8Array, key: Uint8Array) => { held = key.slice(); return true; }),
      osUnlock: vi.fn(async () => ({ ok: true as const, key: held! })),
    });
    await runningLockedStore();
    expect(await addOsUnlock(PIN)).toBe(true);
    await lockedAndReloaded();
    expect(await unlockWithOs()).toBe(true);
    expect(appLock.osUnlock).toHaveBeenCalledTimes(1);
    expect(isAppLockedNow()).toBe(false);
    await expect(openAccountKey('acc', appLockKeyLayers())).resolves.toBeDefined();
  });

  it('wrong bytes from main open nothing', async () => {
    bridge({ osUnlock: vi.fn(async () => ({ ok: true as const, key: new Uint8Array(32).fill(1) })) });
    await runningLockedStore();
    await lockedAndReloaded();
    await unlockWithOs().catch(() => false);
    await expect(openAccountKey('acc', appLockKeyLayers())).rejects.toBeDefined();
  });

  it('Windows Hello\'s no leaves it locked, and the PIN still works', async () => {
    const appLock = bridge();
    await enableAppLock(PIN);
    await lockedAndReloaded();
    expect(await unlockWithOs()).toBe(false);
    expect(appLock.osUnlock).toHaveBeenCalled();
    expect(isAppLockedNow()).toBe(true);
    await unlockWithPin(PIN);
    expect(isAppLockedNow()).toBe(false);
  });

  it('tells the OS integration when it locks, and its check says so until the unlock', async () => {
    bridge();
    const setLocked = vi.fn();
    (window as unknown as { bulwarkDesktop: Record<string, unknown> }).bulwarkDesktop.os = { setLocked };
    await enableAppLock(PIN);
    expect(setLocked).not.toHaveBeenCalled();
    await lockedAndReloaded();
    expect(setLocked).toHaveBeenCalledWith(true);
    setLocked.mockClear();
    asNewDocument();
    expect(setLocked, 'a new page behind the lock says so at once').toHaveBeenCalledWith(true);
    expect(isAppLocked()).toBe(true);
    await unlockWithPin(PIN);
    // What components/desktop/desktop-os-host.tsx tells main as the app starts.
    expect(isAppLocked()).toBe(false);
  });

  it('a page takes the two calls a frame must not reach once, before any frame runs', async () => {
    const appLock = bridge();
    bootAppLock();
    expect(appLock.claim).toHaveBeenCalledTimes(1);
    await enableAppLock(PIN);
    await lockedAndReloaded();
    expect(appLock.lock).toHaveBeenCalled();
  });

  it('a claim someone else got first leaves this page with no OS unlock, and the PIN working', async () => {
    const appLock = bridge({ claim: vi.fn(() => null) });
    await enableAppLock(PIN);
    await lockedAndReloaded();
    expect(await unlockWithOs()).toBe(false);
    expect(appLock.osUnlock).not.toHaveBeenCalled();
    await unlockWithPin(PIN);
    expect(isAppLockedNow()).toBe(false);
  });

  it('a no from main on a good PIN isn\'t ignored: it enrolls again, and is unlocked', async () => {
    const appLock = bridge();
    await enableAppLock(PIN);
    await lockedAndReloaded();
    appLock.enroll.mockClear();
    appLock.prove.mockResolvedValue(false as never);
    await unlockWithPin(PIN);
    expect(appLock.enroll).toHaveBeenCalledTimes(1);
    expect(isAppLockedNow()).toBe(false);
  });

  it('main keeps an older lock: it asks natively, and only a yes replaces it', async () => {
    const appLock = bridge();
    await enableAppLock(PIN);
    await lockedAndReloaded();
    appLock.prove.mockResolvedValue(false as never);
    appLock.enroll.mockResolvedValueOnce(false as never);
    appLock.forget.mockResolvedValueOnce(false as never);
    await expect(unlockWithPin(PIN)).rejects.toThrow();
    expect(isAppLockedNow(), 'main still locked, so the page is').toBe(true);
    expect(appLock.enroll).toHaveBeenCalledTimes(2);

    appLock.enroll.mockResolvedValueOnce(false as never);
    appLock.forget.mockResolvedValueOnce(true as never);
    appLock.enroll.mockResolvedValueOnce(true as never);
    await unlockWithPin(PIN);
    expect(isAppLockedNow()).toBe(false);
  });

  it('turning it off with main refusing the proof: it asks, and a no leaves everything on', async () => {
    const appLock = bridge({ disable: vi.fn(async () => false), forget: vi.fn(async () => false) });
    await openAccountKey('acc');
    await enableAppLock(PIN);
    await expect(disableAppLock(PIN)).rejects.toThrow();
    expect(readAppLockFile().on).toBe(true);
    expect((await getAccountRecord('acc'))?.layers).toEqual(['applock']);
    expect(await readVault()).not.toBeNull();
    appLock.forget.mockResolvedValue(true);
    await disableAppLock(PIN);
    expect(readAppLockFile().on).toBe(false);
  });

  it('turning it off when main has no lock at all just goes on', async () => {
    bridge({
      disable: vi.fn(async () => false),
      forget: vi.fn(async () => false),
      status: vi.fn(async () => ({ locked: false, enrolled: false, os: null, osEnrolled: false })),
    });
    await enableAppLock(PIN);
    await disableAppLock(PIN);
    expect(readAppLockFile().on).toBe(false);
  });

  it('a sign-out in the tab with the key shows main the proof, so nothing asks', async () => {
    const appLock = bridge();
    await enableAppLock(PIN);
    const proof = appLock.enroll.mock.calls[0][0 as never] as unknown as Uint8Array;
    const { forgetAppLockAtSignOut } = await import('../sign-out');
    await forgetAppLockAtSignOut();
    expect(Array.from(appLock.forget.mock.calls[0][0 as never] as unknown as Uint8Array)).toEqual(Array.from(proof));
    expect(await readVault()).toBeNull();
  });

  it('a record with main\'s safeStorage layer opens, and keeps it under the lock', async () => {
    bridge({
      status: vi.fn(async () => ({ locked: false, enrolled: true, os: null, osEnrolled: false, wrap: true })),
      wrap: vi.fn(async (data: Uint8Array) => Uint8Array.from([7, ...data])),
      unwrap: vi.fn(async (data: Uint8Array) => (data[0] === 7 ? data.slice(1) : null)),
    });
    const safe = {
      name: 'safeStorage',
      wrap: async (data: Uint8Array) => Uint8Array.from([7, ...data]),
      unwrap: async (data: Uint8Array) => data.slice(1),
    };
    const { keyHex } = await openAccountKey('acc', [safe]);
    await enableAppLock(PIN);
    expect((await getAccountRecord('acc'))?.layers).toEqual(['safeStorage', LOCK_LAYER]);
    await expect(openAccountKey('acc', appLockKeyLayers())).resolves.toMatchObject({ keyHex });
    // Off, only the lock's own layer goes: the OS's stays on with no lock too.
    await disableAppLock(PIN);
    expect((await getAccountRecord('acc'))?.layers).toEqual(['safeStorage']);
  });

  it('forgetting asks main first: a no changes nothing', async () => {
    const appLock = bridge({ forget: vi.fn(async () => false) });
    await enableAppLock(PIN);
    await lockedAndReloaded();
    expect(await forgetEverything()).toBe(false);
    expect(appLock.forget).toHaveBeenCalled();
    expect(readAppLockFile()).toMatchObject({ on: true, locked: true });
  });
});

describe('a start with no lock file', () => {
  /** Runs the head script of app/(main)/layout.tsx and waits until its look has answered. */
  async function headScript(): Promise<void> {
    const databases = vi.spyOn(indexedDB, 'databases');
    new Function(appLockBootScript())();
    await databases.mock.results[0]?.value;
    await Promise.resolve();
    databases.mockRestore();
  }

  afterEach(() => {
    delete (window as unknown as Record<string, unknown>).__bulwarkNoAppLockVault;
  });

  it('holds nothing back once the head script found no vault: the app starts in the first render', async () => {
    await headScript();
    bootAppLock();
    expect(appLockHold()).toBeNull();
    expect(getAppLockPhase()).toBe('open');
    expect(isAppLockedNow()).toBe(false);
  });

  it('still waits for the look when the head script has no answer yet', async () => {
    bootAppLock();
    expect(appLockHold()).toBeInstanceOf(Promise);
    expect(getAppLockPhase()).toBe('checking');
    await vi.waitFor(() => expect(appLockHold()).toBeNull());
    expect(getAppLockPhase()).toBe('open');
  });

  it('a lost file with a vault still locks: the head script doesn\'t let that start through', async () => {
    await enableAppLock(PIN);
    localStorage.removeItem(APP_LOCK_KEY);
    resetAppLockForTests();
    await headScript();
    bootAppLock();
    expect(appLockHold()).toBeInstanceOf(Promise);
    await vi.waitFor(() => expect(getAppLockPhase()).toBe('locked'));
    expect(readAppLockFile().on).toBe(true);
    expect(isAppLockedNow()).toBe(true);
  });

  it('a lock file on means no look at all: the first frame already knows', async () => {
    localStorage.setItem(APP_LOCK_KEY, JSON.stringify({ on: true, locked: true }));
    const databases = vi.spyOn(indexedDB, 'databases');
    new Function(appLockBootScript())();
    expect(databases).not.toHaveBeenCalled();
    expect(document.documentElement.hasAttribute('data-app-locked')).toBe(true);
    databases.mockRestore();
    document.documentElement.removeAttribute('data-app-locked');
  });

  it('a look that fails says nothing, and the start waits for its own', async () => {
    const databases = vi.spyOn(indexedDB, 'databases').mockRejectedValue(new Error('blocked'));
    new Function(appLockBootScript())();
    await databases.mock.results[0].value.catch(() => {});
    databases.mockRestore();
    bootAppLock();
    expect(appLockHold()).toBeInstanceOf(Promise);
    await vi.waitFor(() => expect(appLockHold()).toBeNull());
  });

  it('a required lock still waits for its PIN, vault or no vault', async () => {
    await headScript();
    bridge();
    (window as unknown as { bulwarkDesktop: Record<string, unknown> }).bulwarkDesktop.policy = {
      get: () => ({
        AppLockRequired: { value: true, locked: true, source: 'forced-machine' },
        AppLockTimeoutMinutes: { value: null, locked: false, source: 'default' },
      }),
      onChange: () => () => {},
    };
    localStorage.setItem('account-registry', JSON.stringify({ state: { accounts: [{ id: 'a' }] } }));
    bootAppLock();
    expect(getAppLockPhase()).toBe('setup');
    expect(appLockHold()).toBeInstanceOf(Promise);
  });
});

describe('policy', () => {
  function withPolicy(required: { value: boolean; locked: boolean }, minutes: { value: number | null; locked: boolean } = { value: null, locked: false }) {
    const appLock = bridge();
    (window as unknown as { bulwarkDesktop: Record<string, unknown> }).bulwarkDesktop.policy = {
      get: () => ({
        AppLockRequired: { ...required, source: 'forced-machine' },
        AppLockTimeoutMinutes: { ...minutes, source: minutes.locked ? 'forced-machine' : 'default' },
      }),
      onChange: () => () => {},
    };
    return appLock;
  }

  it('a forced policy requires it: a signed-in start waits for a PIN', () => {
    withPolicy({ value: true, locked: true });
    localStorage.setItem('account-registry', JSON.stringify({ state: { accounts: [{ id: 'a' }] } }));
    expect(appLockRequired()).toBe(true);
    bootAppLock();
    expect(getAppLockPhase()).toBe('setup');
    expect(appLockHold()).toBeInstanceOf(Promise);
  });

  it('a required lock doesn\'t stand in front of the login page', async () => {
    withPolicy({ value: true, locked: true });
    bootAppLock();
    await vi.waitFor(() => expect(appLockHold()).toBeNull());
    expect(getAppLockPhase()).toBe('open');
  });

  it('a recommended policy requires nothing', () => {
    withPolicy({ value: true, locked: false });
    expect(appLockRequired()).toBe(false);
  });

  it('a required lock can\'t be turned off', async () => {
    await enableAppLock(PIN);
    withPolicy({ value: true, locked: true });
    await expect(disableAppLock(PIN)).rejects.toThrow();
    expect(readAppLockFile().on).toBe(true);
  });

  it('setting up the required PIN lets the app go on', async () => {
    withPolicy({ value: true, locked: true });
    localStorage.setItem('account-registry', JSON.stringify({ state: { accounts: [{ id: 'a' }] } }));
    bootAppLock();
    const hold = appLockHold();
    await enableAppLock(PIN);
    await expect(hold).resolves.toBeUndefined();
    expect(getAppLockPhase()).toBe('open');
  });

  it('a forced timeout wins over the user\'s choice, a recommended one only over no choice', () => {
    withPolicy({ value: false, locked: false }, { value: 3, locked: true });
    expect(effectiveTimeout(60)).toEqual({ minutes: 3, locked: true });
    // No way around a forced timeout with a desktop event either.
    expect(effectiveTimeout(60, 'session')).toEqual({ minutes: 3, locked: true });
    // A value nobody could read: the user's choice was never what the admin meant.
    (window.bulwarkDesktop as unknown as { policy: { get(): unknown } }).policy.get = () => ({ AppLockTimeoutMinutes: { value: null, locked: true, source: 'forced-machine', invalid: 'out_of_range' } });
    expect(effectiveTimeout(60)).toEqual({ minutes: 1, locked: true });
    withPolicy({ value: false, locked: false }, { value: 3, locked: false });
    expect(effectiveTimeout(60)).toEqual({ minutes: 60, locked: false });
    expect(effectiveTimeout(60, 'screen')).toEqual({ minutes: 60, locked: false, until: 'screen' });
    expect(effectiveTimeout(undefined)).toEqual({ minutes: 3, locked: false });
    delete (window as unknown as { bulwarkDesktop?: unknown }).bulwarkDesktop;
    expect(effectiveTimeout(undefined)).toEqual({ minutes: 10, locked: false });
  });
});

describe('a lost lock file', () => {
  it('a vault means on: the file going doesn\'t turn the lock off', async () => {
    await enableAppLock(PIN);
    await lockedAndReloaded();
    localStorage.removeItem(APP_LOCK_KEY);
    asNewDocument();
    expect(appLockHold(), 'held back while it looks').toBeInstanceOf(Promise);
    await vi.waitFor(() => expect(getAppLockPhase()).toBe('locked'));
    expect(readAppLockFile()).toMatchObject({ on: true, locked: true });
    await unlockWithPin(PIN);
    expect(isAppLockedNow()).toBe(false);
  });

  it('so does an unreadable one', async () => {
    await enableAppLock(PIN);
    await lockedAndReloaded();
    localStorage.setItem(APP_LOCK_KEY, '{broken');
    asNewDocument();
    await vi.waitFor(() => expect(getAppLockPhase()).toBe('locked'));
  });

  it('turning it on doesn\'t overwrite a vault that still holds a key', async () => {
    await openAccountKey('acc');
    await enableAppLock(PIN);
    localStorage.removeItem(APP_LOCK_KEY);
    const before = await readVault();
    resetAppLockForTests();
    await expect(enableAppLock('another-pin-82')).rejects.toBeInstanceOf(VaultExistsError);
    expect((await readVault())?.pin.data).toEqual(before?.pin.data);
    await expect(createVault('another-pin-82')).rejects.toBeInstanceOf(VaultExistsError);
  });
});

describe('a PIN anyone would guess', () => {
  it('is refused when set, and changing to one too', async () => {
    await expect(enableAppLock('123456')).rejects.toMatchObject({ name: 'ObviousPinError' });
    expect(await readVault()).toBeNull();
    await enableAppLock(PIN);
    await expect(changeAppLockPin(PIN, '000000')).rejects.toMatchObject({ name: 'ObviousPinError' });
    await unlockAfterChangeRefused();
  });

  async function unlockAfterChangeRefused(): Promise<void> {
    await lockedAndReloaded();
    await unlockWithPin(PIN);
    expect(isAppLockedNow()).toBe(false);
  }
});

describe('the PIN\'s length', () => {
  function minimumPolicy(value: number | null, locked = true): void {
    (window as unknown as { bulwarkDesktop: unknown }).bulwarkDesktop = {
      version: 1,
      platform: 'win32',
      policy: { get: () => ({ AppLockPinMinLength: { value, locked, source: locked ? 'forced-machine' : 'default' } }), onChange: () => () => {} },
    };
  }

  it('takes 5 characters and refuses 4', async () => {
    await expect(enableAppLock('4829')).rejects.toMatchObject({ name: 'ShortPinError' });
    expect(await readVault()).toBeNull();
    await enableAppLock('48291');
    await expect(changeAppLockPin('48291', '7302')).rejects.toMatchObject({ name: 'ShortPinError' });
    await lockedAndReloaded();
    await unlockWithPin('48291');
    expect(isAppLockedNow()).toBe(false);
  });

  it('a forced policy asking for 8 wins, and a PIN set before it keeps working', async () => {
    await enableAppLock('48291');
    minimumPolicy(8);
    await expect(changeAppLockPin('48291', '5820374')).rejects.toMatchObject({ name: 'ShortPinError' });
    await lockedAndReloaded();
    await unlockWithPin('48291');
    expect(isAppLockedNow()).toBe(false);
    await disableAppLock('48291');
    await expect(enableAppLock('5820374')).rejects.toMatchObject({ name: 'ShortPinError' });
    await enableAppLock('58203749');
    expect(readAppLockFile().on).toBe(true);
  });

  it('a policy can\'t go under 5, and a recommended one asks for nothing', async () => {
    minimumPolicy(3);
    await expect(enableAppLock('4829')).rejects.toMatchObject({ name: 'ShortPinError' });
    minimumPolicy(8, false);
    await enableAppLock('48291');
  });
});

describe('off', () => {
  it('is the default: nothing is shown as locked and no layer is asked for', async () => {
    bootAppLock();
    await vi.waitFor(() => expect(appLockHold()).toBeNull());
    expect(getAppLockPhase()).toBe('open');
    expect(isAppLockedNow()).toBe(false);
    expect(appLockKeyLayers()).toEqual([]);
    expect(localStorage.getItem(APP_LOCK_KEY)).toBeNull();
  });

  it('turning it off takes the layer off again', async () => {
    await openAccountKey('acc');
    await enableAppLock(PIN);
    expect((await getAccountRecord('acc'))?.layers).toEqual(['applock']);
    await disableAppLock(PIN);
    expect((await getAccountRecord('acc'))?.layers).toEqual([]);
    expect(readAppLockFile().on).toBe(false);
  });

  it('a wrong PIN doesn\'t turn it off', async () => {
    await enableAppLock(PIN);
    await expect(disableAppLock('wrong-pin')).rejects.toMatchObject({ name: 'WrongPinError' });
    expect(readAppLockFile().on).toBe(true);
  });
});

describe('Windows Hello', () => {
  /**
   * Main's side, with a signer standing in for the key credential: deterministic, as RSA PKCS#1 v1.5
   * is. It signs only while main is locked or with the proof of the lock as it stands, as main does.
   */
  function helloShell() {
    const state = { answer: 'ok' as 'ok' | 'cancelled' | 'missing', enrolled: false, locked: false, proofs: new Set<string>() };
    const secret = crypto.getRandomValues(new Uint8Array(32));
    const sign = async (salt: Uint8Array) => {
      const key = await crypto.subtle.importKey('raw', secret, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
      return new Uint8Array(await crypto.subtle.sign('HMAC', key, salt.slice().buffer as ArrayBuffer));
    };
    const id = (bytes?: Uint8Array) => (bytes ? Array.from(bytes).join() : '');
    const helloEnroll = vi.fn(async (_proof: Uint8Array, salt: Uint8Array) => {
      if (state.answer !== 'ok') return { ok: false as const, reason: state.answer };
      state.enrolled = true;
      return { ok: true as const, signature: await sign(salt) };
    });
    const helloSign = vi.fn(async (salt: Uint8Array, proof?: Uint8Array) => {
      if (!state.locked && !state.proofs.has(id(proof))) return { ok: false as const, reason: 'not-locked' as const };
      if (!state.enrolled) return { ok: false as const, reason: 'missing' as const };
      if (state.answer !== 'ok') return { ok: false as const, reason: state.answer };
      return { ok: true as const, signature: await sign(salt) };
    });
    const helloRemove = vi.fn(async () => {
      state.enrolled = false;
    });
    const helloCancel = vi.fn();
    const appLock = bridge({
      status: vi.fn(async () => ({ locked: state.locked, enrolled: true, os: null, osEnrolled: false, hello: { available: true, allowed: true, enrolled: state.enrolled } })),
      enroll: vi.fn(async (proof: Uint8Array) => {
        state.proofs.add(id(proof));
        return true;
      }),
      prove: vi.fn(async (proof: Uint8Array) => {
        state.proofs.add(id(proof));
        state.locked = false;
        return true;
      }),
    });
    appLock.lock = vi.fn(() => {
      state.locked = true;
    });
    appLock.claim = vi.fn(() => ({ lock: appLock.lock, osUnlock: appLock.osUnlock, helloEnroll, helloSign, helloRemove, helloCancel })) as never;
    return { appLock, state, helloEnroll, helloSign, helloRemove, helloCancel };
  }

  it('turning it on wraps the lock key under the signature, and the lock screen opens the store with it', async () => {
    const shell = helloShell();
    await openAccountKey('acc');
    await enableAppLock(PIN);
    expect(await helloState()).toEqual({ shown: true, on: false });
    await enableHello(PIN);
    const [proof, salt] = shell.helloEnroll.mock.calls[0];
    expect(proof).toHaveLength(32);
    expect(salt).toHaveLength(32);
    expect(Array.from((await readVault())!.hello!.salt)).toEqual(Array.from(salt));
    expect(await helloState()).toEqual({ shown: true, on: true });

    await lockedAndReloaded();
    asNewDocument();
    expect(getAppLockPhase()).toBe('locked');
    await unlockWithHello();
    expect(getAppLockPhase()).toBe('open');
    // Asked while locked, with nothing but the salt; the unlock is proved to main with the key.
    const asked = shell.helloSign.mock.calls.at(-1)!;
    expect(Array.from(asked[0])).toEqual(Array.from(salt));
    expect(asked[1]).toBeUndefined();
    expect(shell.appLock.prove).toHaveBeenCalled();
    await expect(openAccountKey('acc', appLockKeyLayers())).resolves.toMatchObject({ fresh: false });
  });

  it('a no from Hello leaves it locked with the PIN to go, and costs no PIN try', async () => {
    const shell = helloShell();
    await enableAppLock(PIN);
    await enableHello(PIN);
    await lockedAndReloaded();
    asNewDocument();
    shell.state.answer = 'cancelled';
    await expect(unlockWithHello()).rejects.toMatchObject({ name: 'HelloError', reason: 'cancelled' });
    expect(getAppLockPhase()).toBe('locked');
    expect((await readVault())?.hello).toBeDefined();
    expect(await pinBlockedUntil()).toBe(0);
    await unlockWithPin(PIN);
    expect(getAppLockPhase()).toBe('open');
  });

  it('a key credential Windows lost takes the wrap with it, and the PIN still opens', async () => {
    const shell = helloShell();
    await enableAppLock(PIN);
    await enableHello(PIN);
    await lockedAndReloaded();
    asNewDocument();
    shell.state.enrolled = false;
    await expect(unlockWithHello()).rejects.toMatchObject({ name: 'HelloError', reason: 'missing' });
    expect((await readVault())?.hello).toBeUndefined();
    await unlockWithPin(PIN);
    expect(getAppLockPhase()).toBe('open');
  });

  it('a new PIN asks Hello for a new wrap of the new key; a no turns Hello off and says so', async () => {
    const shell = helloShell();
    await openAccountKey('acc');
    await enableAppLock(PIN);
    await enableHello(PIN);
    const first = (await readVault())!.hello!;
    expect(await changeAppLockPin(PIN, 'next-pin-5521')).toMatchObject({ helloOff: false });
    // Unlocked, so with the proof of the new lock.
    expect(shell.helloSign.mock.calls.at(-1)?.[1]).toHaveLength(32);
    const second = (await readVault())!.hello!;
    expect(Array.from(second.salt)).not.toEqual(Array.from(first.salt));
    await lockedAndReloaded();
    asNewDocument();
    await unlockWithHello();
    await expect(openAccountKey('acc', appLockKeyLayers())).resolves.toMatchObject({ fresh: false });

    shell.state.answer = 'cancelled';
    expect(await changeAppLockPin('next-pin-5521', 'third-pin-7731')).toMatchObject({ helloOff: true });
    expect((await readVault())?.hello).toBeUndefined();
    expect(shell.helloRemove).toHaveBeenCalled();
    expect(shell.state.enrolled).toBe(false);
  });

  it('turning it off takes the wrap and the key credential', async () => {
    const shell = helloShell();
    await enableAppLock(PIN);
    await enableHello(PIN);
    await disableHello();
    expect((await readVault())?.hello).toBeUndefined();
    expect(shell.helloRemove).toHaveBeenCalledTimes(1);
    expect(await helloState()).toEqual({ shown: true, on: false });
  });

  it('a wrap whose key credential main no longer has is dropped when anyone looks', async () => {
    const shell = helloShell();
    await enableAppLock(PIN);
    await enableHello(PIN);
    shell.state.enrolled = false;
    expect(await helloState()).toEqual({ shown: true, on: false });
    expect((await readVault())?.hello).toBeUndefined();
  });

  it('the AppLockHelloAllowed policy forced off hides it and drops the wrap and the key credential', async () => {
    const shell = helloShell();
    await enableAppLock(PIN);
    await enableHello(PIN);
    (window as unknown as { bulwarkDesktop: Record<string, unknown> }).bulwarkDesktop.policy = {
      get: () => ({ AppLockHelloAllowed: { value: false, locked: true, source: 'forced-machine' } }),
      onChange: () => () => {},
    };
    stopTab = startAppLock();
    await vi.waitFor(() => expect(shell.helloRemove).toHaveBeenCalled());
    expect((await readVault())?.hello).toBeUndefined();
    expect(await helloState()).toEqual({ shown: false, on: false });
    await expect(enableHello(PIN)).rejects.toMatchObject({ name: 'HelloError' });
  });

  it('a recommended off is no off: only a forced value turns it off', async () => {
    helloShell();
    await enableAppLock(PIN);
    (window as unknown as { bulwarkDesktop: Record<string, unknown> }).bulwarkDesktop.policy = {
      get: () => ({ AppLockHelloAllowed: { value: false, locked: false, source: 'recommended-machine' } }),
      onChange: () => () => {},
    };
    expect(await helloState()).toEqual({ shown: true, on: false });
  });

  it('isn\'t offered by a shell without it, nor in a browser', async () => {
    bridge();
    await enableAppLock(PIN);
    expect(await helloState()).toEqual({ shown: false, on: false });
    delete (window as unknown as { bulwarkDesktop?: unknown }).bulwarkDesktop;
    resetAppLockForTests();
    expect(await helloState()).toEqual({ shown: false, on: false });
  });
});
