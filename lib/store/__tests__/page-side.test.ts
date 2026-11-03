import 'fake-indexeddb/auto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { configureStore, getStore, setStoreBackend } from '../client/api';
import { getAccountRecord } from '../client/keys';
import { purgeStoreFiles } from '../client/purge';
import { StoreClient } from '../client/store-client';
import { FAKE_SESSION } from './helpers/fake-jmap';

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
  static opened = { fileExisted: true };
  onmessage: ((event: MessageEvent) => void) | null = null;
  posted: Array<Record<string, unknown>> = [];
  terminated = false;
  constructor(readonly url: string, readonly options: unknown) {
    FakeWorker.all.push(this);
  }
  postMessage(message: Record<string, unknown>): void {
    this.posted.push(message);
    if (message.kind === 'open') queueMicrotask(() => this.onmessage?.({ data: { kind: 'result', id: message.id, result: FakeWorker.opened } } as MessageEvent));
  }
  terminate(): void {
    this.terminated = true;
  }
  becomeOwner(): void {
    this.onmessage?.({ data: { kind: 'owner' } } as MessageEvent);
  }
}

beforeEach(() => {
  FakeChannel.open.clear();
  FakeWorker.all = [];
  vi.stubGlobal('BroadcastChannel', FakeChannel);
  vi.stubGlobal('Worker', FakeWorker);
});

afterEach(() => {
  vi.unstubAllGlobals();
  setStoreBackend(null);
  configureStore(null);
});

describe('whether the store can run here', () => {
  afterEach(() => {
    delete (window.navigator as { storage?: unknown }).storage;
    delete (window.navigator as { locks?: unknown }).locks;
  });

  it('doesn’t ask the page for what only exists in a worker', () => {
    expect(StoreClient.supported()).toBe(false);
    Object.defineProperty(window.navigator, 'storage', { configurable: true, value: { getDirectory: async () => ({}) } });
    Object.defineProperty(window.navigator, 'locks', { configurable: true, value: { request: async () => {} } });
    // As on a real page: the class is there, without createSyncAccessHandle on it.
    vi.stubGlobal('FileSystemFileHandle', class {});
    expect(StoreClient.supported()).toBe(true);
  });
});

describe('a tab that starts after the owner', () => {
  it('asks who owns the store, so its calls don\'t wait for an announcement that never comes', async () => {
    const owner = new FakeChannel('bulwark-store-rpc');
    const asked: unknown[] = [];
    owner.onmessage = (event) => {
      asked.push(event.data);
      if ((event.data as { kind: string }).kind === 'who-owns') owner.postMessage({ kind: 'owner-changed', owner: 'other-tab' });
      if ((event.data as { kind: string }).kind === 'rpc') {
        const { id, from } = event.data as { id: string; from: string };
        owner.postMessage({ kind: 'reply', id, to: from, result: { answered: true } });
      }
    };
    const client = new StoreClient();
    client.start();
    expect(asked).toEqual([{ kind: 'who-owns' }]);
    await expect(client.area('a', 'x.y')).resolves.toEqual({ answered: true });
    client.halt();
  });

  it('passes the error\'s name over the channel, so a caller can wait for the account to open', async () => {
    const owner = new FakeChannel('bulwark-store-rpc');
    owner.onmessage = (event) => {
      if ((event.data as { kind: string }).kind === 'who-owns') owner.postMessage({ kind: 'owner-changed', owner: 'other-tab' });
      if ((event.data as { kind: string }).kind === 'rpc') {
        const { id, from } = event.data as { id: string; from: string };
        owner.postMessage({ kind: 'reply', id, to: from, error: 'Not open', errorName: 'StoreAccountClosedError' });
      }
    };
    const client = new StoreClient();
    client.start();
    await expect(client.area('a', 'x.y')).rejects.toMatchObject({ name: 'StoreAccountClosedError' });
    client.halt();
  });
});

describe('the owner tab calling its own worker', () => {
  it('waits for the worker on the channel, since a call posted before that is lost', async () => {
    const worker = new FakeChannel('bulwark-store-rpc');
    const heard: Array<{ kind: string; id?: string; from?: string }> = [];
    worker.onmessage = (event) => heard.push(event.data as { kind: string });
    const client = new StoreClient();
    client.start();
    FakeWorker.all[0].becomeOwner();
    expect(client.ownsStore).toBe(true);

    const call = client.area('a', 'x.y');
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(heard.some(({ kind }) => kind === 'rpc')).toBe(false);
    // It asked again, for when the first announcement was missed.
    expect(heard.filter(({ kind }) => kind === 'who-owns')).toHaveLength(2);

    worker.postMessage({ kind: 'owner-changed', owner: client.clientId });
    await vi.waitFor(() => expect(heard.some(({ kind }) => kind === 'rpc')).toBe(true));
    const rpc = heard.find(({ kind }) => kind === 'rpc')!;
    worker.postMessage({ kind: 'reply', id: rpc.id, to: rpc.from, result: 'done' });
    await expect(call).resolves.toBe('done');
    client.halt();
  });
});

describe('a sign-out in any tab', () => {
  it('stops this tab\'s worker and rejects what was waiting', async () => {
    const halted = vi.fn();
    const client = new StoreClient({ onHalted: halted });
    client.start();
    const owner = new FakeChannel('bulwark-store-rpc');
    owner.postMessage({ kind: 'owner-changed', owner: 'x' });
    const pending = client.area('a', 'x.y');
    await Promise.resolve();
    owner.postMessage({ kind: 'shutdown' });
    await expect(pending).rejects.toMatchObject({ name: 'StoreOwnerGoneError' });
    expect(FakeWorker.all[0].terminated).toBe(true);
    expect(halted).toHaveBeenCalled();
  });
});

describe('purgeStoreFiles', () => {
  function storage(removeEntry: (name: string, options: unknown) => Promise<void>) {
    Object.defineProperty(window.navigator, 'storage', { configurable: true, value: { getDirectory: async () => ({ removeEntry }) } });
  }

  afterEach(() => {
    delete (window.navigator as { storage?: unknown }).storage;
    delete (window.navigator as { locks?: unknown }).locks;
  });

  it('forgets the keys first, tells every tab, and deletes the pool holding the owner lock', async () => {
    const seen: unknown[] = [];
    const tab = new FakeChannel('bulwark-store-rpc');
    tab.onmessage = (event) => seen.push(event.data);
    const order: string[] = [];
    Object.defineProperty(window.navigator, 'locks', {
      configurable: true,
      value: { request: async (name: string, run: () => Promise<void>) => { order.push(`lock ${name}`); await run(); order.push('unlock'); } },
    });
    storage(async (name, options) => {
      order.push(`remove ${name} ${JSON.stringify(options)}`);
    });
    await purgeStoreFiles();
    expect(seen).toEqual([{ kind: 'shutdown' }]);
    expect(order).toEqual(['lock bulwark-store-owner', 'remove .bulwark-store {"recursive":true}', 'unlock']);
    expect((await indexedDB.databases()).map((d) => d.name)).not.toContain('bulwark-store');
  });

  it('waits out a worker that still holds the files, and shrugs at a pool that isn\'t there', async () => {
    const remove = vi.fn()
      .mockRejectedValueOnce(Object.assign(new Error('busy'), { name: 'NoModificationAllowedError' }))
      .mockResolvedValue(undefined);
    storage(remove);
    await purgeStoreFiles();
    expect(remove).toHaveBeenCalledTimes(2);

    storage(async () => { throw Object.assign(new Error('none'), { name: 'NotFoundError' }); });
    await expect(purgeStoreFiles()).resolves.toBeUndefined();
  });
});

describe('the page\'s store', () => {
  function allowEngine() {
    configureStore({
      inputs: () => ({ session: FAKE_SESSION, auth: 'Basic x', invertedKeywordSort: true }),
      refreshAuth: async () => 'Bearer fresh',
      onEvent: () => {},
    });
  }

  it('opens an account only as the owner, with the key to its own worker', async () => {
    allowEngine();
    const store = getStore();
    await store.ensureOpen('a@x');
    const worker = FakeWorker.all[0];
    expect(worker.posted.some((m) => m.kind === 'open')).toBe(false);
    worker.becomeOwner();
    await vi.waitFor(() => expect(worker.posted.some((m) => m.kind === 'open')).toBe(true));
    const open = worker.posted.find((m) => m.kind === 'open') as { params: { account: string; keyHex: string; file: string; auth: string; invertedKeywordSort: boolean } };
    expect(open.params).toMatchObject({ account: 'a@x', auth: 'Basic x', invertedKeywordSort: true });
    expect(open.params.keyHex).toMatch(/^[0-9a-f]{64}$/);
    expect(open.params.file).toMatch(/^\/a[0-9a-f]+\.db$/);
    store.stop();
    expect(worker.terminated).toBe(true);
  });

  it('runs the client\'s refresh when the worker needs auth, and hands the result over', async () => {
    allowEngine();
    const store = getStore();
    await store.ensureOpen('a@x');
    const worker = FakeWorker.all[0];
    worker.onmessage?.({ data: { kind: 'need-auth', account: 'a@x' } } as MessageEvent);
    await vi.waitFor(() => expect(worker.posted).toContainEqual({ kind: 'set-auth', account: 'a@x', auth: 'Bearer fresh' }));
    store.stop();
  });

  it('forgets the key when an account is removed, also in a tab that isn\'t the owner', async () => {
    allowEngine();
    const store = getStore();
    await store.ensureOpen('a@x');
    const worker = FakeWorker.all[0];
    worker.becomeOwner();
    await vi.waitFor(() => expect(worker.posted.some((m) => m.kind === 'open')).toBe(true));
    expect(await getAccountRecord('a@x')).not.toBeNull();

    const owner = new FakeChannel('bulwark-store-rpc');
    owner.postMessage({ kind: 'owner-changed', owner: 'worker' });
    const removed: unknown[] = [];
    owner.onmessage = (event) => {
      const message = event.data as { kind: string; id: string; from: string; method: string; params: unknown };
      if (message.kind !== 'rpc') return;
      removed.push([message.method, message.params]);
      owner.postMessage({ kind: 'reply', id: message.id, to: message.from, result: true });
    };
    const record = await getAccountRecord('a@x');
    await store.remove('a@x');
    expect(await getAccountRecord('a@x')).toBeNull();
    expect(removed).toEqual([['removeAccount', { account: 'a@x', file: record?.file }]]);
    store.stop();
  });

  it('opens an account again once another tab removed it', async () => {
    allowEngine();
    const store = getStore();
    await store.ensureOpen('a@x');
    const worker = FakeWorker.all[0];
    worker.becomeOwner();
    await vi.waitFor(() => expect(worker.posted.filter((m) => m.kind === 'open')).toHaveLength(1));
    await store.ensureOpen('a@x');
    expect(worker.posted.filter((m) => m.kind === 'open')).toHaveLength(1);

    worker.onmessage?.({ data: { kind: 'event', event: { type: 'removed', account: 'a@x' } } } as MessageEvent);
    await store.ensureOpen('a@x');
    await vi.waitFor(() => expect(worker.posted.filter((m) => m.kind === 'open')).toHaveLength(2));
    store.stop();
  });

  it('stops waiting when the engine couldn\'t start in this browser', async () => {
    allowEngine();
    const store = getStore();
    await store.ensureOpen('a@x');
    FakeWorker.all[0].onmessage?.({ data: { kind: 'event', event: { type: 'error', account: '', area: 'store', message: 'no wasm' } } } as MessageEvent);
    await expect(store.answer('a@x', [])).rejects.toThrow('could not start');
    store.stop();
  });
});
