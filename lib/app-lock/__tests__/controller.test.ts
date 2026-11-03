import 'fake-indexeddb/auto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { composeSnapshots, registerComposeFlush, registerComposeSnapshot, resetComposeFlushRegistry } from '@/lib/compose-flush-registry';
import { isAppLocked, setAppLockCheck } from '@/lib/desktop/app-lock-state';
import { configureStore, getStore, setStoreBackend, type StorePageHooks } from '@/lib/store/client/api';
import { deleteKeyDatabase, getAccountRecord, openAccountKey } from '@/lib/store/client/keys';
import {
  addOsUnlock,
  appLockHold,
  appLockKeyLayers,
  bootAppLock,
  disableAppLock,
  enableAppLock,
  forgetEverything,
  getAppLockPhase,
  lockEverywhere,
  resetAppLockForTests,
  setReloadForTests,
  startAppLock,
  unlockWithOs,
  unlockWithPin,
} from '../controller';
import { appLockRequired, effectiveTimeout } from '../policy';
import { APP_LOCK_KEY, isAppLockedNow, readAppLockFile, setLockedHere } from '../state';
import { deleteVault } from '../vault';

const PIN = 'correct-pin';

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
    osEnroll: vi.fn(async () => true),
    osRemove: vi.fn(async () => {}),
    osUnlock: vi.fn(async () => ({ ok: false as const, reason: 'denied' as const })),
    onLockRequest: vi.fn(() => () => {}),
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

  it('notifications go by it: the check the OS code asks says locked', async () => {
    await enableAppLock(PIN);
    asNewDocument();
    expect(isAppLocked()).toBe(true);
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
    window.dispatchEvent(new Event('online'));
    expect(reloads).toBe(1);
  });
});

describe('the store when a tab inherits it without the key', () => {
  it('locks everywhere instead of opening or writing an unwrapped key', async () => {
    await enableAppLock(PIN);
    resetAppLockForTests();
    bootAppLock();
    await vi.waitFor(() => expect(getAppLockPhase()).toBe('locked'));
    const layers = () => appLockKeyLayers();
    expect(layers).toThrow(expect.objectContaining({ name: 'StoreKeyLayerMissingError' }));
    // A new account can't get a key record outside the layer either.
    expect(await getAccountRecord('new-account')).toBeNull();
  });

  it('a new account after unlock gets its key under the lock', async () => {
    await enableAppLock(PIN);
    await getStore().ensureOpen('new-account', { apiUrl: 'x' } as never);
    await vi.waitFor(async () => expect((await getAccountRecord('new-account'))?.layers).toEqual(['applock']));
  });
});

describe('the desktop app', () => {
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

  it('forgetting asks main first: a no changes nothing', async () => {
    const appLock = bridge({ forget: vi.fn(async () => false) });
    await enableAppLock(PIN);
    await lockedAndReloaded();
    expect(await forgetEverything()).toBe(false);
    expect(appLock.forget).toHaveBeenCalled();
    expect(readAppLockFile()).toMatchObject({ on: true, locked: true });
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

  it('a required lock doesn\'t stand in front of the login page', () => {
    withPolicy({ value: true, locked: true });
    bootAppLock();
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
    withPolicy({ value: false, locked: false }, { value: 3, locked: false });
    expect(effectiveTimeout(60)).toEqual({ minutes: 60, locked: false });
    expect(effectiveTimeout(undefined)).toEqual({ minutes: 3, locked: false });
    delete (window as unknown as { bulwarkDesktop?: unknown }).bulwarkDesktop;
    expect(effectiveTimeout(undefined)).toEqual({ minutes: 10, locked: false });
  });
});

describe('off', () => {
  it('is the default: nothing is held back and no layer is asked for', () => {
    bootAppLock();
    expect(getAppLockPhase()).toBe('open');
    expect(appLockHold()).toBeNull();
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
