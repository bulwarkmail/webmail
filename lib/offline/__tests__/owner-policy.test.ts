import 'fake-indexeddb/auto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// A tab that takes over the store asks for the policy again, since it may have sat in
// the background. At a start the store changes hands right after the page's first
// policy fetch answered (or while it is on its way): that answer is current, and a
// second request only held up the start.

const mocks = vi.hoisted(() => ({ apiFetch: vi.fn<(url: string, init?: RequestInit) => Promise<Response>>() }));
vi.mock('@/lib/browser-navigation', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/browser-navigation')>()),
  apiFetch: mocks.apiFetch,
}));

const { configureStore, getStore, setStoreBackend } = await import('@/lib/store/client/api');
const { deleteKeyDatabase } = await import('@/lib/store/client/keys');
const { FAKE_SESSION } = await import('@/lib/store/__tests__/helpers/fake-jmap');
const { usePolicyStore } = await import('@/stores/policy-store');
const { registerOfflineHooks, setOfflineNotifier } = await import('../offline-mode');
const { useOfflineStore } = await import('../state');

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
  constructor() {
    FakeWorker.all.push(this);
  }
  postMessage(message: Record<string, unknown>): void {
    this.posted.push(message);
    if (message.kind === 'open' || message.kind === 'prune-files') {
      queueMicrotask(() => this.onmessage?.({ data: { kind: 'result', id: message.id, result: { created: false } } } as MessageEvent));
    }
  }
  terminate(): void {}
}

function ownerOnChannel(): void {
  const owner = new FakeChannel('bulwark-store-rpc');
  owner.onmessage = (event) => {
    const message = event.data as { kind: string; id: string; from: string; method: string; params: { name?: string } };
    if (message.kind === 'who-owns') owner.postMessage({ kind: 'owner-changed', owner: 'worker' });
    if (message.kind !== 'rpc') return;
    const name = message.params?.name ?? '';
    const result = name === 'outbox.read' ? { patches: 0, entries: [], conflicts: [] }
      : name.endsWith('.conflicts') ? []
        : name.endsWith('.pending') ? 0
          : name === 'store.usage' ? { bytes: 0, parts: [] }
            : null;
    owner.postMessage({ kind: 'reply', id: message.id, to: message.from, result });
  };
  owner.postMessage({ kind: 'owner-changed', owner: 'worker' });
}

const policyRequests = () => mocks.apiFetch.mock.calls.filter(([url]) => String(url).startsWith('/api/admin/policy')).length;

/** The store's worker says this tab owns it, the way a start goes. */
async function takeOver(): Promise<void> {
  useOfflineStore.setState({ enabled: ['alice@example.org'] });
  await getStore().ensureOpen('alice@example.org', FAKE_SESSION);
  const worker = FakeWorker.all.at(-1)!;
  worker.onmessage?.({ data: { kind: 'owner' } } as MessageEvent);
  ownerOnChannel();
  await vi.waitFor(() => expect(worker.posted.some((m) => m.kind === 'open')).toBe(true));
}

beforeEach(() => {
  localStorage.clear();
  deleteKeyDatabase();
  FakeChannel.open.clear();
  FakeWorker.all = [];
  mocks.apiFetch.mockReset();
  mocks.apiFetch.mockImplementation(async () => new Response(JSON.stringify({ features: {}, restrictions: {} })));
  vi.stubGlobal('BroadcastChannel', FakeChannel);
  vi.stubGlobal('Worker', FakeWorker);
  vi.stubGlobal('FileSystemFileHandle', class {});
  Object.defineProperty(window.navigator, 'storage', { configurable: true, value: { getDirectory: async () => ({ removeEntry: async () => {} }), persist: async () => true, persisted: async () => true } });
  Object.defineProperty(window.navigator, 'locks', { configurable: true, value: { request: async (_name: string, ...rest: unknown[]) => (rest.at(-1) as () => unknown)() } });
  useOfflineStore.setState({ enabled: [], outbox: [], health: {}, storeLost: [], usage: {}, progress: {}, syncing: [], lastSyncedAt: {} });
  setStoreBackend(null);
  setOfflineNotifier(() => {});
  registerOfflineHooks();
});

afterEach(() => {
  getStore().stop();
  configureStore(null);
  setStoreBackend(null);
  vi.useRealTimers();
  vi.unstubAllGlobals();
  delete (window.navigator as { storage?: unknown }).storage;
  delete (window.navigator as { locks?: unknown }).locks;
});

describe('the policy when this tab takes over the store', () => {
  it('is not fetched again right after the start fetched it', async () => {
    await usePolicyStore.getState().fetchPolicy();
    expect(policyRequests()).toBe(1);
    await takeOver();
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(policyRequests()).toBe(1);
  });

  it('joins the start fetch while it is on its way', async () => {
    let answer!: () => void;
    mocks.apiFetch.mockImplementationOnce(() => new Promise<Response>((resolve) => {
      answer = () => resolve(new Response(JSON.stringify({ features: {}, restrictions: {} })));
    }));
    const first = usePolicyStore.getState().fetchPolicy();
    await takeOver();
    expect(policyRequests()).toBe(1);
    answer();
    await first;
    expect(policyRequests()).toBe(1);
  });

  it('is fetched again when the last answer is old (the tab sat in the background)', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    await usePolicyStore.getState().fetchPolicy();
    vi.setSystemTime(Date.now() + 20 * 60_000);
    await takeOver();
    await vi.waitFor(() => expect(policyRequests()).toBe(2));
  });
});
