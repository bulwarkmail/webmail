import 'fake-indexeddb/auto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_ORGANISATION_POLICY } from '@/lib/admin/organisation-policy';
import { purgeSignedOutData } from '@/lib/sign-out-cleanup';
import { configureStore, getStore, setStoreBackend } from '@/lib/store/client/api';
import { deleteKeyDatabase, getAccountRecord, openAccountKey } from '@/lib/store/client/keys';
import { FAKE_SESSION } from '@/lib/store/__tests__/helpers/fake-jmap';
import { usePolicyStore } from '@/stores/policy-store';
import {
  enableOffline,
  registerOfflineHooks,
  setOfflineNotifier,
  startOfflineMode,
  wipeAccount,
  wipeEverything,
  type OfflineNotice,
} from '../offline-mode';
import { readPersistence, requestPersistence, safariMayDelete } from '../storage-health';
import { markEvicted, OFFLINE_HEALTH_KEY, OFFLINE_SCOPE_KEY, useOfflineStore, writeChoice, writeEnabled, writeHealth } from '../state';

/** Everything on one page: a BroadcastChannel that also reaches other objects here, as in a browser. */
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
  /** What the worker found on OPFS: no database under this name. */
  static created = false;
  onmessage: ((event: MessageEvent) => void) | null = null;
  posted: Array<Record<string, unknown>> = [];
  constructor() {
    FakeWorker.all.push(this);
  }
  postMessage(message: Record<string, unknown>): void {
    this.posted.push(message);
    if (message.kind === 'open') queueMicrotask(() => this.onmessage?.({ data: { kind: 'result', id: message.id, result: { created: FakeWorker.created } } } as MessageEvent));
    if (message.kind === 'prune-files') queueMicrotask(() => this.onmessage?.({ data: { kind: 'result', id: message.id } } as MessageEvent));
  }
  terminate(): void {}
}

const rpcs: Array<{ method: string; params: { name?: string; account?: string } }> = [];

/** The worker's side of the channel: an empty store. */
function ownerOnChannel(): void {
  const owner = new FakeChannel('bulwark-store-rpc');
  owner.onmessage = (event) => {
    const message = event.data as { kind: string; id: string; from: string; method: string; params: { name?: string } };
    if (message.kind === 'who-owns') owner.postMessage({ kind: 'owner-changed', owner: 'worker' });
    if (message.kind !== 'rpc') return;
    rpcs.push({ method: message.method, params: message.params });
    const name = message.params.name ?? '';
    const result = name === 'outbox.read' ? { patches: 0, entries: [], conflicts: [] }
      : name.endsWith('.conflicts') ? []
        : name.endsWith('.pending') ? 0
          : name === 'store.usage' ? { bytes: 0, parts: [] }
            : null;
    owner.postMessage({ kind: 'reply', id: message.id, to: message.from, result });
  };
  owner.postMessage({ kind: 'owner-changed', owner: 'worker' });
}

const notices: OfflineNotice[] = [];

function setStorage(storage: Record<string, unknown>): void {
  Object.defineProperty(window.navigator, 'storage', { configurable: true, value: storage });
}

function setUserAgent(value: string): void {
  Object.defineProperty(window.navigator, 'userAgent', { configurable: true, value });
}

const realUserAgent = window.navigator.userAgent;

beforeEach(() => {
  localStorage.clear();
  deleteKeyDatabase();
  FakeChannel.open.clear();
  FakeWorker.all = [];
  FakeWorker.created = false;
  rpcs.length = 0;
  notices.length = 0;
  vi.stubGlobal('BroadcastChannel', FakeChannel);
  vi.stubGlobal('Worker', FakeWorker);
  vi.stubGlobal('FileSystemFileHandle', class {});
  setStorage({ getDirectory: async () => ({ removeEntry: async () => {} }), persist: async () => true, persisted: async () => true });
  Object.defineProperty(window.navigator, 'locks', { configurable: true, value: { request: async (_name: string, ...rest: unknown[]) => (rest.at(-1) as () => unknown)() } });
  useOfflineStore.setState({
    enabled: [], outbox: [], pendingChanges: 0, conflicts: [], areaConflicts: [], usage: {}, usageBytes: 0, choices: {}, health: {},
    storeLost: [], storageFull: {}, progress: {}, persist: 'unknown', syncing: [], lastSyncedAt: {}, browserOffline: false, downServers: [], startedOffline: false,
  });
  usePolicyStore.setState({ loaded: true, source: 'server', subject: null, subjectPending: false, policy: { ...usePolicyStore.getState().policy, organisation: DEFAULT_ORGANISATION_POLICY } } as never);
  setStoreBackend(null);
  setOfflineNotifier((notice) => notices.push(notice));
  registerOfflineHooks();
});

afterEach(() => {
  getStore().stop();
  configureStore(null);
  setStoreBackend(null);
  setOfflineNotifier(() => {});
  vi.unstubAllGlobals();
  delete (window.navigator as { storage?: unknown }).storage;
  delete (window.navigator as { locks?: unknown }).locks;
  setUserAgent(realUserAgent);
});

/** Opens an account in this tab, as the owner, the way the page does. */
async function openAsOwner(account: string): Promise<FakeWorker> {
  useOfflineStore.setState((s) => ({ enabled: [...s.enabled, account] }));
  await getStore().ensureOpen(account, FAKE_SESSION);
  const worker = FakeWorker.all.at(-1)!;
  worker.onmessage?.({ data: { kind: 'owner' } } as MessageEvent);
  ownerOnChannel();
  await vi.waitFor(() => expect(worker.posted.some((m) => m.kind === 'open' && (m.params as { account: string }).account === account)).toBe(true));
  return worker;
}

describe('a store the browser cleared', () => {
  const hadStore = (account: string) => localStorage.setItem('bulwark-store-opened', JSON.stringify([account]));

  it('a key with no file: warns, with how many waiting items went', async () => {
    await openAccountKey('acc');
    hadStore('acc');
    writeHealth('acc', { pending: 3 });
    FakeWorker.created = true;
    await openAsOwner('acc');
    await vi.waitFor(() => expect(notices).toContainEqual({ kind: 'store-reset', lost: 3 }));
    const state = useOfflineStore.getState();
    expect(state.storeLost).toEqual(['acc']);
    expect(state.health.acc.reset?.lost).toBe(3);
    expect(state.health.acc.pending).toBe(0);
  });

  it('no key where one was made: warns too', async () => {
    hadStore('acc');
    await openAsOwner('acc');
    await vi.waitFor(() => expect(notices).toContainEqual({ kind: 'store-reset', lost: 0 }));
  });

  it('a first open is not an eviction', async () => {
    FakeWorker.created = true;
    const worker = await openAsOwner('acc');
    await vi.waitFor(() => expect(worker.posted.some((m) => m.kind === 'open')).toBe(true));
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(notices.filter((n) => n.kind === 'store-reset')).toEqual([]);
    expect(useOfflineStore.getState().health.acc?.reset).toBeUndefined();
  });

  it('a normal start is not one either', async () => {
    await openAccountKey('acc');
    hadStore('acc');
    writeHealth('acc', { pending: 3 });
    await openAsOwner('acc');
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(notices).toEqual([]);
    expect(useOfflineStore.getState().health.acc.pending).toBe(3);
  });

  it('tells nobody who wasn\'t signed in to an account dropped by the app', async () => {
    await openAccountKey('acc');
    hadStore('acc');
    writeHealth('acc', { pending: 3 });
    useOfflineStore.setState({ enabled: ['acc'] });
    markEvicted('acc');
    useOfflineStore.setState({ enabled: [] });
    FakeWorker.created = true;
    await openAsOwner('acc');
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(notices).toEqual([]);
    expect(useOfflineStore.getState().health.acc.reset).toBeUndefined();
  });

  it('keeps only numbers about it outside the store', () => {
    writeHealth('acc', { pending: 2, reset: { at: 5, lost: 2 }, lastSync: 9 });
    expect(JSON.parse(localStorage.getItem(OFFLINE_HEALTH_KEY)!)).toEqual({ acc: { pending: 2, reset: { at: 5, lost: 2 }, lastSync: 9 } });
  });
});

describe('a failed write', () => {
  it('says the device is full, at most once in a while, until a sync goes through', async () => {
    const worker = await openAsOwner('acc');
    const event = (e: unknown) => worker.onmessage?.({ data: { kind: 'event', event: e } } as MessageEvent);
    event({ type: 'error', account: 'acc', area: 'storage', message: 'SQLITE_FULL' });
    event({ type: 'error', account: 'acc', area: 'storage', message: 'SQLITE_FULL' });
    expect(notices.filter((n) => n.kind === 'storage-failed').length).toBeLessThanOrEqual(1);
    expect(useOfflineStore.getState().storageFull.acc).toBeGreaterThan(0);
    event({ type: 'synced', account: 'acc', at: 123 });
    expect(useOfflineStore.getState().storageFull.acc).toBeUndefined();
    expect(useOfflineStore.getState().health.acc?.lastSync).toBe(123);
  });
});

describe('asking the browser to keep it', () => {
  it('asks when offline is turned on, and remembers a refusal', async () => {
    const persist = vi.fn(async () => false);
    setStorage({ persist, persisted: async () => false, getDirectory: async () => ({}) });
    await enableOffline('acc').catch(() => {});
    await vi.waitFor(() => expect(useOfflineStore.getState().persist).toBe('refused'));
    expect(persist).toHaveBeenCalledTimes(1);
  });

  it('asks again after an install', async () => {
    const persist = vi.fn(async () => true);
    setStorage({ persist, persisted: async () => false, getDirectory: async () => ({}) });
    writeEnabled(['acc']);
    const stop = startOfflineMode();
    window.dispatchEvent(new Event('appinstalled'));
    await vi.waitFor(() => expect(persist).toHaveBeenCalled());
    await vi.waitFor(() => expect(useOfflineStore.getState().persist).toBe('granted'));
    stop();
    registerOfflineHooks();
  });

  it('tells a browser without the API from a refusal', async () => {
    setStorage({});
    expect(await requestPersistence()).toBe('unsupported');
    expect(await readPersistence()).toBe('unsupported');
  });
});

describe('the Safari hint', () => {
  const IPHONE = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1';
  const IPAD_CHROME = 'Mozilla/5.0 (iPad; CPU OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/126.0 Mobile/15E148 Safari/604.1';
  const MAC_SAFARI = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 14_5) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Safari/605.1.15';
  const MAC_CHROME = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 14_5) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36';
  const WIN_EDGE = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36 Edg/126.0';
  const ANDROID_WEBVIEW = 'Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/126.0 Mobile Safari/537.36';
  const FIREFOX = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 14.5; rv:128.0) Gecko/20100101 Firefox/128.0';
  const ELECTRON = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 14_5) AppleWebKit/537.36 (KHTML, like Gecko) Bulwark/1.0 Chrome/126.0 Electron/31.0 Safari/537.36';

  it('shows in Safari and on iOS browsers that are not installed', () => {
    for (const ua of [IPHONE, IPAD_CHROME, MAC_SAFARI]) expect(safariMayDelete(ua, false)).toBe(true);
  });

  it('not once installed', () => {
    for (const ua of [IPHONE, MAC_SAFARI]) expect(safariMayDelete(ua, true)).toBe(false);
  });

  it('nowhere else', () => {
    for (const ua of [MAC_CHROME, WIN_EDGE, ANDROID_WEBVIEW, FIREFOX, ELECTRON]) expect(safariMayDelete(ua, false)).toBe(false);
  });

  it('reads the real browser by default', () => {
    setUserAgent(MAC_SAFARI);
    expect(safariMayDelete()).toBe(true);
    setUserAgent(MAC_CHROME);
    expect(safariMayDelete()).toBe(false);
  });
});

describe('removing an account', () => {
  it('takes its data, key, choice and counts, and leaves the other account alone', async () => {
    const { record } = await openAccountKey('gone');
    await openAccountKey('stays');
    writeEnabled(['gone', 'stays']);
    writeChoice('gone', { days: 30 });
    writeChoice('stays', { days: 90 });
    writeHealth('gone', { pending: 1 });
    await openAsOwner('stays');

    await wipeAccount('gone');

    expect(await getAccountRecord('gone')).toBeNull();
    expect(await getAccountRecord('stays')).not.toBeNull();
    expect(rpcs).toContainEqual({ method: 'removeAccount', params: { account: 'gone', file: record.file } });
    expect(useOfflineStore.getState().choices).toEqual({ stays: { days: 90 } });
    expect(useOfflineStore.getState().health.gone).toBeUndefined();
    expect(JSON.parse(localStorage.getItem(OFFLINE_SCOPE_KEY)!)).toEqual({ stays: { days: 90 } });
  });

  it('with the last account, deletes the pool and every key', async () => {
    const removeEntry = vi.fn(async () => {});
    setStorage({ getDirectory: async () => ({ removeEntry }), persist: async () => true });
    await openAccountKey('acc');
    writeEnabled(['acc']);
    writeChoice('acc', { days: 30 });

    await wipeAccount('acc');

    expect(removeEntry).toHaveBeenCalledWith('.bulwark-store', { recursive: true });
    await vi.waitFor(async () => expect(await getAccountRecord('acc')).toBeNull());
    expect(localStorage.getItem(OFFLINE_SCOPE_KEY)).toBeNull();
    expect(localStorage.getItem(OFFLINE_HEALTH_KEY)).toBeNull();
  });

  it('wipeEverything leaves nothing either', async () => {
    const removeEntry = vi.fn(async () => {});
    setStorage({ getDirectory: async () => ({ removeEntry }) });
    await openAccountKey('a');
    await openAccountKey('b');
    writeEnabled(['a', 'b']);
    await wipeEverything();
    expect(removeEntry).toHaveBeenCalled();
    await vi.waitFor(async () => expect(await getAccountRecord('a')).toBeNull());
    expect(await getAccountRecord('b')).toBeNull();
    expect(useOfflineStore.getState().enabled).toEqual([]);
  });
});

describe('a full sign-out', () => {
  it('that keeps the local store for a new sign-in keeps what was chosen for it too', () => {
    writeEnabled(['acc']);
    writeChoice('acc', { days: 30 });
    writeHealth('acc', { pending: 2 });
    purgeSignedOutData({ keepLocalStore: true });
    expect(JSON.parse(localStorage.getItem(OFFLINE_SCOPE_KEY)!).acc.days).toBe(30);
    expect(JSON.parse(localStorage.getItem(OFFLINE_HEALTH_KEY)!).acc.pending).toBe(2);
    expect(useOfflineStore.getState().choices.acc.days).toBe(30);
  });

  it('deletes the files, every key and what was stored about them', async () => {
    const removeEntry = vi.fn(async () => {});
    setStorage({ getDirectory: async () => ({ removeEntry }) });
    await openAccountKey('acc');
    writeEnabled(['acc']);
    writeChoice('acc', { days: 30 });
    writeHealth('acc', { pending: 2 });

    purgeSignedOutData();

    await vi.waitFor(() => expect(removeEntry).toHaveBeenCalledWith('.bulwark-store', { recursive: true }));
    await vi.waitFor(async () => expect(await getAccountRecord('acc')).toBeNull());
    for (const key of ['bulwark-offline-accounts', OFFLINE_SCOPE_KEY, OFFLINE_HEALTH_KEY]) expect(localStorage.getItem(key)).toBeNull();
    expect(useOfflineStore.getState().choices).toEqual({});
    expect(useOfflineStore.getState().health).toEqual({});
  });
});
