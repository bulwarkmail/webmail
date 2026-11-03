import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import vm from 'node:vm';
import { describe, expect, it, vi } from 'vitest';

// public/sw.js is served raw, never bundled, so it cannot be imported. Run it
// in a VM with a minimal ServiceWorkerGlobalScope and fire the event.
const SW_SOURCE = readFileSync(join(process.cwd(), 'public', 'sw.js'), 'utf8');

function loadWorker(tabs: { postMessage: (msg: unknown) => void }[], registrations?: unknown, config: { noThirdPartyTraffic?: boolean } | null = {}) {
  const listeners = new Map<string, (event: unknown) => void>();
  const newSubscription = { toJSON: () => ({ endpoint: 'https://push.example/new', keys: { p256dh: 'p', auth: 'a' } }) };
  const subscribe = vi.fn(async (_options: { userVisibleOnly?: boolean; applicationServerKey?: Uint8Array }) => newSubscription);
  const relayCalls: Array<{ url: string; body: unknown }> = [];
  const self = {
    location: { href: 'https://mail.example.com/sw.js', origin: 'https://mail.example.com' },
    addEventListener: (type: string, fn: (event: unknown) => void) => listeners.set(type, fn),
    skipWaiting: () => {},
    clients: { claim: () => {}, matchAll: async () => tabs },
    registration: { pushManager: { subscribe } },
  };
  const context = vm.createContext({
    self,
    atob,
    caches: { open: async () => ({ match: async () => (registrations ? { json: async () => registrations } : undefined) }) },
    fetch: vi.fn(async (url: string, init?: { body: string }) => {
      if (url.endsWith('/api/config')) {
        if (!config) throw new TypeError('offline');
        return { ok: true, json: async () => config };
      }
      relayCalls.push({ url, body: JSON.parse(init!.body) });
      return { ok: true };
    }),
    URL, URLSearchParams, Response, Date, console, Uint8Array,
  });
  vm.runInContext(SW_SOURCE, context);

  async function fire(type: string, event: Record<string, unknown>) {
    const waits: Promise<unknown>[] = [];
    listeners.get(type)?.({ ...event, waitUntil: (p: Promise<unknown>) => waits.push(p) });
    await Promise.all(waits);
  }
  return { fire, subscribe, relayCalls, newSubscription };
}

// The push service dropped or replaced the subscription while no page was
// involved (#1321). The worker puts a subscription back and tells the open
// tabs, which hold the login needed to register the new endpoint.
describe('service worker pushsubscriptionchange', () => {
  const REGISTRATIONS = {
    applicationServerKey: 'QUJD',
    entries: {
      a: { relay: 'https://relay.example', subscriptionId: 'device-a', accountLabel: 'a@example.org' },
      b: { relay: 'https://relay.example', subscriptionId: 'device-b', accountLabel: 'b@example.org' },
    },
  };

  it('tells the relay the new endpoint itself, for every account, with no tab open', async () => {
    const { fire, relayCalls, newSubscription } = loadWorker([], REGISTRATIONS);
    await fire('pushsubscriptionchange', { oldSubscription: null, newSubscription });
    expect(relayCalls).toEqual([
      { url: 'https://relay.example/api/push/register/web', body: { subscriptionId: 'device-a', subscription: newSubscription.toJSON(), accountLabel: 'a@example.org' } },
      { url: 'https://relay.example/api/push/register/web', body: { subscriptionId: 'device-b', subscription: newSubscription.toJSON(), accountLabel: 'b@example.org' } },
    ]);
  });

  it('subscribes with the kept key when the browser gives no old subscription', async () => {
    const { fire, subscribe, relayCalls } = loadWorker([], REGISTRATIONS);
    await fire('pushsubscriptionchange', { oldSubscription: null, newSubscription: null });
    expect(subscribe).toHaveBeenCalledTimes(1);
    expect(subscribe.mock.calls[0][0]).toMatchObject({ userVisibleOnly: true });
    expect(Array.from(subscribe.mock.calls[0][0].applicationServerKey!)).toEqual([65, 66, 67]);
    expect(relayCalls).toHaveLength(2);
  });

  it('calls no relay while third-party traffic is off: the page moves it', async () => {
    const { fire, relayCalls, newSubscription } = loadWorker([], REGISTRATIONS, { noThirdPartyTraffic: true });
    await fire('pushsubscriptionchange', { oldSubscription: null, newSubscription });
    expect(relayCalls).toEqual([]);
  });

  it('calls no relay when it cannot find out', async () => {
    const { fire, relayCalls, newSubscription } = loadWorker([], REGISTRATIONS, null);
    await fire('pushsubscriptionchange', { oldSubscription: null, newSubscription });
    expect(relayCalls).toEqual([]);
  });

  it('calls no relay for a browser where push was never on', async () => {
    const { fire, relayCalls, newSubscription } = loadWorker([]);
    await fire('pushsubscriptionchange', { oldSubscription: null, newSubscription });
    expect(relayCalls).toEqual([]);
  });

  it('re-subscribes with the old key and tells the open tabs to re-register', async () => {
    const tab = { postMessage: vi.fn() };
    const { fire, subscribe } = loadWorker([tab]);
    const options = { userVisibleOnly: true, applicationServerKey: new Uint8Array([1, 2, 3]) };

    await fire('pushsubscriptionchange', { oldSubscription: { options }, newSubscription: null });

    expect(subscribe).toHaveBeenCalledWith(options);
    expect(tab.postMessage).toHaveBeenCalledWith({ kind: 'pushsubscriptionchange' });
  });

  it('leaves a subscription the browser already replaced alone', async () => {
    const tab = { postMessage: vi.fn() };
    const { fire, subscribe } = loadWorker([tab]);

    await fire('pushsubscriptionchange', {
      oldSubscription: { options: { userVisibleOnly: true } },
      newSubscription: { endpoint: 'https://push.example/new' },
    });

    expect(subscribe).not.toHaveBeenCalled();
    expect(tab.postMessage).toHaveBeenCalledWith({ kind: 'pushsubscriptionchange' });
  });

  it('still tells the tabs when re-subscribing fails', async () => {
    const tab = { postMessage: vi.fn() };
    const { fire, subscribe } = loadWorker([tab]);
    subscribe.mockRejectedValueOnce(new Error('permission revoked'));

    await fire('pushsubscriptionchange', { oldSubscription: { options: {} }, newSubscription: null });

    expect(tab.postMessage).toHaveBeenCalledWith({ kind: 'pushsubscriptionchange' });
  });
});
