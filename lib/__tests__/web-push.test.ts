import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { IJMAPClient } from '@/lib/jmap/client-interface';
import type { EmailPushConfig, PushSubscription as JmapPushSubscription } from '@/lib/jmap/types';
import {
  buildEmailPushConfig,
  disableWebPush,
  enableWebPush,
  listPushDevices,
  resetWebPushResyncState,
  resyncWebPush,
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

const EMAIL_PUSH_CAP = 'urn:ietf:params:jmap:emailpush';
const JUNK_ID = 'mb-junk';
const SHARED_ACCOUNT_ID = 'acct-shared';
const SHARED_JUNK_ID = 'mb-shared-junk';

// The delivery filter enableWebPush is expected to install for ACCOUNT_ID
// given the mailboxes makeClient hands out.
const EXPECTED_EMAIL_PUSH: Record<string, EmailPushConfig> = {
  [ACCOUNT_ID]: {
    filter: {
      operator: 'AND',
      conditions: [{ notKeyword: '$junk' }, { inMailboxOtherThan: [JUNK_ID] }],
    },
    properties: ['id', 'threadId'],
    urgency: 'high',
  },
  [SHARED_ACCOUNT_ID]: {
    filter: {
      operator: 'AND',
      conditions: [{ notKeyword: '$junk' }, { inMailboxOtherThan: [SHARED_JUNK_ID] }],
    },
    properties: ['id', 'threadId'],
    urgency: 'high',
  },
};

function makeClient(
  subs: JmapPushSubscription[],
  options: { emailPushCapability?: boolean } = {},
): FakeClient & IJMAPClient {
  const destroyed: string[] = [];
  const mailbox = (id: string, role: string | undefined, accountId: string) => ({
    id: accountId === ACCOUNT_ID ? id : `${accountId}:${id}`,
    originalId: id,
    name: role ?? id,
    role,
    accountId,
    isShared: accountId !== ACCOUNT_ID,
  });
  const client = {
    destroyed,
    getAccountId: () => ACCOUNT_ID,
    getCapabilities: () => (options.emailPushCapability ? { [EMAIL_PUSH_CAP]: {} } : {}),
    getAllMailboxes: vi.fn(async () => [
      mailbox('mb-inbox', 'inbox', ACCOUNT_ID),
      mailbox(JUNK_ID, 'junk', ACCOUNT_ID),
      mailbox('mb-archive', undefined, ACCOUNT_ID),
      mailbox('mb-shared-inbox', 'inbox', SHARED_ACCOUNT_ID),
      mailbox(SHARED_JUNK_ID, 'junk', SHARED_ACCOUNT_ID),
    ]),
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
  resetWebPushResyncState();
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

    const result = await enableWebPush({ client, relayBaseUrl: RELAY, inboxOnly: false });

    expect(result.subscriptionId).toBe('push-old');
    expect(client.createPushSubscription).not.toHaveBeenCalled();
    expect(client.destroyed).toEqual([]);
  });

  it('destroys and recreates the recorded subscription with forceRecreate', async () => {
    localStorage.setItem(DEVICE_KEY, THIS_DEVICE);
    localStorage.setItem(SUB_KEY, 'push-old');
    const client = makeClient([sub('push-old', THIS_DEVICE)]);
    installFetch({});

    const result = await enableWebPush({ client, relayBaseUrl: RELAY, forceRecreate: true, inboxOnly: false });

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

    await enableWebPush({ client, relayBaseUrl: RELAY, forceRecreate: true, inboxOnly: false });

    expect(client.destroyed).not.toContain('push-other');
  });
});

// Registrations made before the client learned about the delivery filter are
// repaired in the background on app start - nobody should have to find the
// settings toggle to stop the spam pushes.
describe('resyncWebPush', () => {
  it('re-syncs an enabled registration and installs the missing filter', async () => {
    localStorage.setItem(DEVICE_KEY, THIS_DEVICE);
    localStorage.setItem(SUB_KEY, 'push-old');
    const client = makeClient([sub('push-old', THIS_DEVICE)], { emailPushCapability: true });
    installFetch({});

    expect(await resyncWebPush({ client, relayBaseUrl: RELAY, inboxOnly: false })).toBe(true);

    expect(client.createPushSubscription).not.toHaveBeenCalled();
    expect(client.updatePushSubscription).toHaveBeenCalledWith(
      'push-old',
      expect.objectContaining({ emailPush: EXPECTED_EMAIL_PUSH }),
    );
  });

  it('does nothing when push is not enabled for the account', async () => {
    localStorage.setItem(DEVICE_KEY, THIS_DEVICE);
    const client = makeClient([], { emailPushCapability: true });
    installFetch({});

    expect(await resyncWebPush({ client, relayBaseUrl: RELAY, inboxOnly: false })).toBe(false);

    expect(client.listPushSubscriptions).not.toHaveBeenCalled();
    expect(client.createPushSubscription).not.toHaveBeenCalled();
  });

  it('runs at most once per account per page load', async () => {
    localStorage.setItem(DEVICE_KEY, THIS_DEVICE);
    localStorage.setItem(SUB_KEY, 'push-old');
    const client = makeClient([sub('push-old', THIS_DEVICE)], { emailPushCapability: true });
    installFetch({});

    expect(await resyncWebPush({ client, relayBaseUrl: RELAY, inboxOnly: false })).toBe(true);
    expect(await resyncWebPush({ client, relayBaseUrl: RELAY, inboxOnly: false })).toBe(false);

    expect(client.listPushSubscriptions).toHaveBeenCalledTimes(1);
  });

  it('swallows failures instead of surfacing them to the app', async () => {
    localStorage.setItem(DEVICE_KEY, THIS_DEVICE);
    localStorage.setItem(SUB_KEY, 'push-old');
    const client = makeClient([sub('push-old', THIS_DEVICE)]);
    client.listPushSubscriptions = vi.fn(async () => {
      throw new Error('server down');
    });
    vi.stubGlobal('fetch', vi.fn(async () => {
      throw new Error('relay down');
    }));

    await expect(resyncWebPush({ client, relayBaseUrl: RELAY, inboxOnly: false })).resolves.toBe(false);
  });
});

// Spam filed straight into Junk used to wake the device: `EmailDelivery`
// fires for every ingested message. Servers that implement
// draft-ietf-jmap-emailpush evaluate a per-account filter before pushing, so
// the subscription carries one that excludes $junk and the Junk mailbox.
describe('enableWebPush delivery filter (emailPush)', () => {
  it('installs a junk-excluding filter for every account when the server supports it', async () => {
    localStorage.setItem(DEVICE_KEY, THIS_DEVICE);
    const client = makeClient([], { emailPushCapability: true });
    installFetch({});

    await enableWebPush({ client, relayBaseUrl: RELAY, inboxOnly: false });

    expect(client.createPushSubscription).toHaveBeenCalledTimes(1);
    const params = (client.createPushSubscription as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(params.types).toEqual(['EmailDelivery']);
    expect(params.emailPush).toEqual(EXPECTED_EMAIL_PUSH);
  });

  it('sends no emailPush to a server without the capability', async () => {
    localStorage.setItem(DEVICE_KEY, THIS_DEVICE);
    const client = makeClient([]);
    installFetch({});

    await enableWebPush({ client, relayBaseUrl: RELAY, inboxOnly: false });

    const params = (client.createPushSubscription as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(params).not.toHaveProperty('emailPush');
    expect(client.getAllMailboxes).not.toHaveBeenCalled();
  });

  it('adds the filter to an existing subscription that predates it', async () => {
    localStorage.setItem(DEVICE_KEY, THIS_DEVICE);
    localStorage.setItem(SUB_KEY, 'push-old');
    const client = makeClient([sub('push-old', THIS_DEVICE)], { emailPushCapability: true });
    installFetch({});

    const result = await enableWebPush({ client, relayBaseUrl: RELAY, inboxOnly: false });

    expect(result.subscriptionId).toBe('push-old');
    expect(client.createPushSubscription).not.toHaveBeenCalled();
    expect(client.updatePushSubscription).toHaveBeenCalledWith(
      'push-old',
      expect.objectContaining({ emailPush: EXPECTED_EMAIL_PUSH }),
    );
  });

  it('re-syncs a filter whose Junk mailbox id went stale', async () => {
    localStorage.setItem(DEVICE_KEY, THIS_DEVICE);
    localStorage.setItem(SUB_KEY, 'push-old');
    const stale = {
      ...EXPECTED_EMAIL_PUSH,
      [ACCOUNT_ID]: {
        ...EXPECTED_EMAIL_PUSH[ACCOUNT_ID],
        filter: {
          operator: 'AND',
          conditions: [{ notKeyword: '$junk' }, { inMailboxOtherThan: ['mb-junk-deleted'] }],
        },
      },
    };
    const client = makeClient(
      [sub('push-old', THIS_DEVICE, { emailPush: stale })],
      { emailPushCapability: true },
    );
    installFetch({});

    await enableWebPush({ client, relayBaseUrl: RELAY, inboxOnly: false });

    expect(client.updatePushSubscription).toHaveBeenCalledWith(
      'push-old',
      expect.objectContaining({ emailPush: EXPECTED_EMAIL_PUSH }),
    );
  });

  it('leaves a fresh subscription alone when its filter already matches', async () => {
    localStorage.setItem(DEVICE_KEY, THIS_DEVICE);
    localStorage.setItem(SUB_KEY, 'push-old');
    // Key order differs from what we build - must still compare equal.
    const stored = JSON.parse(JSON.stringify(EXPECTED_EMAIL_PUSH));
    stored[ACCOUNT_ID] = {
      urgency: 'high',
      properties: ['id', 'threadId'],
      filter: stored[ACCOUNT_ID].filter,
    };
    const client = makeClient(
      [sub('push-old', THIS_DEVICE, { emailPush: stored })],
      { emailPushCapability: true },
    );
    installFetch({});

    await enableWebPush({ client, relayBaseUrl: RELAY, inboxOnly: false });

    expect(client.updatePushSubscription).not.toHaveBeenCalled();
  });
});

// Inbox-only mode swaps the "not in Junk" mailbox condition for a positive
// "in Inbox" one, so mail a Sieve rule files into any other folder never
// reaches the push subscription.
describe('buildEmailPushConfig inbox-only mode', () => {
  it('keeps current behaviour when inboxOnly is false', async () => {
    const client = makeClient([], { emailPushCapability: true });
    expect(await buildEmailPushConfig(client, false)).toEqual(EXPECTED_EMAIL_PUSH);
  });

  it('requires the message to be in each account Inbox when inboxOnly is true', async () => {
    const client = makeClient([], { emailPushCapability: true });

    const config = await buildEmailPushConfig(client, true);

    expect(config[ACCOUNT_ID].filter).toEqual({
      operator: 'AND',
      conditions: [{ notKeyword: '$junk' }, { inMailbox: 'mb-inbox' }],
    });
    expect(config[SHARED_ACCOUNT_ID].filter).toEqual({
      operator: 'AND',
      conditions: [{ notKeyword: '$junk' }, { inMailbox: 'mb-shared-inbox' }],
    });
  });

  it('throws when an account has no discoverable Inbox mailbox', async () => {
    const client = makeClient([], { emailPushCapability: true });
    client.getAllMailboxes = vi.fn(async () => [
      { id: JUNK_ID, originalId: JUNK_ID, name: 'junk', role: 'junk', accountId: ACCOUNT_ID },
    ]) as unknown as IJMAPClient['getAllMailboxes'];

    await expect(buildEmailPushConfig(client, true)).rejects.toThrow(/No Inbox mailbox/);
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
