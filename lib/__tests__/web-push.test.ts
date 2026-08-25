import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { IJMAPClient } from '@/lib/jmap/client-interface';
import type { PushSubscription as JmapPushSubscription } from '@/lib/jmap/types';
import {
  disableWebPush,
  enableWebPush,
  listPushDevices,
  revokePushDevice,
} from '@/lib/web-push';

const RELAY = 'https://relay.example';
const ACCOUNT_ID = 'acct-1';
const THIS_DEVICE = 'aaaaaaaabbbbbbbbccccccccdddddddd';
const OTHER_DEVICE = '11111111222222223333333344444444';

const DEVICE_KEY = `bulwark.push.deviceClientId.v1.${ACCOUNT_ID}`;
const SUB_KEY = `bulwark.push.subscriptionId.v1.${ACCOUNT_ID}`;

function sub(
  id: string,
  deviceClientId: string,
  overrides: Partial<JmapPushSubscription> = {},
): JmapPushSubscription {
  return {
    id,
    deviceClientId,
    url: `${RELAY}/api/push/jmap/${deviceClientId}`,
    keys: null,
    expires: new Date(Date.now() + 80 * 24 * 60 * 60 * 1000).toISOString(),
    types: ['EmailDelivery'],
    ...overrides,
  };
}

interface FakeClient extends Partial<IJMAPClient> {
  destroyed: string[];
}

function makeClient(subs: JmapPushSubscription[]): FakeClient & IJMAPClient {
  const destroyed: string[] = [];
  const client = {
    destroyed,
    getAccountId: () => ACCOUNT_ID,
    listPushSubscriptions: vi.fn(async () => subs.filter((s) => !destroyed.includes(s.id))),
    createPushSubscription: vi.fn(async () => 'push-new'),
    verifyPushSubscription: vi.fn(async () => undefined),
    updatePushSubscription: vi.fn(async () => true),
    destroyPushSubscription: vi.fn(async (id: string) => {
      destroyed.push(id);
    }),
  };
  return client as unknown as FakeClient & IJMAPClient;
}

// enableWebPush needs a browser that supports push; jsdom has none of it.
function installPushBrowser() {
  const browserSub = {
    endpoint: 'https://fcm.example/endpoint',
    options: { applicationServerKey: new ArrayBuffer(8) },
    getKey: () => new Uint8Array([1, 2, 3]).buffer,
    unsubscribe: vi.fn(async () => true),
  };
  const registration = {
    pushManager: {
      getSubscription: vi.fn(async () => browserSub),
      subscribe: vi.fn(async () => browserSub),
    },
  };
  Object.defineProperty(navigator, 'serviceWorker', {
    configurable: true,
    value: {
      getRegistration: vi.fn(async () => registration),
      register: vi.fn(async () => registration),
      ready: Promise.resolve(registration),
    },
  });
  (window as unknown as { PushManager: unknown }).PushManager = class {};
  (window as unknown as { Notification: unknown }).Notification = { permission: 'granted' };
  (globalThis as unknown as { Notification: unknown }).Notification = { permission: 'granted' };
  return { browserSub, registration };
}

// Relay endpoints enableWebPush walks through, plus a per-device liveness answer.
function installFetch(activeByDevice: Record<string, boolean | 'unknown'>) {
  const calls: { url: string; method: string }[] = [];
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, method: init?.method ?? 'GET' });
    const json = (body: unknown, status = 200) => ({
      ok: status >= 200 && status < 300,
      status,
      json: async () => body,
    }) as Response;

    if (url.endsWith('/api/push/vapid-public-key')) return json({ publicKey: 'QUJD' });
    if (url.includes('/api/push/verify/')) return json({ verificationCode: 'code-123' });
    if (url.includes('/api/push/active/')) {
      const device = url.split('/api/push/active/')[1];
      const state = activeByDevice[device];
      if (state === undefined || state === 'unknown') return json({ error: 'Unknown' }, 404);
      return json({ active: state });
    }
    return json({});
  });
  vi.stubGlobal('fetch', fetchMock);
  return calls;
}

beforeEach(() => {
  localStorage.clear();
  installPushBrowser();
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('enableWebPush', () => {
  it('reuses the recorded subscription by default', async () => {
    localStorage.setItem(DEVICE_KEY, THIS_DEVICE);
    localStorage.setItem(SUB_KEY, 'push-old');
    const client = makeClient([sub('push-old', THIS_DEVICE)]);
    installFetch({});

    const result = await enableWebPush({ client, relayBaseUrl: RELAY });

    expect(result.subscriptionId).toBe('push-old');
    expect(client.createPushSubscription).not.toHaveBeenCalled();
    expect(client.destroyed).toEqual([]);
  });

  it('destroys and recreates the recorded subscription with forceRecreate', async () => {
    localStorage.setItem(DEVICE_KEY, THIS_DEVICE);
    localStorage.setItem(SUB_KEY, 'push-old');
    const client = makeClient([sub('push-old', THIS_DEVICE)]);
    installFetch({});

    const result = await enableWebPush({ client, relayBaseUrl: RELAY, forceRecreate: true });

    expect(client.destroyed).toContain('push-old');
    expect(client.createPushSubscription).toHaveBeenCalledTimes(1);
    expect(client.verifyPushSubscription).toHaveBeenCalledWith('push-new', 'code-123');
    expect(result.subscriptionId).toBe('push-new');
    expect(localStorage.getItem(SUB_KEY)).toBe('push-new');
  });

  it('leaves another device alone when the relay cannot vouch for it', async () => {
    localStorage.setItem(DEVICE_KEY, THIS_DEVICE);
    const client = makeClient([sub('push-other', OTHER_DEVICE)]);
    installFetch({ [OTHER_DEVICE]: 'unknown' });

    await enableWebPush({ client, relayBaseUrl: RELAY, forceRecreate: true });

    expect(client.destroyed).not.toContain('push-other');
  });
});

describe('disableWebPush', () => {
  it('destroys every subscription this device owns, not just the recorded id', async () => {
    localStorage.setItem(DEVICE_KEY, THIS_DEVICE);
    localStorage.setItem(SUB_KEY, 'push-tracked');
    const client = makeClient([
      sub('push-tracked', THIS_DEVICE),
      // Left behind by an earlier enable whose destroy never landed.
      sub('push-orphan', THIS_DEVICE),
      sub('push-other', OTHER_DEVICE),
    ]);
    installFetch({});

    await disableWebPush({ client, relayBaseUrl: RELAY });

    expect(client.destroyed.sort()).toEqual(['push-orphan', 'push-tracked']);
    expect(localStorage.getItem(SUB_KEY)).toBeNull();
    // The deviceClientId survives so a later enable reuses the relay record.
    expect(localStorage.getItem(DEVICE_KEY)).toBe(THIS_DEVICE);
  });

  it('drops the relay registration for this device', async () => {
    localStorage.setItem(DEVICE_KEY, THIS_DEVICE);
    const client = makeClient([]);
    const calls = installFetch({});

    await disableWebPush({ client, relayBaseUrl: RELAY });

    expect(calls).toContainEqual({
      url: `${RELAY}/api/push/register/${THIS_DEVICE}`,
      method: 'DELETE',
    });
  });
});

describe('listPushDevices', () => {
  it('flags this device and reports the relay status of each registration', async () => {
    localStorage.setItem(DEVICE_KEY, THIS_DEVICE);
    const client = makeClient([
      sub('push-mine', THIS_DEVICE),
      sub('push-live', OTHER_DEVICE),
      sub('push-dead', 'deaddeaddeaddeaddeaddeaddeaddead'),
      sub('push-foreign', 'ffffffffffffffffffffffffffffffff'),
    ]);
    installFetch({
      [THIS_DEVICE]: true,
      [OTHER_DEVICE]: true,
      deaddeaddeaddeaddeaddeaddeaddead: false,
    });

    const devices = await listPushDevices({ client, relayBaseUrl: RELAY });

    expect(devices.map((d) => [d.id, d.isThisDevice, d.relayStatus])).toEqual([
      ['push-mine', true, 'active'],
      ['push-live', false, 'active'],
      ['push-dead', false, 'inactive'],
      ['push-foreign', false, 'unknown'],
    ]);
  });
});

describe('revokePushDevice', () => {
  it('destroys another device and frees its relay registration', async () => {
    localStorage.setItem(DEVICE_KEY, THIS_DEVICE);
    localStorage.setItem(SUB_KEY, 'push-mine');
    const client = makeClient([sub('push-mine', THIS_DEVICE), sub('push-other', OTHER_DEVICE)]);
    const calls = installFetch({});

    await revokePushDevice({
      client,
      relayBaseUrl: RELAY,
      device: { id: 'push-other', deviceClientId: OTHER_DEVICE, isThisDevice: false },
    });

    expect(client.destroyed).toEqual(['push-other']);
    expect(calls).toContainEqual({
      url: `${RELAY}/api/push/register/${OTHER_DEVICE}`,
      method: 'DELETE',
    });
    // Revoking elsewhere must not disturb this browser's own registration.
    expect(localStorage.getItem(SUB_KEY)).toBe('push-mine');
  });

  it('runs the full local teardown when revoking this device', async () => {
    localStorage.setItem(DEVICE_KEY, THIS_DEVICE);
    localStorage.setItem(SUB_KEY, 'push-mine');
    const client = makeClient([sub('push-mine', THIS_DEVICE)]);
    installFetch({});

    await revokePushDevice({
      client,
      relayBaseUrl: RELAY,
      device: { id: 'push-mine', deviceClientId: THIS_DEVICE, isThisDevice: true },
    });

    expect(client.destroyed).toEqual(['push-mine']);
    expect(localStorage.getItem(SUB_KEY)).toBeNull();
  });
});
