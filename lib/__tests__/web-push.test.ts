import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { IJMAPClient } from '@/lib/jmap/client-interface';
import type { AccountInfo, EmailPushConfig, PushSubscription as JmapPushSubscription } from '@/lib/jmap/types';
import { jmapError, jmapErrorType, jmapSetError } from '@/lib/jmap/jmap-error';
import { RateLimitError, RequestTimeoutError } from '@/lib/jmap/client';
import {
  buildEmailPushConfig,
  disableWebPush,
  enableWebPush,
  endWebPushForSignOut,
  isWebPushEnabled,
  listPushDevices,
  mailAccountsWithoutPush,
  enableWebPushForAccounts,
  resetWebPushResyncState,
  resyncWebPush,
  revokePushDevice,
  waitForWebPushResync,
} from '@/lib/web-push';
import { webPushErrorKey } from '@/lib/web-push-errors';
import { DEFAULT_RELAY_BASE_URL } from '@/lib/push-relays';
import { setNoThirdPartyTraffic } from '@/lib/third-party-mode';
import { keepRelayRegistration } from '@/lib/pwa-notify/worker-state';

const RELAY = 'https://relay.example';
const RELAY_BASE_KEY = `bulwark.push.relayBase.v1.${'acct-1'}`;
const ACCOUNT_ID = 'acct-1';
const THIS_DEVICE = 'aaaaaaaabbbbbbbbccccccccdddddddd';
const OTHER_DEVICE = '11111111222222223333333344444444';

const DEVICE_KEY = `bulwark.push.deviceClientId.v1.${ACCOUNT_ID}`;
const SUB_KEY = `bulwark.push.subscriptionId.v1.${ACCOUNT_ID}`;
const REFUSED_KEY = `bulwark.push.emailPushRefused.v1.${ACCOUNT_ID}`;

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
const MAIL_CAP = 'urn:ietf:params:jmap:mail';
const JUNK_ID = 'mb-junk';
// A group the user belongs to: Stalwart counts its members as owners, so the
// subscription fans out to it and it belongs in the emailPush map.
const GROUP_ACCOUNT_ID = 'acct-group';
const GROUP_JUNK_ID = 'mb-group-junk';
// Another user's account that shared a folder with this user by ACL: never
// in the fan-out, and refused in the emailPush map.
const ACL_ACCOUNT_ID = 'acct-acl';

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
  [GROUP_ACCOUNT_ID]: {
    filter: {
      operator: 'AND',
      conditions: [{ notKeyword: '$junk' }, { inMailboxOtherThan: [GROUP_JUNK_ID] }],
    },
    properties: ['id', 'threadId'],
    urgency: 'high',
  },
};

// The create flags Stalwart sets in accountCapabilities (to_account_capabilities
// in jmap-proto request/capability.rs): true on the user's own account and
// their groups, false on accounts shared with them by ACL. 0.16 and 1.0 alike.
function collectionCaps(owned: boolean): Record<string, unknown> {
  return {
    'urn:ietf:params:jmap:calendars': { maxCalendarsPerEvent: null, mayCreateCalendar: owned },
    'urn:ietf:params:jmap:contacts': { maxAddressBooksPerCard: null, mayCreateAddressBook: owned },
    'urn:ietf:params:jmap:filenode': { mayCreateTopLevelFileNode: owned },
  };
}

// Stalwart names an account after its principal's address.
const ACCOUNT_NAME = 'me@example.com';
const GROUP_NAME = 'team@example.com';
const ACL_NAME = 'colleague@example.com';
const NAMES: Record<string, string> = { [ACCOUNT_ID]: ACCOUNT_NAME, [GROUP_ACCOUNT_ID]: GROUP_NAME, [ACL_ACCOUNT_ID]: ACL_NAME };

function account(id: string, isPersonal: boolean, isReadOnly: boolean, caps: Record<string, unknown>): AccountInfo {
  return { name: NAMES[id], isPersonal, isReadOnly, accountCapabilities: caps };
}

// Stalwart 0.16.16 to 0.16.23 (jmap/src/api/session.rs): every secondary
// account lists emailpush, ACL shares included, and all of them are
// isPersonal:false, isReadOnly:false.
const SESSION_0_16: Record<string, AccountInfo> = {
  [ACCOUNT_ID]: account(ACCOUNT_ID, true, false, { [MAIL_CAP]: {}, [EMAIL_PUSH_CAP]: {}, ...collectionCaps(true) }),
  [GROUP_ACCOUNT_ID]: account(GROUP_ACCOUNT_ID, false, false, { [MAIL_CAP]: {}, [EMAIL_PUSH_CAP]: {}, ...collectionCaps(true) }),
  [ACL_ACCOUNT_ID]: account(ACL_ACCOUNT_ID, false, false, { [MAIL_CAP]: {}, [EMAIL_PUSH_CAP]: {}, ...collectionCaps(false) }),
};

// Stalwart 0.16.6 to 0.16.15: no emailpush anywhere.
const SESSION_0_16_15: Record<string, AccountInfo> = {
  [ACCOUNT_ID]: account(ACCOUNT_ID, true, false, { [MAIL_CAP]: {}, ...collectionCaps(true) }),
  [GROUP_ACCOUNT_ID]: account(GROUP_ACCOUNT_ID, false, false, { [MAIL_CAP]: {}, ...collectionCaps(true) }),
  [ACL_ACCOUNT_ID]: account(ACL_ACCOUNT_ID, false, false, { [MAIL_CAP]: {}, ...collectionCaps(false) }),
};

// Stalwart 1.0: accounts the user isn't a member of lose submission,
// vacationresponse, sieve, quota and emailpush; isReadOnly is computed (true
// for a read-only share); every account lists principals:owner.
const owner = (principalId: string) => ({
  'urn:ietf:params:jmap:principals:owner': { accountIdForPrincipal: ACCOUNT_ID, principalId },
});
const SESSION_1_0: Record<string, AccountInfo> = {
  [ACCOUNT_ID]: account(ACCOUNT_ID, true, false, {
    [MAIL_CAP]: {}, [EMAIL_PUSH_CAP]: {}, ...collectionCaps(true), ...owner(ACCOUNT_ID),
  }),
  [GROUP_ACCOUNT_ID]: account(GROUP_ACCOUNT_ID, false, false, {
    [MAIL_CAP]: {}, [EMAIL_PUSH_CAP]: {}, ...collectionCaps(true), ...owner(GROUP_ACCOUNT_ID),
  }),
  [ACL_ACCOUNT_ID]: account(ACL_ACCOUNT_ID, false, true, { [MAIL_CAP]: {}, ...collectionCaps(false), ...owner(ACL_ACCOUNT_ID) }),
};

// A group member whose role has no calendars, contacts or files: the group's
// account carries no create flag to tell it from an ACL share.
const MAIL_ONLY_GROUP_0_16 = { ...SESSION_0_16, [GROUP_ACCOUNT_ID]: account(GROUP_ACCOUNT_ID, false, false, { [MAIL_CAP]: {}, [EMAIL_PUSH_CAP]: {} }) };
const MAIL_ONLY_GROUP_1_0 = {
  ...SESSION_1_0,
  [GROUP_ACCOUNT_ID]: account(GROUP_ACCOUNT_ID, false, false, { [MAIL_CAP]: {}, [EMAIL_PUSH_CAP]: {}, ...owner(GROUP_ACCOUNT_ID) }),
};

// Stalwart's refusal of an emailPush map naming a non-member (push/set.rs
// parse_email_push), as client.ts throws it for notCreated.new / notUpdated.
const FORBIDDEN_MAP = { type: 'forbidden', description: 'No access to one of the accounts in the emailPush map.' };
const OVER_QUOTA = {
  type: 'overQuota',
  description: 'There are too many subscriptions, please delete some before adding a new one.',
};
const refusedMap = () => jmapSetError(`PushSubscription/set failed: ${FORBIDDEN_MAP.description}`, FORBIDDEN_MAP);

function makeClient(
  subs: JmapPushSubscription[],
  options: {
    emailPushCapability?: boolean;
    // The session's accounts; the primary and the group by default.
    accounts?: Record<string, AccountInfo>;
    // Accounts the server accepts in an emailPush map: Stalwart's is_member,
    // the user's own account and their groups.
    members?: string[];
    // The addresses of the user's identities. Stalwart 0.16 gives a group's
    // members one with the group's address.
    identities?: string[];
  } = {},
): FakeClient & IJMAPClient {
  const destroyed: string[] = [];
  const accounts = options.accounts ?? {
    [ACCOUNT_ID]: SESSION_0_16[ACCOUNT_ID],
    [GROUP_ACCOUNT_ID]: SESSION_0_16[GROUP_ACCOUNT_ID],
  };
  const members = options.members ?? [ACCOUNT_ID, GROUP_ACCOUNT_ID];
  const identities = options.identities ?? [ACCOUNT_NAME, GROUP_NAME];
  const accept = (emailPush?: Record<string, EmailPushConfig> | null) => {
    if (emailPush && Object.keys(emailPush).some((id) => !members.includes(id))) throw refusedMap();
  };
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
    hasAccountCapability: (capability: string, accountId?: string) =>
      capability in (accounts[accountId || ACCOUNT_ID]?.accountCapabilities ?? {}),
    getAccountInfo: (accountId: string) => accounts[accountId] ?? null,
    getIdentities: vi.fn(async () =>
      identities.map((email, i) => ({ id: `identity-${i}`, name: email, email, mayDelete: i > 0 }))),
    getAllMailboxes: vi.fn(async () => [
      mailbox('mb-inbox', 'inbox', ACCOUNT_ID),
      mailbox(JUNK_ID, 'junk', ACCOUNT_ID),
      mailbox('mb-archive', undefined, ACCOUNT_ID),
      mailbox('mb-group-inbox', 'inbox', GROUP_ACCOUNT_ID),
      mailbox(GROUP_JUNK_ID, 'junk', GROUP_ACCOUNT_ID),
      ...(accounts[ACL_ACCOUNT_ID] ? [mailbox('mb-acl-projects', undefined, ACL_ACCOUNT_ID)] : []),
    ]),
    listPushSubscriptions: vi.fn(async () => subs.filter((s) => !destroyed.includes(s.id))),
    createPushSubscription: vi.fn(async (params: { emailPush?: Record<string, EmailPushConfig> }) => {
      accept(params.emailPush);
      return 'push-new';
    }),
    verifyPushSubscription: vi.fn(async () => undefined),
    updatePushSubscription: vi.fn(async (_id: string, patch: { emailPush?: Record<string, EmailPushConfig> | null }) => {
      accept(patch.emailPush);
    }),
    destroyPushSubscription: vi.fn(async (id: string) => {
      destroyed.push(id);
    }),
  };
  return client as unknown as FakeClient & IJMAPClient;
}

// The accounts an emailPush map names, sorted.
const mapKeys = (emailPush: Record<string, EmailPushConfig> | null | undefined) =>
  Object.keys(emailPush ?? {}).sort();
const createCalls = (client: IJMAPClient) =>
  (client.createPushSubscription as ReturnType<typeof vi.fn>).mock.calls.map(
    (c) => c[0] as { emailPush?: Record<string, EmailPushConfig> },
  );
const updateCalls = (client: IJMAPClient) =>
  (client.updatePushSubscription as ReturnType<typeof vi.fn>).mock.calls.map(
    (c) => c[1] as { emailPush?: Record<string, EmailPushConfig> },
  );

// enableWebPush needs a browser that supports push; jsdom has none of it.
function installPushBrowser() {
  const browserSub = {
    endpoint: 'https://fcm.example/endpoint',
    // The key installFetch's relay advertises ('QUJD' = "ABC"), so the
    // browser subscription belongs to that relay unless a test says otherwise.
    options: { applicationServerKey: new Uint8Array([65, 66, 67]).buffer as ArrayBuffer | null },
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
      if (state === undefined || state === 'unknown') return json({ error: 'Unknown subscription' }, 404);
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
    // The old record keeps delivering until its replacement is verified.
    const destroy = client.destroyPushSubscription as ReturnType<typeof vi.fn>;
    const verify = client.verifyPushSubscription as ReturnType<typeof vi.fn>;
    const destroyOld = destroy.mock.invocationCallOrder[destroy.mock.calls.findIndex((c) => c[0] === 'push-old')];
    expect(destroyOld).toBeGreaterThan(verify.mock.invocationCallOrder[0]);
  });

  // Stalwart refuses a 16th subscription (the default limit is 15) and counts
  // the one Re-register replaces, which is only destroyed after its
  // replacement is verified.
  const overQuota = () => jmapSetError(`PushSubscription/set create failed: ${OVER_QUOTA.description}`, OVER_QUOTA);

  it('frees the recorded subscription\'s place and retries once when Re-register hits the limit', async () => {
    localStorage.setItem(DEVICE_KEY, THIS_DEVICE);
    localStorage.setItem(SUB_KEY, 'push-old');
    const client = makeClient([sub('push-old', THIS_DEVICE)]);
    const create = vi.fn()
      .mockRejectedValueOnce(overQuota())
      .mockResolvedValueOnce('push-new');
    client.createPushSubscription = create as unknown as IJMAPClient['createPushSubscription'];
    installFetch({});

    const result = await enableWebPush({ client, relayBaseUrl: RELAY, forceRecreate: true, inboxOnly: false });

    expect(result.subscriptionId).toBe('push-new');
    expect(localStorage.getItem(SUB_KEY)).toBe('push-new');
    expect(create).toHaveBeenCalledTimes(2);
    const destroy = client.destroyPushSubscription as ReturnType<typeof vi.fn>;
    expect(destroy.mock.calls).toEqual([['push-old']]);
    expect(destroy.mock.invocationCallOrder[0]).toBeGreaterThan(create.mock.invocationCallOrder[0]);
    expect(destroy.mock.invocationCallOrder[0]).toBeLessThan(create.mock.invocationCallOrder[1]);
  });

  it('reports the limit and leaves push off when the retry is refused too', async () => {
    localStorage.setItem(DEVICE_KEY, THIS_DEVICE);
    localStorage.setItem(SUB_KEY, 'push-old');
    const client = makeClient([sub('push-old', THIS_DEVICE)]);
    client.createPushSubscription = vi.fn(async () => {
      throw overQuota();
    }) as unknown as IJMAPClient['createPushSubscription'];
    installFetch({});

    const err = await enableWebPush({ client, relayBaseUrl: RELAY, forceRecreate: true, inboxOnly: false }).catch((e) => e);

    expect(jmapErrorType(err)).toBe('overQuota');
    expect(client.createPushSubscription).toHaveBeenCalledTimes(2);
    expect(client.destroyed).toEqual(['push-old']);
    expect(localStorage.getItem(SUB_KEY)).toBeNull();
  });

  it('keeps the working subscription at the limit when no Re-register was asked for', async () => {
    // Every map is refused on refresh, so a replacement is created, and the
    // server has no room for it: the old record keeps delivering.
    localStorage.setItem(DEVICE_KEY, THIS_DEVICE);
    localStorage.setItem(SUB_KEY, 'push-old');
    const client = makeClient([sub('push-old', THIS_DEVICE)], {
      emailPushCapability: true,
      accounts: SESSION_0_16,
      members: [],
    });
    client.createPushSubscription = vi.fn(async () => {
      throw overQuota();
    }) as unknown as IJMAPClient['createPushSubscription'];
    installFetch({});

    const err = await enableWebPush({ client, relayBaseUrl: RELAY, inboxOnly: false }).catch((e) => e);

    expect(jmapErrorType(err)).toBe('overQuota');
    expect(client.createPushSubscription).toHaveBeenCalledTimes(1);
    expect(client.destroyed).toEqual([]);
    expect(localStorage.getItem(SUB_KEY)).toBe('push-old');
  });

  it('leaves another device alone when the relay cannot vouch for it', async () => {
    localStorage.setItem(DEVICE_KEY, THIS_DEVICE);
    const client = makeClient([sub('push-other', OTHER_DEVICE)]);
    installFetch({ [OTHER_DEVICE]: 'unknown' });

    await enableWebPush({ client, relayBaseUrl: RELAY, forceRecreate: true, inboxOnly: false });

    expect(client.destroyed).not.toContain('push-other');
  });

  it('reuses a browser subscription made with this relay key', async () => {
    const { browserSub, registration } = installPushBrowser();
    installFetch({});

    await enableWebPush({ client: makeClient([]), relayBaseUrl: RELAY, inboxOnly: false });

    expect(browserSub.unsubscribe).not.toHaveBeenCalled();
    expect(registration.pushManager.subscribe).not.toHaveBeenCalled();
  });

  it('replaces a browser subscription made with another relay key', async () => {
    const { browserSub, registration } = installPushBrowser();
    browserSub.options.applicationServerKey = new Uint8Array([9, 9, 9]).buffer;
    const calls = installFetch({});

    await enableWebPush({ client: makeClient([]), relayBaseUrl: RELAY, inboxOnly: false });

    expect(browserSub.unsubscribe).toHaveBeenCalledTimes(1);
    expect(registration.pushManager.subscribe).toHaveBeenCalledTimes(1);
    const [{ applicationServerKey }] = registration.pushManager.subscribe.mock.calls[0] as unknown as [
      { applicationServerKey: Uint8Array },
    ];
    expect(Array.from(applicationServerKey)).toEqual([65, 66, 67]);
    expect(calls.some((c) => c.url.endsWith('/api/push/register/web'))).toBe(true);
  });

  it('subscribes anyway when the browser cannot retrieve the existing subscription', async () => {
    // Firefox rejects the lookup with `AbortError: Error retrieving push
    // subscription` when its local record is stale; that must not abort enable.
    const { registration } = installPushBrowser();
    registration.pushManager.getSubscription.mockRejectedValue(
      new DOMException('Error retrieving push subscription', 'AbortError'),
    );
    installFetch({});

    const result = await enableWebPush({ client: makeClient([]), relayBaseUrl: RELAY, inboxOnly: false });

    expect(registration.pushManager.subscribe).toHaveBeenCalledTimes(1);
    expect(result.subscriptionId).toBe('push-new');
  });

  it('still subscribes when unsubscribing the mismatched subscription fails', async () => {
    const { browserSub, registration } = installPushBrowser();
    browserSub.options.applicationServerKey = new Uint8Array([9, 9, 9]).buffer;
    browserSub.unsubscribe.mockRejectedValue(new Error('unsubscribe failed'));
    installFetch({});

    await enableWebPush({ client: makeClient([]), relayBaseUrl: RELAY, inboxOnly: false });

    expect(registration.pushManager.subscribe).toHaveBeenCalledTimes(1);
  });

  it('replaces a browser subscription whose key the browser does not expose', async () => {
    const { browserSub, registration } = installPushBrowser();
    browserSub.options.applicationServerKey = null;
    installFetch({});

    await enableWebPush({ client: makeClient([]), relayBaseUrl: RELAY, inboxOnly: false });

    expect(browserSub.unsubscribe).toHaveBeenCalledTimes(1);
    expect(registration.pushManager.subscribe).toHaveBeenCalledTimes(1);
  });
});

// Registrations made before the client learned about the delivery filter are
// repaired in the background on app start - nobody should have to find the
// settings toggle to stop the spam pushes.
describe('enableWebPush when the verification does not come', () => {
  // The relay's poll stays empty until `arrivesAfterTouch` calls come in, like a
  // Stalwart that skipped the verification until the subscription is touched.
  function installSilentRelay(codeOnceTouched: () => boolean) {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      const json = (body: unknown) => ({ ok: true, status: 200, json: async () => body }) as Response;
      if (url.endsWith('/api/push/vapid-public-key')) return json({ publicKey: 'QUJD' });
      if (url.includes('/api/push/verify/')) return json({ verificationCode: codeOnceTouched() ? 'late-code' : null });
      return json({});
    });
    vi.stubGlobal('fetch', fetchMock);
  }

  afterEach(() => { vi.useRealTimers(); });

  it('keeps polling through a network blip', async () => {
    vi.useFakeTimers();
    const client = makeClient([]);
    let polls = 0;
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      const json = (body: unknown) => ({ ok: true, status: 200, json: async () => body }) as Response;
      if (url.endsWith('/api/push/vapid-public-key')) return json({ publicKey: 'QUJD' });
      if (url.includes('/api/push/verify/')) {
        polls += 1;
        if (polls === 1) throw new TypeError('Failed to fetch');
        return json({ verificationCode: 'code' });
      }
      return json({});
    });
    vi.stubGlobal('fetch', fetchMock);

    const settled = enableWebPush({ client, relayBaseUrl: RELAY, inboxOnly: false }).then(() => 'done', (error: Error) => error.message);
    await vi.advanceTimersByTimeAsync(5_000);

    expect(await settled).toBe('done');
    expect(client.verifyPushSubscription).toHaveBeenCalledWith('push-new', 'code');
  });

  it('removes its unverified subscription and reads as off when the code never comes', async () => {
    vi.useFakeTimers();
    const client = makeClient([]);
    installSilentRelay(() => false);

    const settled = enableWebPush({ client, relayBaseUrl: RELAY, inboxOnly: false }).then(() => 'done', (error: Error) => error.message);
    await vi.advanceTimersByTimeAsync(120_000);

    expect(await settled).toMatch(/verif/i);
    expect(client.destroyed).toEqual(['push-new']);
    expect(localStorage.getItem(SUB_KEY)).toBeNull();
    expect(client.verifyPushSubscription).not.toHaveBeenCalled();
  });

  it('removes its subscription when the server refuses the code', async () => {
    const client = makeClient([]);
    installFetch({});
    (client.verifyPushSubscription as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error('Verification code does not match.'));

    await expect(enableWebPush({ client, relayBaseUrl: RELAY, inboxOnly: false })).rejects.toThrow('does not match');

    expect(client.destroyed).toEqual(['push-new']);
    expect(localStorage.getItem(SUB_KEY)).toBeNull();
  });

  it('keeps the old subscription working when its replacement fails verification', async () => {
    localStorage.setItem(DEVICE_KEY, THIS_DEVICE);
    localStorage.setItem(SUB_KEY, 'push-old');
    const client = makeClient([sub('push-old', THIS_DEVICE)]);
    installFetch({});
    (client.verifyPushSubscription as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error('nope'));

    await expect(enableWebPush({ client, relayBaseUrl: RELAY, inboxOnly: false, forceRecreate: true })).rejects.toThrow('nope');

    expect(client.destroyed).toEqual(['push-new']);
    expect(localStorage.getItem(SUB_KEY)).toBe('push-old');
  });

  it('touches the subscription after the server\'s minute, which makes it send the code', async () => {
    vi.useFakeTimers();
    const client = makeClient([]);
    installSilentRelay(() => (client.updatePushSubscription as ReturnType<typeof vi.fn>).mock.calls.length > 0);

    const run = enableWebPush({ client, relayBaseUrl: RELAY, inboxOnly: false });
    const settled = run.then(() => 'done', (error: Error) => error.message);
    await vi.advanceTimersByTimeAsync(58_000);
    expect(client.updatePushSubscription).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(10_000);

    expect(client.updatePushSubscription).toHaveBeenCalledTimes(1);
    expect((client.updatePushSubscription as ReturnType<typeof vi.fn>).mock.calls[0][0]).toBe('push-new');
    await vi.advanceTimersByTimeAsync(5_000);
    expect(await settled).toBe('done');
    expect(client.verifyPushSubscription).toHaveBeenCalledWith('push-new', 'late-code');
  });
});

describe('two tabs at once', () => {
  // What the browser's Web Locks do: one holder at a time, in order.
  function installLocks() {
    let tail: Promise<unknown> = Promise.resolve();
    const request = vi.fn(async (_name: string, run: () => Promise<unknown>) => {
      const next = tail.then(run, run);
      tail = next.catch(() => undefined);
      return next;
    });
    Object.defineProperty(navigator, 'locks', { configurable: true, value: { request } });
    return request;
  }

  afterEach(() => {
    delete (navigator as unknown as { locks?: unknown }).locks;
  });

  // A server that knows what was created and destroyed, as the race needs.
  function statefulClient() {
    const subs: JmapPushSubscription[] = [];
    const client = makeClient(subs);
    let next = 0;
    (client.createPushSubscription as ReturnType<typeof vi.fn>).mockImplementation(async (params: { deviceClientId: string }) => {
      const id = `push-${++next}`;
      subs.push(sub(id, params.deviceClientId));
      return id;
    });
    (client.verifyPushSubscription as ReturnType<typeof vi.fn>).mockImplementation(async (id: string) => {
      if (client.destroyed.includes(id)) throw new Error('notFound');
    });
    return client;
  }

  it('makes one subscription, and neither tab fails', async () => {
    installLocks();
    const client = statefulClient();
    installFetch({});

    const results = await Promise.allSettled([
      enableWebPush({ client, relayBaseUrl: RELAY, inboxOnly: false }),
      enableWebPush({ client, relayBaseUrl: RELAY, inboxOnly: false }),
    ]);

    expect(results.map((r) => r.status)).toEqual(['fulfilled', 'fulfilled']);
    expect(client.createPushSubscription).toHaveBeenCalledTimes(1);
    expect(client.destroyed).toEqual([]);
    expect(await client.listPushSubscriptions()).toHaveLength(1);
  });

  it('waits for a running enable before turning off', async () => {
    const request = installLocks();
    const client = statefulClient();
    installFetch({});

    const enabling = enableWebPush({ client, relayBaseUrl: RELAY, inboxOnly: false });
    await vi.waitFor(() => expect(request).toHaveBeenCalledTimes(1));
    await Promise.all([enabling, disableWebPush({ client, relayBaseUrl: RELAY })]);

    expect(request).toHaveBeenCalledTimes(2);
    expect(await client.listPushSubscriptions()).toEqual([]);
    expect(localStorage.getItem(SUB_KEY)).toBeNull();
  });

  it('still works in a browser without Web Locks', async () => {
    const client = statefulClient();
    installFetch({});
    await enableWebPush({ client, relayBaseUrl: RELAY, inboxOnly: false });
    expect(client.createPushSubscription).toHaveBeenCalledTimes(1);
  });
});

describe('what enabling and disabling say when they fail', () => {
  it('tells a blocked browser from a question not answered', async () => {
    const client = makeClient([]);
    installFetch({});
    (globalThis as unknown as { Notification: unknown }).Notification = { permission: 'denied' };
    (window as unknown as { Notification: unknown }).Notification = { permission: 'denied' };
    await expect(enableWebPush({ client, relayBaseUrl: RELAY, inboxOnly: false })).rejects.toSatisfy((e) => webPushErrorKey(e) === 'error_blocked');

    const unanswered = { permission: 'default', requestPermission: async () => 'default' };
    (globalThis as unknown as { Notification: unknown }).Notification = unanswered;
    (window as unknown as { Notification: unknown }).Notification = unanswered;
    await expect(enableWebPush({ client, relayBaseUrl: RELAY, inboxOnly: false })).rejects.toSatisfy((e) => webPushErrorKey(e) === 'error_not_granted');
    expect(client.createPushSubscription).not.toHaveBeenCalled();
  });

  it('names an unreachable relay, and a relay that refuses', async () => {
    const client = makeClient([]);
    vi.stubGlobal('fetch', vi.fn(async () => { throw new TypeError('Failed to fetch'); }));
    await expect(enableWebPush({ client, relayBaseUrl: RELAY, inboxOnly: false })).rejects.toSatisfy((e) => webPushErrorKey(e) === 'error_relay');

    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const json = (body: unknown, status = 200) => ({ ok: status < 300, status, json: async () => body }) as Response;
      return String(input).endsWith('/vapid-public-key') ? json({ publicKey: 'QUJD' }) : json({}, 500);
    }));
    await expect(enableWebPush({ client, relayBaseUrl: RELAY, inboxOnly: false })).rejects.toSatisfy((e) => webPushErrorKey(e) === 'error_relay');
    expect(client.createPushSubscription).not.toHaveBeenCalled();
  });

  it('names a verification that never came', async () => {
    vi.useFakeTimers();
    try {
      const client = makeClient([]);
      vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        const json = (body: unknown) => ({ ok: true, status: 200, json: async () => body }) as Response;
        if (url.endsWith('/vapid-public-key')) return json({ publicKey: 'QUJD' });
        return json({ verificationCode: null });
      }));
      const settled = enableWebPush({ client, relayBaseUrl: RELAY, inboxOnly: false }).catch((e: unknown) => webPushErrorKey(e));
      await vi.advanceTimersByTimeAsync(120_000);
      expect(await settled).toBe('error_verification_timeout');
    } finally {
      vi.useRealTimers();
    }
  });

  it('keeps naming the server refusals, and nothing for an unknown error', () => {
    expect(webPushErrorKey(refusedMap())).toBe('error_forbidden');
    expect(webPushErrorKey(jmapSetError('x', OVER_QUOTA))).toBe('error_over_quota');
    expect(webPushErrorKey(new Error('boom'))).toBeNull();
  });

  it('says so when turning off could not reach the server, and still ends up off here', async () => {
    localStorage.setItem(DEVICE_KEY, THIS_DEVICE);
    localStorage.setItem(SUB_KEY, 'push-mine');
    const client = makeClient([sub('push-mine', THIS_DEVICE)]);
    installFetch({});
    (client.destroyPushSubscription as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('offline'));

    await expect(disableWebPush({ client, relayBaseUrl: RELAY })).rejects.toSatisfy((e) => webPushErrorKey(e) === 'error_teardown');

    expect(localStorage.getItem(SUB_KEY)).toBeNull();
  });

  it('says so when turning off could not reach the relay', async () => {
    localStorage.setItem(DEVICE_KEY, THIS_DEVICE);
    localStorage.setItem(SUB_KEY, 'push-mine');
    const client = makeClient([sub('push-mine', THIS_DEVICE)]);
    vi.stubGlobal('fetch', vi.fn(async () => { throw new TypeError('Failed to fetch'); }));

    await expect(disableWebPush({ client, relayBaseUrl: RELAY })).rejects.toSatisfy((e) => webPushErrorKey(e) === 'error_teardown');

    expect(client.destroyed).toEqual(['push-mine']);
    expect(localStorage.getItem(SUB_KEY)).toBeNull();
  });

  it('does not count a record the relay no longer has as a failure', async () => {
    localStorage.setItem(DEVICE_KEY, THIS_DEVICE);
    localStorage.setItem(SUB_KEY, 'push-mine');
    const client = makeClient([sub('push-mine', THIS_DEVICE)]);
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, status: 404, json: async () => ({}) })));

    await expect(disableWebPush({ client, relayBaseUrl: RELAY })).resolves.toBeUndefined();
  });

  it('keeps the browser subscription for the other account, and says nothing when all went well', async () => {
    const { browserSub } = installPushBrowser();
    localStorage.setItem(DEVICE_KEY, THIS_DEVICE);
    localStorage.setItem(SUB_KEY, 'push-mine');
    localStorage.setItem('bulwark.push.subscriptionId.v1.other-account', 'push-other');
    const client = makeClient([sub('push-mine', THIS_DEVICE)]);
    installFetch({});

    await expect(disableWebPush({ client, relayBaseUrl: RELAY })).resolves.toBeUndefined();

    expect(browserSub.unsubscribe).not.toHaveBeenCalled();
  });
});

describe('an endpoint the push service gave up on', () => {
  const ENDPOINT_KEY = `bulwark.push.endpoint.v1.${ACCOUNT_ID}`;

  function registered() {
    localStorage.setItem(DEVICE_KEY, THIS_DEVICE);
    localStorage.setItem(SUB_KEY, 'push-mine');
    localStorage.setItem(RELAY_BASE_KEY, RELAY);
    localStorage.setItem(ENDPOINT_KEY, 'https://fcm.example/endpoint');
    return makeClient([sub('push-mine', THIS_DEVICE)]);
  }

  it('gets a new subscription when the relay dropped the record for the very endpoint this browser still holds', async () => {
    const { browserSub, registration } = installPushBrowser();
    const client = registered();
    installFetch({}); // The relay answers 404 for this device.

    await resyncWebPush({ client, relayBaseUrl: RELAY, inboxOnly: false });

    expect(browserSub.unsubscribe).toHaveBeenCalledTimes(1);
    expect(registration.pushManager.subscribe).toHaveBeenCalledTimes(1);
  });

  it('does not take a relay that lacks the route for one that lost the record', async () => {
    const { browserSub } = installPushBrowser();
    const client = registered();
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      const json = (body: unknown, status = 200) => ({ ok: status < 300, status, json: async () => body }) as Response;
      if (url.includes('/api/push/active/')) return json({ error: 'Not found' }, 404);
      return url.endsWith('/vapid-public-key') ? json({ publicKey: 'QUJD' }) : json({});
    }));

    await resyncWebPush({ client, relayBaseUrl: RELAY, inboxOnly: false });

    expect(browserSub.unsubscribe).not.toHaveBeenCalled();
  });

  it('moves the other logins to the new endpoint, connected or not', async () => {
    const { registration } = installPushBrowser();
    const moved = { endpoint: 'https://fcm.example/moved', options: { applicationServerKey: new Uint8Array([65, 66, 67]).buffer }, getKey: () => new Uint8Array([1, 2, 3]).buffer, unsubscribe: vi.fn(async () => true) };
    (registration.pushManager.subscribe as ReturnType<typeof vi.fn>).mockResolvedValue(moved);
    const stored = new Map<string, string>();
    vi.stubGlobal('caches', {
      open: async () => ({
        match: async (key: string) => (stored.has(key) ? new Response(stored.get(key)) : undefined),
        put: async (key: string, res: Response) => { stored.set(key, await res.text()); },
      }),
    });
    await keepRelayRegistration('other-login', { relay: 'https://relay-of-other.example', subscriptionId: 'device-other', accountLabel: 'o@example.org' }, 'QUJD');
    const client = registered();
    const bodies: Array<{ url: string; body: { subscriptionId: string; subscription: { endpoint: string }; accountLabel?: string } }> = [];
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const json = (body: unknown, status = 200) => ({ ok: status < 300, status, json: async () => body }) as Response;
      if (url.endsWith('/vapid-public-key')) return json({ publicKey: 'QUJD' });
      if (url.includes('/api/push/active/')) return json({ error: 'Unknown subscription' }, 404);
      if (url.endsWith('/api/push/register/web')) bodies.push({ url, body: JSON.parse(String(init?.body)) });
      return json({});
    }));

    await resyncWebPush({ client, relayBaseUrl: RELAY, inboxOnly: false });

    const other = bodies.find((b) => b.body.subscriptionId === 'device-other');
    expect(other?.url).toBe('https://relay-of-other.example/api/push/register/web');
    expect(other?.body.subscription.endpoint).toBe('https://fcm.example/moved');
    expect(other?.body.accountLabel).toBe('o@example.org');
    expect(bodies.filter((b) => b.body.subscriptionId === THIS_DEVICE)).toHaveLength(1);
  });

  it('keeps the subscription while the relay knows the record', async () => {
    const { browserSub } = installPushBrowser();
    const client = registered();
    installFetch({ [THIS_DEVICE]: true });

    await resyncWebPush({ client, relayBaseUrl: RELAY, inboxOnly: false });

    expect(browserSub.unsubscribe).not.toHaveBeenCalled();
  });

  it('keeps it when the relay cannot be asked', async () => {
    const { browserSub } = installPushBrowser();
    const client = registered();
    const calls: string[] = [];
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      calls.push(url);
      if (url.includes('/api/push/active/')) throw new TypeError('blip');
      const json = (body: unknown) => ({ ok: true, status: 200, json: async () => body }) as Response;
      return url.endsWith('/vapid-public-key') ? json({ publicKey: 'QUJD' }) : json({});
    }));

    await resyncWebPush({ client, relayBaseUrl: RELAY, inboxOnly: false });

    expect(calls.some((url) => url.includes('/api/push/active/'))).toBe(true);
    expect(browserSub.unsubscribe).not.toHaveBeenCalled();
  });

  it('only registers when another account already moved the browser to a new endpoint', async () => {
    const { browserSub } = installPushBrowser();
    const client = registered();
    localStorage.setItem(ENDPOINT_KEY, 'https://fcm.example/older');
    installFetch({});

    await resyncWebPush({ client, relayBaseUrl: RELAY, inboxOnly: false });

    expect(browserSub.unsubscribe).not.toHaveBeenCalled();
    expect(localStorage.getItem(ENDPOINT_KEY)).toBe('https://fcm.example/endpoint');
  });

  it('does not mistake a move to another relay for a dead endpoint', async () => {
    const { browserSub } = installPushBrowser();
    const client = registered();
    localStorage.setItem(RELAY_BASE_KEY, 'https://old-relay.example');
    installFetch({});

    await resyncWebPush({ client, relayBaseUrl: RELAY, inboxOnly: false });

    expect(browserSub.unsubscribe).not.toHaveBeenCalled();
  });
});

describe('a subscription id the server gave to another device', () => {
  // Stalwart hands out the lowest free id: this browser's subscription expired,
  // and the phone that registered next got the same id.
  it('creates its own instead of taking over the other device\'s', async () => {
    localStorage.setItem(DEVICE_KEY, THIS_DEVICE);
    localStorage.setItem(SUB_KEY, 'b');
    const client = makeClient([sub('b', OTHER_DEVICE)]);
    installFetch({ [OTHER_DEVICE]: true });

    await enableWebPush({ client, relayBaseUrl: RELAY, inboxOnly: false });

    expect(client.updatePushSubscription).not.toHaveBeenCalled();
    expect(client.createPushSubscription).toHaveBeenCalledTimes(1);
    expect(client.destroyed).toEqual([]);
    expect(localStorage.getItem(SUB_KEY)).toBe('push-new');
  });

  it('leaves it alone when turning off', async () => {
    localStorage.setItem(DEVICE_KEY, THIS_DEVICE);
    localStorage.setItem(SUB_KEY, 'b');
    const client = makeClient([sub('b', OTHER_DEVICE)]);
    installFetch({});

    await disableWebPush({ client, relayBaseUrl: RELAY });

    expect(client.destroyed).toEqual([]);
  });

  it('leaves it alone on Re-register', async () => {
    localStorage.setItem(DEVICE_KEY, THIS_DEVICE);
    localStorage.setItem(SUB_KEY, 'b');
    const client = makeClient([sub('b', OTHER_DEVICE)]);
    installFetch({ [OTHER_DEVICE]: true });

    await enableWebPush({ client, relayBaseUrl: RELAY, inboxOnly: false, forceRecreate: true });

    expect(client.destroyed).toEqual([]);
  });
});

describe('resyncWebPush when the relay changed (#903)', () => {
  afterEach(() => setNoThirdPartyTraffic(false));

  it('moves a registration made with the built-in relay to the admin relay with no third-party traffic', async () => {
    setNoThirdPartyTraffic(true);
    localStorage.setItem(DEVICE_KEY, THIS_DEVICE);
    localStorage.setItem(SUB_KEY, 'push-old');
    localStorage.setItem(RELAY_BASE_KEY, DEFAULT_RELAY_BASE_URL);
    const client = makeClient([sub('push-old', THIS_DEVICE, { url: `${DEFAULT_RELAY_BASE_URL}/api/push/jmap/${THIS_DEVICE}` })]);
    const calls = installFetch({});

    expect(await resyncWebPush({ client, relayBaseUrl: RELAY, inboxOnly: false })).toBe(true);
    // A new server record that points at the admin relay replaces the old one.
    expect((client.createPushSubscription as ReturnType<typeof vi.fn>).mock.calls[0][0]).toMatchObject({ url: `${RELAY}/api/push/jmap/${THIS_DEVICE}` });
    expect(client.destroyed).toContain('push-old');
    expect(client.updatePushSubscription).not.toHaveBeenCalled();
    expect(localStorage.getItem(RELAY_BASE_KEY)).toBe(RELAY);
    expect(calls.some((c) => c.url.startsWith(DEFAULT_RELAY_BASE_URL))).toBe(false);
  });

  it('treats a registration from before the relay was recorded as the built-in one in that mode', async () => {
    setNoThirdPartyTraffic(true);
    localStorage.setItem(DEVICE_KEY, THIS_DEVICE);
    localStorage.setItem(SUB_KEY, 'push-old');
    const client = makeClient([sub('push-old', THIS_DEVICE)]);
    installFetch({});

    expect(await resyncWebPush({ client, relayBaseUrl: RELAY, inboxOnly: false })).toBe(true);
    expect(client.createPushSubscription).toHaveBeenCalledTimes(1);
    expect(client.destroyed).toContain('push-old');
  });

  it('leaves no record on the relay it moved away from', async () => {
    localStorage.setItem(DEVICE_KEY, THIS_DEVICE);
    localStorage.setItem(SUB_KEY, 'push-old');
    localStorage.setItem(RELAY_BASE_KEY, 'https://old-relay.example');
    const client = makeClient([sub('push-old', THIS_DEVICE)]);
    const calls = installFetch({});

    expect(await resyncWebPush({ client, relayBaseUrl: RELAY, inboxOnly: false })).toBe(true);

    expect(calls).toContainEqual({ url: `https://old-relay.example/api/push/register/${THIS_DEVICE}`, method: 'DELETE' });
    expect(calls).not.toContainEqual({ url: `${RELAY}/api/push/register/${THIS_DEVICE}`, method: 'DELETE' });
    expect(localStorage.getItem(RELAY_BASE_KEY)).toBe(RELAY);
    expect(client.destroyed).toEqual(['push-old']);
  });

  it('keeps the old relay until the new subscription is verified', async () => {
    localStorage.setItem(DEVICE_KEY, THIS_DEVICE);
    localStorage.setItem(SUB_KEY, 'push-old');
    localStorage.setItem(RELAY_BASE_KEY, 'https://old-relay.example');
    const client = makeClient([sub('push-old', THIS_DEVICE)]);
    const calls = installFetch({});
    (client.verifyPushSubscription as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error('nope'));

    await resyncWebPush({ client, relayBaseUrl: RELAY, inboxOnly: false });

    expect(calls.some((c) => c.method === 'DELETE')).toBe(false);
    expect(localStorage.getItem(RELAY_BASE_KEY)).toBe('https://old-relay.example');
  });

  it('does not contact the built-in relay to clean up when third-party traffic is off', async () => {
    setNoThirdPartyTraffic(true);
    localStorage.setItem(DEVICE_KEY, THIS_DEVICE);
    localStorage.setItem(SUB_KEY, 'push-old');
    localStorage.setItem(RELAY_BASE_KEY, DEFAULT_RELAY_BASE_URL);
    const client = makeClient([sub('push-old', THIS_DEVICE)]);
    const calls = installFetch({});

    await resyncWebPush({ client, relayBaseUrl: RELAY, inboxOnly: false });

    expect(calls.filter((c) => c.url.startsWith(DEFAULT_RELAY_BASE_URL))).toEqual([]);
  });

  it('re-registers inside the daily limit when the admin switched relays, and only once', async () => {
    localStorage.setItem(DEVICE_KEY, THIS_DEVICE);
    localStorage.setItem(SUB_KEY, 'push-old');
    localStorage.setItem(RELAY_BASE_KEY, 'https://old-relay.example');
    const client = makeClient([sub('push-old', THIS_DEVICE)]);
    installFetch({});

    expect(await resyncWebPush({ client, relayBaseUrl: RELAY, inboxOnly: false })).toBe(true);
    expect(client.createPushSubscription).toHaveBeenCalledTimes(1);
    expect(await resyncWebPush({ client, relayBaseUrl: RELAY, inboxOnly: false })).toBe(false);
    expect(client.createPushSubscription).toHaveBeenCalledTimes(1);
  });
});

describe('resyncWebPush', () => {
  it('repairs a lost browser subscription for an account that previously opted in', async () => {
    localStorage.setItem(DEVICE_KEY, THIS_DEVICE);
    localStorage.setItem(SUB_KEY, 'push-old');
    const { registration } = installPushBrowser();
    registration.pushManager.getSubscription.mockResolvedValue(null as never);
    const client = makeClient([sub('push-old', THIS_DEVICE)]);
    const calls = installFetch({});

    expect(await isWebPushEnabled(ACCOUNT_ID)).toBe(false);
    expect(await resyncWebPush({ client, relayBaseUrl: RELAY, inboxOnly: false })).toBe(true);
    expect(registration.pushManager.subscribe).toHaveBeenCalledTimes(1);
    expect(calls).toContainEqual({ url: `${RELAY}/api/push/register/web`, method: 'POST' });
  });

  it.each(['default', 'denied'])('does not resubscribe or prompt with %s permission', async (permission) => {
    localStorage.setItem(SUB_KEY, 'push-old');
    const { registration } = installPushBrowser();
    vi.stubGlobal('Notification', { permission, requestPermission: vi.fn() });
    const client = makeClient([sub('push-old', THIS_DEVICE)]);
    expect(await resyncWebPush({ client, relayBaseUrl: RELAY, inboxOnly: false })).toBe(false);
    expect(registration.pushManager.subscribe).not.toHaveBeenCalled();
    expect(Notification.requestPermission).not.toHaveBeenCalled();
  });

  it('allows retry after a transient relay failure', async () => {
    localStorage.setItem(SUB_KEY, 'push-old');
    localStorage.setItem(DEVICE_KEY, THIS_DEVICE);
    const client = makeClient([sub('push-old', THIS_DEVICE)]);
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('offline')));
    expect(await resyncWebPush({ client, relayBaseUrl: RELAY, inboxOnly: false })).toBe(false);
    installFetch({});
    // Not on the very next tab focus...
    expect(await resyncWebPush({ client, relayBaseUrl: RELAY, inboxOnly: false })).toBe(false);
    // ...but a quarter of an hour later.
    const later = Date.now() + 16 * 60_000;
    vi.spyOn(Date, 'now').mockReturnValue(later);
    try {
      expect(await resyncWebPush({ client, relayBaseUrl: RELAY, inboxOnly: false })).toBe(true);
    } finally {
      vi.mocked(Date.now).mockRestore();
    }
  });

  it('keeps the opt-in when recreating the subscription fails', async () => {
    localStorage.setItem(SUB_KEY, 'push-old');
    localStorage.setItem(DEVICE_KEY, THIS_DEVICE);
    // The server lost the old subscription, and creating a new one fails.
    const client = makeClient([]);
    vi.mocked(client.createPushSubscription).mockRejectedValue(new Error('server down'));
    installFetch({});
    expect(await resyncWebPush({ client, relayBaseUrl: RELAY, inboxOnly: false })).toBe(false);
    expect(localStorage.getItem(SUB_KEY)).toBe('push-old');
  });

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

  it('runs at most once a day per account', async () => {
    localStorage.setItem(DEVICE_KEY, THIS_DEVICE);
    localStorage.setItem(SUB_KEY, 'push-old');
    const client = makeClient([sub('push-old', THIS_DEVICE)], { emailPushCapability: true });
    installFetch({});
    const now = vi.spyOn(Date, 'now').mockReturnValue(1_000_000);

    expect(await resyncWebPush({ client, relayBaseUrl: RELAY, inboxOnly: false })).toBe(true);
    expect(await resyncWebPush({ client, relayBaseUrl: RELAY, inboxOnly: false })).toBe(false);
    expect(client.listPushSubscriptions).toHaveBeenCalledTimes(1);

    // A tab left open past a day renews again, before Stalwart's 7-day expiry.
    now.mockReturnValue(1_000_000 + 25 * 60 * 60 * 1000);
    expect(await resyncWebPush({ client, relayBaseUrl: RELAY, inboxOnly: false })).toBe(true);
    expect(client.listPushSubscriptions).toHaveBeenCalledTimes(2);
    now.mockRestore();
  });

  it('repairs a subscription the browser dropped while the tab stayed open, inside the daily limit (#1321)', async () => {
    localStorage.setItem(DEVICE_KEY, THIS_DEVICE);
    localStorage.setItem(SUB_KEY, 'push-old');
    const { registration } = installPushBrowser();
    const client = makeClient([sub('push-old', THIS_DEVICE)]);
    installFetch({});
    expect(await resyncWebPush({ client, relayBaseUrl: RELAY, inboxOnly: false })).toBe(true);
    expect(registration.pushManager.subscribe).not.toHaveBeenCalled();

    // Safari cleared the site data: the browser subscription is gone, the
    // saved opt-in is not. The next return to the tab puts it back.
    registration.pushManager.getSubscription.mockResolvedValue(null as never);
    expect(await resyncWebPush({ client, relayBaseUrl: RELAY, inboxOnly: false })).toBe(true);
    expect(registration.pushManager.subscribe).toHaveBeenCalledTimes(1);
  });

  it('does not retry a failed repair on every return to the tab', async () => {
    localStorage.setItem(DEVICE_KEY, THIS_DEVICE);
    localStorage.setItem(SUB_KEY, 'push-old');
    const { registration } = installPushBrowser();
    registration.pushManager.getSubscription.mockResolvedValue(null as never);
    const client = makeClient([sub('push-old', THIS_DEVICE)]);
    const fetchMock = vi.fn().mockRejectedValue(new Error('offline'));
    vi.stubGlobal('fetch', fetchMock);
    expect(await resyncWebPush({ client, relayBaseUrl: RELAY, inboxOnly: false })).toBe(false);
    expect(await resyncWebPush({ client, relayBaseUrl: RELAY, inboxOnly: false })).toBe(false);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('runs one re-sync at a time per login and lets callers wait for it (#1321)', async () => {
    localStorage.setItem(DEVICE_KEY, THIS_DEVICE);
    localStorage.setItem(SUB_KEY, 'push-old');
    const { registration, browserSub } = installPushBrowser();
    registration.pushManager.getSubscription.mockResolvedValue(null as never);
    // The browser is still talking to the push service.
    let subscribed!: () => void;
    registration.pushManager.subscribe.mockReturnValueOnce(
      new Promise((resolve) => { subscribed = () => resolve(browserSub); }) as never,
    );
    const client = makeClient([sub('push-old', THIS_DEVICE)]);
    installFetch({});

    const first = resyncWebPush({ client, relayBaseUrl: RELAY, inboxOnly: false });
    // A second call meanwhile - the tab came back to the foreground - joins
    // the running one instead of racing it on the shared subscription.
    const second = resyncWebPush({ client, relayBaseUrl: RELAY, inboxOnly: false });
    let settled = false;
    const waited = waitForWebPushResync(ACCOUNT_ID).then(() => { settled = true; });
    await new Promise((r) => setTimeout(r, 0));
    expect(await isWebPushEnabled(ACCOUNT_ID)).toBe(false);
    expect(settled).toBe(false);
    expect(client.listPushSubscriptions).not.toHaveBeenCalled();

    registration.pushManager.getSubscription.mockResolvedValue(browserSub);
    subscribed();
    expect(await Promise.all([first, second])).toEqual([true, true]);
    await waited;
    expect(settled).toBe(true);
    expect(client.listPushSubscriptions).toHaveBeenCalledTimes(1);
    expect(await isWebPushEnabled(ACCOUNT_ID)).toBe(true);
    // Nothing running: settles at once.
    await expect(waitForWebPushResync(ACCOUNT_ID)).resolves.toBeUndefined();
  });

  it('queues a forced update behind the running re-sync instead of racing it', async () => {
    localStorage.setItem(DEVICE_KEY, THIS_DEVICE);
    localStorage.setItem(SUB_KEY, 'push-old');
    const { registration, browserSub } = installPushBrowser();
    registration.pushManager.getSubscription.mockResolvedValue(null as never);
    let subscribed!: () => void;
    registration.pushManager.subscribe.mockReturnValueOnce(
      new Promise((resolve) => { subscribed = () => resolve(browserSub); }) as never,
    );
    const client = makeClient([sub('push-old', THIS_DEVICE)]);
    installFetch({});

    const running = resyncWebPush({ client, relayBaseUrl: RELAY, inboxOnly: false });
    const forced = resyncWebPush({ client, relayBaseUrl: RELAY, inboxOnly: false, force: true });
    await new Promise((r) => setTimeout(r, 0));
    expect(client.listPushSubscriptions).not.toHaveBeenCalled();

    subscribed();
    expect(await Promise.all([running, forced])).toEqual([true, true]);
    expect(client.listPushSubscriptions).toHaveBeenCalledTimes(2);
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
    expect(config[GROUP_ACCOUNT_ID].filter).toEqual({
      operator: 'AND',
      conditions: [{ notKeyword: '$junk' }, { inMailbox: 'mb-group-inbox' }],
    });
  });

  it('throws when an account has no discoverable Inbox mailbox', async () => {
    const client = makeClient([], { emailPushCapability: true });
    client.getAllMailboxes = vi.fn(async () => [
      { id: JUNK_ID, originalId: JUNK_ID, name: 'junk', role: 'junk', accountId: ACCOUNT_ID },
    ]) as unknown as IJMAPClient['getAllMailboxes'];

    await expect(buildEmailPushConfig(client, true)).rejects.toThrow(/No Inbox mailbox/);
  });

  it('mutes a group account whose Inbox we cannot see instead of failing', async () => {
    // The group's Inbox isn't visible to us, only a folder. The server fans
    // the subscription out to the group anyway, so leaving it out of the map
    // would let it push the group unfiltered.
    const client = makeClient([], { emailPushCapability: true });
    client.getAllMailboxes = vi.fn(async () => [
      { id: 'mb-inbox', originalId: 'mb-inbox', name: 'inbox', role: 'inbox', accountId: ACCOUNT_ID },
      { id: `${GROUP_ACCOUNT_ID}:mb-proj`, originalId: 'mb-proj', name: 'Projects', accountId: GROUP_ACCOUNT_ID },
    ]) as unknown as IJMAPClient['getAllMailboxes'];

    const config = await buildEmailPushConfig(client, true);

    expect(config[ACCOUNT_ID].filter).toEqual({
      operator: 'AND',
      conditions: [{ notKeyword: '$junk' }, { inMailbox: 'mb-inbox' }],
    });
    expect(config[GROUP_ACCOUNT_ID].filter).toEqual({
      operator: 'AND',
      conditions: [{ notKeyword: '$junk' }, { hasKeyword: '$junk' }],
    });
  });

  it('rethrows a mailbox-fetch failure in inbox-only mode instead of reporting no Inbox', async () => {
    const client = makeClient([], { emailPushCapability: true });
    client.getAllMailboxes = vi.fn(async () => {
      throw new Error('JMAP down');
    }) as unknown as IJMAPClient['getAllMailboxes'];

    await expect(buildEmailPushConfig(client, true)).rejects.toThrow(/JMAP down/);
  });

  it('still emits a filter for an account that has an Inbox but no Junk mailbox', async () => {
    const client = makeClient([], { emailPushCapability: true });
    client.getAllMailboxes = vi.fn(async () => [
      { id: 'mb-inbox', originalId: 'mb-inbox', name: 'inbox', role: 'inbox', accountId: ACCOUNT_ID },
      { id: `${GROUP_ACCOUNT_ID}:mb-si`, originalId: 'mb-si', name: 'inbox', role: 'inbox', accountId: GROUP_ACCOUNT_ID },
    ]) as unknown as IJMAPClient['getAllMailboxes'];

    const config = await buildEmailPushConfig(client, false);

    expect(Object.keys(config).sort()).toEqual([ACCOUNT_ID, GROUP_ACCOUNT_ID].sort());
    expect(config[GROUP_ACCOUNT_ID].filter).toEqual({
      operator: 'AND',
      conditions: [{ notKeyword: '$junk' }],
    });
  });
});

describe('buildEmailPushConfig with a mailbox shared by ACL', () => {
  it('leaves the ACL share out on Stalwart 1.0, which lists emailpush only on owned accounts', async () => {
    const client = makeClient([], { emailPushCapability: true, accounts: SESSION_1_0 });

    const config = await buildEmailPushConfig(client, false);

    expect(mapKeys(config)).toEqual([ACCOUNT_ID, GROUP_ACCOUNT_ID].sort());
  });

  it('keeps the ACL share on Stalwart 0.16, which lists emailpush on every account', async () => {
    // enableWebPush narrows the map once the server refuses it.
    const client = makeClient([], { emailPushCapability: true, accounts: SESSION_0_16 });

    const config = await buildEmailPushConfig(client, false);

    expect(mapKeys(config)).toEqual([ACCOUNT_ID, ACL_ACCOUNT_ID, GROUP_ACCOUNT_ID].sort());
  });
});

// Stalwart refuses the whole emailPush map as `forbidden` once it names a
// mailbox shared by ACL. A refused refresh used to destroy the working
// subscription, and the replacement was refused too, so push went off.
describe('enableWebPush with a mailbox shared by ACL', () => {
  const healthy = () => sub('push-old', THIS_DEVICE);

  beforeEach(() => {
    localStorage.setItem(DEVICE_KEY, THIS_DEVICE);
    installFetch({});
  });

  it('narrows a refused map on refresh instead of destroying the working subscription on Stalwart 0.16', async () => {
    localStorage.setItem(SUB_KEY, 'push-old');
    const client = makeClient([healthy()], { emailPushCapability: true, accounts: SESSION_0_16 });

    const result = await enableWebPush({ client, relayBaseUrl: RELAY, inboxOnly: false });

    expect(result.subscriptionId).toBe('push-old');
    const updates = updateCalls(client);
    expect(updates).toHaveLength(2);
    expect(mapKeys(updates[0].emailPush)).toEqual([ACCOUNT_ID, ACL_ACCOUNT_ID, GROUP_ACCOUNT_ID].sort());
    // The group keeps its junk filter; only the ACL share is dropped.
    expect(mapKeys(updates[1].emailPush)).toEqual([ACCOUNT_ID, GROUP_ACCOUNT_ID].sort());
    expect(client.destroyPushSubscription).not.toHaveBeenCalled();
    expect(client.createPushSubscription).not.toHaveBeenCalled();
    expect(localStorage.getItem(SUB_KEY)).toBe('push-old');
    expect(JSON.parse(localStorage.getItem(REFUSED_KEY)!)).toEqual([ACL_ACCOUNT_ID]);
  });

  it('leaves a remembered refusal out of the map on the next run on Stalwart 0.16', async () => {
    localStorage.setItem(SUB_KEY, 'push-old');
    localStorage.setItem(REFUSED_KEY, JSON.stringify([ACL_ACCOUNT_ID]));
    const client = makeClient([healthy()], { emailPushCapability: true, accounts: SESSION_0_16 });

    await enableWebPush({ client, relayBaseUrl: RELAY, inboxOnly: false });

    const updates = updateCalls(client);
    expect(updates).toHaveLength(1);
    expect(mapKeys(updates[0].emailPush)).toEqual([ACCOUNT_ID, GROUP_ACCOUNT_ID].sort());
  });

  it('makes no refused call at all once the stored map matches on Stalwart 0.16', async () => {
    localStorage.setItem(SUB_KEY, 'push-old');
    localStorage.setItem(REFUSED_KEY, JSON.stringify([ACL_ACCOUNT_ID]));
    const client = makeClient(
      [sub('push-old', THIS_DEVICE, { emailPush: EXPECTED_EMAIL_PUSH })],
      { emailPushCapability: true, accounts: SESSION_0_16 },
    );

    await enableWebPush({ client, relayBaseUrl: RELAY, inboxOnly: false });

    expect(client.updatePushSubscription).not.toHaveBeenCalled();
  });

  it('falls back to the primary account alone when the group is refused too on Stalwart 0.16', async () => {
    localStorage.setItem(SUB_KEY, 'push-old');
    const client = makeClient([healthy()], {
      emailPushCapability: true,
      accounts: SESSION_0_16,
      members: [ACCOUNT_ID],
    });

    const result = await enableWebPush({ client, relayBaseUrl: RELAY, inboxOnly: false });

    expect(result.subscriptionId).toBe('push-old');
    const updates = updateCalls(client);
    expect(updates).toHaveLength(3);
    expect(mapKeys(updates[2].emailPush)).toEqual([ACCOUNT_ID]);
    expect(JSON.parse(localStorage.getItem(REFUSED_KEY)!).sort()).toEqual([ACL_ACCOUNT_ID, GROUP_ACCOUNT_ID].sort());
    expect(client.destroyPushSubscription).not.toHaveBeenCalled();
  });

  it('narrows a refused map when creating a subscription on Stalwart 0.16', async () => {
    const client = makeClient([], { emailPushCapability: true, accounts: SESSION_0_16 });

    const result = await enableWebPush({ client, relayBaseUrl: RELAY, inboxOnly: false });

    expect(result.subscriptionId).toBe('push-new');
    const creates = createCalls(client);
    expect(creates).toHaveLength(2);
    expect(mapKeys(creates[1].emailPush)).toEqual([ACCOUNT_ID, GROUP_ACCOUNT_ID].sort());
    expect(localStorage.getItem(SUB_KEY)).toBe('push-new');
    expect(JSON.parse(localStorage.getItem(REFUSED_KEY)!)).toEqual([ACL_ACCOUNT_ID]);
  });

  it('keeps a group without create flags in the narrowed map on Stalwart 0.16, going by its identity', async () => {
    // Dropping the group would not silence it (the server still fans out to
    // it) but would take its junk filter away.
    const client = makeClient([], { emailPushCapability: true, accounts: MAIL_ONLY_GROUP_0_16 });

    const result = await enableWebPush({ client, relayBaseUrl: RELAY, inboxOnly: false });

    expect(result.subscriptionId).toBe('push-new');
    const creates = createCalls(client);
    expect(creates).toHaveLength(2);
    expect(mapKeys(creates[1].emailPush)).toEqual([ACCOUNT_ID, GROUP_ACCOUNT_ID].sort());
    expect(JSON.parse(localStorage.getItem(REFUSED_KEY)!)).toEqual([ACL_ACCOUNT_ID]);
  });

  it('asks for the identities only once the server refused a map on Stalwart 0.16', async () => {
    localStorage.setItem(REFUSED_KEY, JSON.stringify([ACL_ACCOUNT_ID]));
    const client = makeClient([], { emailPushCapability: true, accounts: MAIL_ONLY_GROUP_0_16 });

    await enableWebPush({ client, relayBaseUrl: RELAY, inboxOnly: false });

    expect(createCalls(client)).toHaveLength(1);
    expect(client.getIdentities).not.toHaveBeenCalled();
  });

  it('ignores refusals remembered under 0.16 once the server is Stalwart 1.0', async () => {
    // A group dropped as collateral on 0.16 belongs in the map again.
    localStorage.setItem(REFUSED_KEY, JSON.stringify([GROUP_ACCOUNT_ID, ACL_ACCOUNT_ID]));
    const client = makeClient([], { emailPushCapability: true, accounts: SESSION_1_0 });

    await enableWebPush({ client, relayBaseUrl: RELAY, inboxOnly: false });

    const creates = createCalls(client);
    expect(creates).toHaveLength(1);
    expect(creates[0].emailPush).toEqual(EXPECTED_EMAIL_PUSH);
  });

  it('falls back to the primary account alone when Stalwart 1.0 refuses the map, with no identity lookup', async () => {
    // A membership that ended after the session was read: the capability map
    // is refused, and nothing on 1.0 makes a better guess than the primary.
    const client = makeClient([], { emailPushCapability: true, accounts: SESSION_1_0, members: [ACCOUNT_ID] });

    const result = await enableWebPush({ client, relayBaseUrl: RELAY, inboxOnly: false });

    expect(result.subscriptionId).toBe('push-new');
    const creates = createCalls(client);
    expect(creates.map((c) => mapKeys(c.emailPush))).toEqual([[ACCOUNT_ID, GROUP_ACCOUNT_ID].sort(), [ACCOUNT_ID]]);
    expect(client.getIdentities).not.toHaveBeenCalled();
  });

  it('leaves the ACL share out without a refused call on Stalwart 1.0', async () => {
    const client = makeClient([], { emailPushCapability: true, accounts: SESSION_1_0 });

    const result = await enableWebPush({ client, relayBaseUrl: RELAY, inboxOnly: false });

    expect(result.subscriptionId).toBe('push-new');
    const creates = createCalls(client);
    expect(creates).toHaveLength(1);
    expect(creates[0].emailPush).toEqual(EXPECTED_EMAIL_PUSH);
    expect(localStorage.getItem(REFUSED_KEY)).toBeNull();
  });

  it('sends no map and never narrows on Stalwart 0.16.15, which has no emailpush', async () => {
    const client = makeClient([], { emailPushCapability: false, accounts: SESSION_0_16_15 });

    await enableWebPush({ client, relayBaseUrl: RELAY, inboxOnly: false });

    const creates = createCalls(client);
    expect(creates).toHaveLength(1);
    expect(creates[0]).not.toHaveProperty('emailPush');
    expect(localStorage.getItem(REFUSED_KEY)).toBeNull();
  });

  it('does not narrow the map on overQuota', async () => {
    const client = makeClient([], { emailPushCapability: true, accounts: SESSION_0_16 });
    client.createPushSubscription = vi.fn(async () => {
      throw jmapSetError(`PushSubscription/set create failed: ${OVER_QUOTA.description}`, OVER_QUOTA);
    }) as unknown as IJMAPClient['createPushSubscription'];

    const err = await enableWebPush({ client, relayBaseUrl: RELAY, inboxOnly: false }).catch((e) => e);

    expect(jmapErrorType(err)).toBe('overQuota');
    expect(client.createPushSubscription).toHaveBeenCalledTimes(1);
    expect(localStorage.getItem(REFUSED_KEY)).toBeNull();
  });

  it('does not narrow the map when the whole method call is refused', async () => {
    // A method-level `forbidden` (the account may not use push at all) is
    // not about the map: a narrower one fails the same way.
    localStorage.setItem(SUB_KEY, 'push-old');
    const client = makeClient([healthy()], { emailPushCapability: true, accounts: SESSION_0_16 });
    client.updatePushSubscription = vi.fn(async () => {
      throw jmapError('PushSubscription/set failed: forbidden', { type: 'forbidden' });
    }) as unknown as IJMAPClient['updatePushSubscription'];

    await expect(enableWebPush({ client, relayBaseUrl: RELAY, inboxOnly: false })).rejects.toThrow();

    expect(client.updatePushSubscription).toHaveBeenCalledTimes(1);
    expect(client.destroyPushSubscription).not.toHaveBeenCalled();
    expect(localStorage.getItem(SUB_KEY)).toBe('push-old');
  });

  it('forgets remembered refusals on forceRecreate and learns them again', async () => {
    localStorage.setItem(SUB_KEY, 'push-old');
    localStorage.setItem(REFUSED_KEY, JSON.stringify([ACL_ACCOUNT_ID, GROUP_ACCOUNT_ID]));
    const client = makeClient([healthy()], { emailPushCapability: true, accounts: SESSION_0_16 });

    await enableWebPush({ client, relayBaseUrl: RELAY, forceRecreate: true, inboxOnly: false });

    const creates = createCalls(client);
    expect(mapKeys(creates[0].emailPush)).toEqual([ACCOUNT_ID, ACL_ACCOUNT_ID, GROUP_ACCOUNT_ID].sort());
    expect(mapKeys(creates[1].emailPush)).toEqual([ACCOUNT_ID, GROUP_ACCOUNT_ID].sort());
    expect(JSON.parse(localStorage.getItem(REFUSED_KEY)!)).toEqual([ACL_ACCOUNT_ID]);
  });

  it('keeps the working subscription and its key when the replacement is refused', async () => {
    localStorage.setItem(SUB_KEY, 'push-old');
    const client = makeClient([healthy()], {
      emailPushCapability: true,
      accounts: SESSION_0_16,
      members: [],
    });

    const err = await enableWebPush({ client, relayBaseUrl: RELAY, forceRecreate: true, inboxOnly: false })
      .catch((e) => e);

    expect(jmapErrorType(err)).toBe('forbidden');
    expect(client.destroyed).not.toContain('push-old');
    expect(localStorage.getItem(SUB_KEY)).toBe('push-old');
  });

  it('replaces a subscription whose refresh the server refuses, and destroys the old one after verification', async () => {
    // `notFound`: the server dropped the record between the listing and the
    // update.
    localStorage.setItem(SUB_KEY, 'push-old');
    const client = makeClient([healthy()], { emailPushCapability: true, accounts: SESSION_1_0 });
    client.updatePushSubscription = vi.fn(async () => {
      throw jmapSetError('PushSubscription/set update failed: notFound', { type: 'notFound' });
    }) as unknown as IJMAPClient['updatePushSubscription'];

    const result = await enableWebPush({ client, relayBaseUrl: RELAY, inboxOnly: false });

    expect(result.subscriptionId).toBe('push-new');
    expect(localStorage.getItem(SUB_KEY)).toBe('push-new');
    const destroy = client.destroyPushSubscription as ReturnType<typeof vi.fn>;
    const verify = client.verifyPushSubscription as ReturnType<typeof vi.fn>;
    expect(destroy).toHaveBeenCalledWith('push-old');
    expect(destroy.mock.invocationCallOrder[0]).toBeGreaterThan(verify.mock.invocationCallOrder[0]);
  });
});

// Only a verified replacement, the user turning push off, or the server no
// longer holding the subscription may end it. A failure that says nothing
// about the subscription must leave it and its key alone.
describe('enableWebPush when the server cannot be asked', () => {
  beforeEach(() => {
    localStorage.setItem(DEVICE_KEY, THIS_DEVICE);
    localStorage.setItem(SUB_KEY, 'push-old');
    installFetch({});
  });

  it.each([
    ['a network error', () => new TypeError('Failed to fetch')],
    ['a timeout', () => new RequestTimeoutError(30_000)],
    ['rate limiting', () => new RateLimitError(60_000)],
  ])('destroys nothing when the refresh fails with %s', async (_label, failure) => {
    const client = makeClient([sub('push-old', THIS_DEVICE)], { emailPushCapability: true, accounts: SESSION_1_0 });
    client.updatePushSubscription = vi.fn(async () => {
      throw failure();
    }) as unknown as IJMAPClient['updatePushSubscription'];

    await expect(enableWebPush({ client, relayBaseUrl: RELAY, inboxOnly: false })).rejects.toThrow();

    expect(client.updatePushSubscription).toHaveBeenCalledTimes(1);
    expect(client.destroyPushSubscription).not.toHaveBeenCalled();
    expect(client.createPushSubscription).not.toHaveBeenCalled();
    expect(localStorage.getItem(SUB_KEY)).toBe('push-old');
  });

  it('stops without touching local state when the subscriptions cannot be listed', async () => {
    const client = makeClient([sub('push-old', THIS_DEVICE)], { emailPushCapability: true });
    client.listPushSubscriptions = vi.fn(async () => {
      throw new TypeError('Failed to fetch');
    }) as unknown as IJMAPClient['listPushSubscriptions'];

    await expect(enableWebPush({ client, relayBaseUrl: RELAY, inboxOnly: false })).rejects.toThrow();

    expect(client.destroyPushSubscription).not.toHaveBeenCalled();
    expect(client.createPushSubscription).not.toHaveBeenCalled();
    expect(localStorage.getItem(SUB_KEY)).toBe('push-old');
  });

  it('keeps push enabled after a failed re-sync', async () => {
    // The worst case: the server refuses every map and the replacement too.
    const client = makeClient([sub('push-old', THIS_DEVICE)], {
      emailPushCapability: true,
      accounts: SESSION_0_16,
      members: [],
    });

    expect(await resyncWebPush({ client, relayBaseUrl: RELAY, inboxOnly: false })).toBe(false);

    expect(client.destroyed).not.toContain('push-old');
    expect(await isWebPushEnabled(ACCOUNT_ID)).toBe(true);
  });

  it('keeps push enabled after a re-sync that could not reach the server', async () => {
    const client = makeClient([sub('push-old', THIS_DEVICE)], { emailPushCapability: true, accounts: SESSION_1_0 });
    client.updatePushSubscription = vi.fn(async () => {
      throw new TypeError('Failed to fetch');
    }) as unknown as IJMAPClient['updatePushSubscription'];

    expect(await resyncWebPush({ client, relayBaseUrl: RELAY, inboxOnly: false })).toBe(false);

    expect(client.destroyPushSubscription).not.toHaveBeenCalled();
    expect(await isWebPushEnabled(ACCOUNT_ID)).toBe(true);
  });
});

// The settings pane tells users that mailboxes shared with them stay silent
// in the background (Stalwart never fans push out to them).
describe('mailAccountsWithoutPush', () => {
  it('names the account without emailpush on Stalwart 1.0, and nothing else', () => {
    // Groups count as owned even without the create flags: on 1.0 the
    // capability list is exact.
    const client = makeClient([], { emailPushCapability: true, accounts: MAIL_ONLY_GROUP_1_0 });

    expect(mailAccountsWithoutPush(client, [GROUP_ACCOUNT_ID, ACL_ACCOUNT_ID])).toEqual([ACL_ACCOUNT_ID]);
  });

  it('trusts the capability alone on Stalwart 1.0: no guess from create flags, no remembered refusal', () => {
    // Only a group is shared with this user. Its account lists emailpush, so
    // it gets push, whatever its create flags or a list kept under 0.16 say.
    localStorage.setItem(REFUSED_KEY, JSON.stringify([GROUP_ACCOUNT_ID]));
    const client = makeClient([], { emailPushCapability: true, accounts: MAIL_ONLY_GROUP_1_0, identities: [ACCOUNT_NAME] });

    expect(mailAccountsWithoutPush(client, [GROUP_ACCOUNT_ID])).toEqual([]);
  });

  it('does not name a group of the user that has no create flags on Stalwart 0.16', () => {
    // The user's identities include the group's address; an ACL share's
    // owner address never is one of them.
    const client = makeClient([], { emailPushCapability: true, accounts: MAIL_ONLY_GROUP_0_16 });

    expect(mailAccountsWithoutPush(client, [GROUP_ACCOUNT_ID, ACL_ACCOUNT_ID], [ACCOUNT_NAME, 'Team@Example.com']))
      .toEqual([ACL_ACCOUNT_ID]);
    // Without the group's identity it cannot be told from an ACL share.
    expect(mailAccountsWithoutPush(client, [GROUP_ACCOUNT_ID, ACL_ACCOUNT_ID], [ACCOUNT_NAME]))
      .toEqual([GROUP_ACCOUNT_ID, ACL_ACCOUNT_ID]);
  });

  it('names the account that does not look owned on Stalwart 0.16', () => {
    const client = makeClient([], { emailPushCapability: true, accounts: SESSION_0_16 });

    expect(mailAccountsWithoutPush(client, [GROUP_ACCOUNT_ID, ACL_ACCOUNT_ID])).toEqual([ACL_ACCOUNT_ID]);
  });

  it('names the accounts the server refused on Stalwart 0.16', () => {
    localStorage.setItem(REFUSED_KEY, JSON.stringify([GROUP_ACCOUNT_ID]));
    const client = makeClient([], { emailPushCapability: true, accounts: SESSION_0_16 });

    expect(mailAccountsWithoutPush(client, [GROUP_ACCOUNT_ID, ACL_ACCOUNT_ID])).toEqual([
      GROUP_ACCOUNT_ID,
      ACL_ACCOUNT_ID,
    ]);
  });

  it('names the account that does not look owned on Stalwart 0.16.15', () => {
    const client = makeClient([], { emailPushCapability: false, accounts: SESSION_0_16_15 });

    expect(mailAccountsWithoutPush(client, [GROUP_ACCOUNT_ID, ACL_ACCOUNT_ID])).toEqual([ACL_ACCOUNT_ID]);
  });

  it('is empty when every mailbox is the user\'s own or a group\'s', () => {
    const client = makeClient([], { emailPushCapability: true, accounts: SESSION_1_0 });

    expect(mailAccountsWithoutPush(client, [ACCOUNT_ID, GROUP_ACCOUNT_ID, GROUP_ACCOUNT_ID])).toEqual([]);
    expect(mailAccountsWithoutPush(client, [])).toEqual([]);
  });
});

// Muted accounts and folders (#1169) are left out by the server-side filter.
describe('buildEmailPushConfig with muted folders and accounts', () => {
  const mutes = (accounts: string[], mailboxes: Record<string, boolean> = {}) => ({ accounts, mailboxes });

  it('adds a muted folder to the excluded mailboxes next to Junk', async () => {
    const client = makeClient([], { emailPushCapability: true });

    const config = await buildEmailPushConfig(client, false, mutes([], { [`${ACCOUNT_ID}/mb-archive`]: true }));

    expect(config[ACCOUNT_ID].filter).toEqual({
      operator: 'AND',
      conditions: [{ notKeyword: '$junk' }, { inMailboxOtherThan: [JUNK_ID, 'mb-archive'].sort() }],
    });
    // Another account's folders are untouched.
    expect(config[GROUP_ACCOUNT_ID]).toEqual(EXPECTED_EMAIL_PUSH[GROUP_ACCOUNT_ID]);
  });

  it('silences a muted account entirely', async () => {
    const client = makeClient([], { emailPushCapability: true });

    const config = await buildEmailPushConfig(client, false, mutes([GROUP_ACCOUNT_ID]));

    expect(config[GROUP_ACCOUNT_ID].filter).toEqual({
      operator: 'AND',
      conditions: [{ notKeyword: '$junk' }, { hasKeyword: '$junk' }],
    });
    expect(config[ACCOUNT_ID]).toEqual(EXPECTED_EMAIL_PUSH[ACCOUNT_ID]);
  });

  it('lets a muted account notify for the folders unmuted again', async () => {
    const client = makeClient([], { emailPushCapability: true });

    const one = await buildEmailPushConfig(client, false, mutes([ACCOUNT_ID], { [`${ACCOUNT_ID}/mb-archive`]: false }));
    expect(one[ACCOUNT_ID].filter).toEqual({
      operator: 'AND',
      conditions: [{ notKeyword: '$junk' }, { inMailbox: 'mb-archive' }],
    });

    const two = await buildEmailPushConfig(client, false, mutes([ACCOUNT_ID], {
      [`${ACCOUNT_ID}/mb-inbox`]: false,
      [`${ACCOUNT_ID}/mb-archive`]: false,
      // Gone from the server: must not end up in the filter.
      [`${ACCOUNT_ID}/mb-deleted`]: false,
    }));
    expect(two[ACCOUNT_ID].filter).toEqual({
      operator: 'AND',
      conditions: [
        { notKeyword: '$junk' },
        { operator: 'OR', conditions: [{ inMailbox: 'mb-archive' }, { inMailbox: 'mb-inbox' }] },
      ],
    });
  });

  it('silences the account in inbox-only mode when its Inbox is muted', async () => {
    const client = makeClient([], { emailPushCapability: true });

    const config = await buildEmailPushConfig(client, true, mutes([], { [`${GROUP_ACCOUNT_ID}/mb-group-inbox`]: true }));

    expect(config[GROUP_ACCOUNT_ID].filter).toEqual({
      operator: 'AND',
      conditions: [{ notKeyword: '$junk' }, { hasKeyword: '$junk' }],
    });
    expect(config[ACCOUNT_ID].filter).toEqual({
      operator: 'AND',
      conditions: [{ notKeyword: '$junk' }, { inMailbox: 'mb-inbox' }],
    });
  });

  it('fails instead of dropping the mutes when the mailboxes cannot be read', async () => {
    const client = makeClient([], { emailPushCapability: true });
    client.getAllMailboxes = vi.fn(async () => {
      throw new Error('JMAP down');
    }) as unknown as IJMAPClient['getAllMailboxes'];

    await expect(buildEmailPushConfig(client, false, mutes([ACCOUNT_ID]))).rejects.toThrow(/JMAP down/);
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

  it('forgets the accounts the server refused, so enabling again starts from the full map', async () => {
    localStorage.setItem(DEVICE_KEY, THIS_DEVICE);
    localStorage.setItem(SUB_KEY, 'push-tracked');
    localStorage.setItem(REFUSED_KEY, JSON.stringify([ACL_ACCOUNT_ID]));
    const client = makeClient([sub('push-tracked', THIS_DEVICE)]);
    installFetch({});

    await disableWebPush({ client, relayBaseUrl: RELAY });

    expect(localStorage.getItem(REFUSED_KEY)).toBeNull();
  });

  it('drops the record on the relay it was registered with, not only the current one', async () => {
    localStorage.setItem(DEVICE_KEY, THIS_DEVICE);
    localStorage.setItem(SUB_KEY, 'push-tracked');
    localStorage.setItem(RELAY_BASE_KEY, 'https://old-relay.example');
    const client = makeClient([sub('push-tracked', THIS_DEVICE)]);
    const calls = installFetch({});

    await disableWebPush({ client, relayBaseUrl: RELAY });

    expect(calls).toContainEqual({ url: `https://old-relay.example/api/push/register/${THIS_DEVICE}`, method: 'DELETE' });
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

describe('endWebPushForSignOut', () => {
  it('takes everything down for a login with push on, using the relay it registered with', async () => {
    localStorage.setItem(DEVICE_KEY, THIS_DEVICE);
    localStorage.setItem(SUB_KEY, 'push-mine');
    localStorage.setItem(RELAY_BASE_KEY, RELAY);
    const client = makeClient([sub('push-mine', THIS_DEVICE)]);
    const calls = installFetch({});

    await endWebPushForSignOut(client);

    expect(client.destroyed).toEqual(['push-mine']);
    expect(calls).toEqual([{ url: `${RELAY}/api/push/register/${THIS_DEVICE}`, method: 'DELETE' }]);
    expect(localStorage.getItem(SUB_KEY)).toBeNull();
  });

  it('does nothing and calls nobody for a login without push', async () => {
    const client = makeClient([]);
    const calls = installFetch({});

    await endWebPushForSignOut(client);

    expect(calls).toEqual([]);
    expect(client.listPushSubscriptions).not.toHaveBeenCalled();
  });

  it('never throws: signing out goes on', async () => {
    localStorage.setItem(DEVICE_KEY, THIS_DEVICE);
    localStorage.setItem(SUB_KEY, 'push-mine');
    localStorage.setItem(RELAY_BASE_KEY, RELAY);
    const client = makeClient([sub('push-mine', THIS_DEVICE)]);
    vi.stubGlobal('fetch', vi.fn(async () => { throw new TypeError('offline'); }));
    (client.destroyPushSubscription as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('offline'));

    await expect(endWebPushForSignOut(client)).resolves.toBeUndefined();
    expect(localStorage.getItem(SUB_KEY)).toBeNull();
  });

  it('forgets the key material with nobody left', async () => {
    localStorage.setItem(DEVICE_KEY, THIS_DEVICE);
    localStorage.setItem(SUB_KEY, 'push-mine');
    localStorage.setItem(RELAY_BASE_KEY, RELAY);
    const { browserSub } = installPushBrowser();
    const client = makeClient([sub('push-mine', THIS_DEVICE)]);
    installFetch({});

    await endWebPushForSignOut(client);

    expect(browserSub.unsubscribe).toHaveBeenCalledTimes(1);
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

describe('enableWebPushForAccounts', () => {
  it('registers every account against the one browser subscription', async () => {
    const first = makeClient([]);
    const second = makeClient([]);
    installFetch({});

    const result = await enableWebPushForAccounts([
      { accountId: 'a', client: first, accountLabel: 'one' },
      { accountId: 'b', client: second, accountLabel: 'two' },
    ], { relayBaseUrl: RELAY, inboxOnly: false });

    expect(result.enabled).toEqual(['a', 'b']);
    expect(result.failed).toEqual([]);
    expect(first.createPushSubscription).toHaveBeenCalledTimes(1);
    expect(second.createPushSubscription).toHaveBeenCalledTimes(1);
  });

  it('stops at a browser-level refusal instead of prompting once per account', async () => {
    const first = makeClient([]);
    const second = makeClient([]);
    installFetch({});
    // Blocked notifications are a property of the browser, not of an account:
    // walking on would fail identically for every one of them.
    (globalThis as unknown as { Notification: unknown }).Notification = { permission: 'denied' };
    (window as unknown as { Notification: unknown }).Notification = { permission: 'denied' };

    const result = await enableWebPushForAccounts([
      { accountId: 'a', client: first },
      { accountId: 'b', client: second },
    ], { relayBaseUrl: RELAY, inboxOnly: false });

    expect(result.enabled).toEqual([]);
    expect(result.failed.map(f => f.accountId)).toEqual(['a', 'b']);
    expect(second.createPushSubscription).not.toHaveBeenCalled();
  });
});
