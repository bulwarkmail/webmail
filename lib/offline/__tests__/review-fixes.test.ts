import 'fake-indexeddb/auto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useAuthStore } from '@/stores/auth-store';
import { useAccountStore } from '@/stores/account-store';
import { useEmailStore } from '@/stores/email-store';
import { usePolicyStore } from '@/stores/policy-store';
import { DEFAULT_ORGANISATION_POLICY } from '@/lib/admin/organisation-policy';
import { runBeforeSignOut } from '@/lib/sign-out-cleanup';
import { setSendGuardSource } from '@/lib/plugin-send-guards';
import { clearAllHooks, emailHooks } from '@/lib/plugin-hooks';
import { beginComposeTakeover, completesComposeTakeover, endComposeTakeover, resetComposeTakeovers } from '@/lib/outgoing/compose-takeover';
import { setStoreBackend } from '@/lib/store/client/api';
import { InProcessStore } from '@/lib/store/__tests__/helpers/in-process-store';
import { FakeJmapMail } from '@/lib/store/__tests__/helpers/fake-jmap-mail';
import { JMAP_ACCOUNT } from '@/lib/store/__tests__/helpers/fake-jmap';
import type { JMAPClient } from '@/lib/jmap/client';
import type { InstalledPlugin } from '@/lib/plugin-types';
import {
  confirmLoss,
  enforcePolicy,
  offlineSessionFor,
  pluginsNotRunning,
  startOfflineMode,
  stricterNow,
  wipeEverything,
} from '../offline-mode';
import { flushQueue, settleStaleSends, SENDING_STALE_MS } from '../flush';
import { claimForSending, holdFile, queueSend, readQueue } from '../queue';
import { forgetLegacyMove } from '../migrate-legacy';
import { consumeLost } from '../lost';
import { getOutboxHooks } from '../outbox-hooks';
import { shellFiles } from '../shell';
import { isOfflineNow, OFFLINE_ACCOUNTS_KEY, setServerDown, useOfflineStore, writeEnabled } from '../state';

function fakeClient(server = 'https://mail.example.org', overrides: Record<string, unknown> = {}) {
  return {
    getServerUrl: () => server,
    getUsername: () => 'alice@example.org',
    getAccountId: () => 'j1',
    isOfflineOnly: () => false,
    getSessionSnapshot: () => ({ apiUrl: `${server}/jmap` }),
    getAuthHeader: () => 'Basic x',
    keywordSortInverted: () => null,
    sendEmail: vi.fn(async () => ({ scheduled: false, emailId: 'sent-1', emailSubmissionId: 'sub-1' })),
    uploadBlob: vi.fn(async (file: File) => ({ blobId: `server-${file.name}`, size: file.size, type: file.type })),
    pruneEmailSubmissions: vi.fn(async () => {}),
    ...overrides,
  };
}

function setPolicyOrg(organisation: Record<string, unknown>) {
  usePolicyStore.setState({ loaded: true, source: 'server', subject: null, subjectPending: false, policy: { ...usePolicyStore.getState().policy, organisation: { ...DEFAULT_ORGANISATION_POLICY, ...organisation } as never } });
}

function setOnline(online: boolean) {
  Object.defineProperty(window.navigator, 'onLine', { configurable: true, get: () => online });
}

let stop: () => void = () => {};
let store: InProcessStore;

beforeEach(async () => {
  store = new InProcessStore();
  setStoreBackend(store);
  forgetLegacyMove();
  localStorage.clear();
  sessionStorage.clear();
  setOnline(true);
  useOfflineStore.setState({ enabled: [], outbox: [], pendingChanges: 0, conflicts: [], browserOffline: false, downServers: [], startedOffline: false });
  setPolicyOrg({});
  useAccountStore.setState({ accounts: [{ id: 'acc', label: 'alice', serverUrl: 'https://mail.example.org', username: 'alice@example.org' } as never] });
  useAuthStore.setState({ isAuthenticated: true, activeAccountId: 'acc', client: null });
  setSendGuardSource(null);
  resetComposeTakeovers();
});

afterEach(async () => {
  stop();
  stop = () => {};
  setOnline(true);
  setSendGuardSource(null);
  await wipeEverything();
  setStoreBackend(null);
});

describe('1: two tabs never send the same message', () => {
  it('only one claim wins', async () => {
    const id = await queueSend('acc', { subject: 'S', to: [] }, { kind: 'email', args: [] });
    const results = await Promise.all([claimForSending('acc', id), claimForSending('acc', id)]);
    expect(results.filter(Boolean)).toHaveLength(1);
    expect((await readQueue('acc')).outbox[0].status).toBe('sending');
  });

  it('a message another tab took isn’t sent here', async () => {
    const id = await queueSend('acc', { subject: 'S', to: [] }, { kind: 'email', args: [['b@example.org'], 'S', 'x'] });
    await claimForSending('acc', id);
    const client = fakeClient();
    await flushQueue('acc', client as unknown as JMAPClient, { notify: vi.fn(), allowed: () => true });
    expect(client.sendEmail).not.toHaveBeenCalled();
  });

  it('runs under a Web Lock per account where the browser has them', async () => {
    const request = vi.fn(async (_name: string, run: () => Promise<void>) => run());
    Object.defineProperty(window.navigator, 'locks', { configurable: true, value: { request } });
    try {
      await flushQueue('acc', fakeClient() as unknown as JMAPClient, { notify: vi.fn(), allowed: () => true });
      expect(request).toHaveBeenCalledWith('bulwark-offline-flush:acc', expect.any(Function));
    } finally {
      delete (window.navigator as { locks?: unknown }).locks;
    }
  });
});

describe('2: a send that may have reached the server is never queued or sent again blindly', () => {
  it('puts a send back to waiting only when it never started', async () => {
    const notStarted = Object.assign(new Error('x'), { name: 'SendNotStartedError' });
    const client = fakeClient(undefined, { sendEmail: vi.fn(async () => { throw notStarted; }) });
    await queueSend('acc', { subject: 'S', to: [] }, { kind: 'email', args: [['b@example.org'], 'S', 'x'] });
    await flushQueue('acc', client as unknown as JMAPClient, { notify: vi.fn(), allowed: () => true });
    expect((await readQueue('acc')).outbox[0].status).toBe('waiting');
  });

  it('the store keeps a composer send again only when it never started', async () => {
    writeEnabled(['acc']);
    stop = startOfflineMode();
    const args = [['b@example.org'], 'S', 'x', undefined, undefined, 'i1', 'alice@example.org', undefined, 'Alice', undefined, undefined, undefined, undefined, undefined, undefined, { outbox: true }] as const;
    // The browser goes offline between the click and the submission.
    const notStarted = vi.fn(async () => { setOnline(false); throw Object.assign(new Error('x'), { name: 'SendNotStartedError' }); });
    const result = await useEmailStore.getState().sendEmail(fakeClient(undefined, { sendEmail: notStarted }) as never, ...(args as unknown as [string[], string, string]));
    expect(result.queued).toBe(true);
    setOnline(true);
    const midway = vi.fn(async () => { setOnline(false); throw new TypeError('Failed to fetch'); });
    await expect(useEmailStore.getState().sendEmail(fakeClient(undefined, { sendEmail: midway }) as never, ...(args as unknown as [string[], string, string]))).rejects.toThrow('Failed to fetch');
    expect((await readQueue('acc')).outbox).toHaveLength(1);
  });
});

describe('3: every sign-out the user didn’t agree to names the lost messages', () => {
  it('names them for the sign-in page, unless the user agreed', async () => {
    writeEnabled(['acc']);
    stop = startOfflineMode();
    await queueSend('acc', { subject: 'Quarterly', to: [] }, { kind: 'email', args: [] });
    await runBeforeSignOut('all');
    expect(consumeLost()).toEqual(['Quarterly']);

    sessionStorage.clear();
    confirmLoss('all');
    await runBeforeSignOut('all');
    expect(consumeLost()).toEqual([]);
  });

  it('an account removed while another stays signed in: a notice now', async () => {
    useAccountStore.setState({ accounts: [{ id: 'acc' } as never, { id: 'other' } as never] });
    writeEnabled(['acc', 'other']);
    const notices: unknown[] = [];
    const { setOfflineNotifier } = await import('../offline-mode');
    setOfflineNotifier((n) => notices.push(n));
    stop = startOfflineMode();
    await queueSend('acc', { subject: 'Lost one', to: [] }, { kind: 'email', args: [] });
    useAccountStore.getState().removeAccount('acc');
    await vi.waitFor(() => expect(notices).toContainEqual({ kind: 'lost', subjects: ['Lost one'] }));
    setOfflineNotifier(() => {});
  });
});

describe('4: no queueing while a plugin isn’t running', () => {
  const plugin = (status: InstalledPlugin['status']) => ({ id: 'smime', name: 'S/MIME', status, permissions: [] }) as unknown as InstalledPlugin;
  const source = (plugins: InstalledPlugin[]) => ({ snapshot: () => ({ plugins, forced: () => false }), subscribe: () => () => {} });

  it('refuses while an enabled plugin hasn’t started', async () => {
    setSendGuardSource(source([plugin('enabled')]));
    expect(pluginsNotRunning()).toBe(true);
    writeEnabled(['acc']);
    stop = startOfflineMode();
    setOnline(false);
    await expect(useEmailStore.getState().sendEmail(fakeClient() as never, ['b@example.org'], 'S', 'x', undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, { outbox: true }))
      .rejects.toMatchObject({ name: 'OfflinePluginsDownError' });
    expect((await readQueue('acc')).outbox).toHaveLength(0);
  });

  it('keeps it when every plugin runs, or is off', () => {
    setSendGuardSource(source([plugin('running'), plugin('disabled')]));
    expect(pluginsNotRunning()).toBe(false);
  });
});

describe('5: another tab switching it off sticks', () => {
  it('follows the switch from another tab and doesn’t open the store for it again', async () => {
    writeEnabled(['acc']);
    stop = startOfflineMode();
    await vi.waitFor(() => expect(store.has('acc')).toBe(true));
    await new Promise((r) => setTimeout(r, 10));
    store.stop();
    window.dispatchEvent(new StorageEvent('storage', { key: OFFLINE_ACCOUNTS_KEY, newValue: null }));
    expect(useOfflineStore.getState().enabled).toEqual([]);
    await new Promise((r) => setTimeout(r, 20));
    expect(store.has('acc')).toBe(false);
    expect((await indexedDB.databases()).map((d) => d.name)).not.toContain('bulwark-store');
  });
});

describe('6: queued mail and a stricter policy', () => {
  it('holds a message finished without a label once a label is required', async () => {
    const id = await queueSend('acc', { subject: 'S', to: [] }, { kind: 'email', args: [] }, { labelRequired: false, hasLabel: false, guards: [] });
    const entry = (await readQueue('acc')).outbox.find((e) => e.id === id)!;
    expect(stricterNow(entry)).toBe(false);
    setPolicyOrg({ labels: { list: [{ id: 'c', name: 'C', color: '#000000', marking: 'C', description: '', sensitivity: '', subjectPrefix: '', extraHeaderValue: '' }], defaultId: '', required: true, extraHeader: '' } });
    expect(stricterNow(entry)).toBe(true);
    const client = fakeClient();
    await flushQueue('acc', client as unknown as JMAPClient, { notify: vi.fn(), allowed: () => true, stricterNow });
    expect(client.sendEmail).not.toHaveBeenCalled();
    expect((await readQueue('acc')).outbox[0].status).toBe('held');
  });
});

describe('7: a send of a closed tab isn’t stuck', () => {
  it('becomes uncertain after a minute', async () => {
    const id = await queueSend('acc', { subject: 'S', to: [] }, { kind: 'email', args: [] });
    await claimForSending('acc', id);
    await settleStaleSends('acc');
    expect((await readQueue('acc')).outbox[0].status).toBe('sending');
    await settleStaleSends('acc', Date.now() + SENDING_STALE_MS + 1000);
    expect((await readQueue('acc')).outbox[0].status).toBe('uncertain');
  });
});

describe('8: only parts of kept messages are kept, and go with them', () => {
  it('files a blob under its message and deletes it with the message', async () => {
    const server = new FakeJmapMail();
    server.addEmail({ id: 'm1', attachments: [{ blobId: 'b1', name: 'a.pdf', size: 99_999_999 }] });
    store = new InProcessStore(server);
    setStoreBackend(store);
    await store.sync('acc');
    expect(await store.area('acc', 'mail.recordBlob', { jmap: JMAP_ACCOUNT, blobId: 'export-of-a-whole-message', type: null, data: new Uint8Array([1]) })).toBe(false);
    expect(await store.area('acc', 'mail.recordBlob', { jmap: JMAP_ACCOUNT, blobId: 'b1', type: null, data: new Uint8Array([1]) })).toBe(true);
    server.destroyEmail('m1');
    await store.sync('acc');
    expect(await store.area('acc', 'mail.getBlob', { jmap: JMAP_ACCOUNT, blobId: 'b1' })).toBeNull();
  });
});

describe('9: folders that went away', () => {
  it('drops a folder the server no longer has', async () => {
    const server = new FakeJmapMail({ mailboxes: [{ id: 'inbox', role: 'inbox' }, { id: 'kept' }, { id: 'deleted' }] });
    store = new InProcessStore(server);
    setStoreBackend(store);
    await store.sync('acc');
    server.mailboxes.delete('deleted');
    server.coll.Mailbox.push('destroyed', 'deleted');
    await store.sync('acc');
    const answer = await store.answer('acc', [['Mailbox/get', {}, '0']]);
    expect(answer?.methodResponses[0][1].list.map((box: { id: string }) => box.id).sort()).toEqual(['inbox', 'kept']);
  });
});

describe('10: no decision on an account whose groups aren’t known yet', () => {
  it('doesn’t wipe the active account while its subject is pending', async () => {
    writeEnabled(['acc']);
    setPolicyOrg({ devices: { ...DEFAULT_ORGANISATION_POLICY.devices, noOffline: true } });
    usePolicyStore.setState({ subjectPending: true });
    enforcePolicy();
    expect(useOfflineStore.getState().enabled).toEqual(['acc']);
    usePolicyStore.setState({ subjectPending: false });
    enforcePolicy();
    await vi.waitFor(() => expect(useOfflineStore.getState().enabled).toEqual([]));
  });
});

describe('11: starting from the device', () => {
  it('uses the policy kept from the last fetch, never the defaults', async () => {
    writeEnabled(['acc']);
    localStorage.setItem('bulwark-policy-last', JSON.stringify({ ...usePolicyStore.getState().policy, organisation: { ...DEFAULT_ORGANISATION_POLICY, devices: { ...DEFAULT_ORGANISATION_POLICY.devices, noOffline: true } } }));
    usePolicyStore.setState({ loaded: false, fetching: false, source: 'none' });
    vi.stubGlobal('fetch', vi.fn(async () => { throw new TypeError('Failed to fetch'); }));
    try {
      expect(await offlineSessionFor('acc')).toBeNull();
      expect(usePolicyStore.getState().source).toBe('cache');
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('hands out the session kept with the account', async () => {
    writeEnabled(['acc']);
    expect(await offlineSessionFor('acc')).toMatchObject({ primaryAccounts: { 'urn:ietf:params:jmap:mail': JMAP_ACCOUNT } });
  });

  it('doesn\'t offer a quick start before the store has its folders', async () => {
    store = new InProcessStore(new FakeJmapMail());
    setStoreBackend(store);
    writeEnabled(['acc']);
    expect(await offlineSessionFor('acc', { withFolders: true })).toBeNull();
    await store.sync('acc');
    expect(await offlineSessionFor('acc', { withFolders: true })).toMatchObject({ primaryAccounts: { 'urn:ietf:params:jmap:mail': JMAP_ACCOUNT } });
  });
});

describe('a send on the local copy', () => {
  it('queues, before the swap too, while the probes say the server is up', () => {
    writeEnabled(['acc']);
    stop = startOfflineMode();
    useAuthStore.setState({ client: fakeClient('https://mail.example.org', { isOfflineOnly: () => true }) as never });
    const client = useAuthStore.getState().client as never;
    expect(isOfflineNow('https://mail.example.org')).toBe(false);
    expect(getOutboxHooks()?.shouldQueue(client)).toBe(true);
    useAuthStore.setState({ client: fakeClient() as never });
    expect(getOutboxHooks()?.shouldQueue(useAuthStore.getState().client as never)).toBe(false);
  });
});

describe('12: one server down doesn’t hold another’s mail', () => {
  it('counts servers apart', () => {
    setServerDown('https://a.example.org', true);
    expect(isOfflineNow('https://a.example.org/')).toBe(true);
    expect(isOfflineNow('https://b.example.org')).toBe(false);
  });
});

describe('13: file names stay sealed', () => {
  it('keeps the name and type of a held file only in the encrypted store', async () => {
    const held = await holdFile('acc', new File(['x'], 'merger-plan.pdf', { type: 'application/pdf' }), 'merger-plan.pdf');
    expect(held.blobId).not.toMatch(/merger|pdf/);
    const db = store.dbs.get('acc')!;
    expect(db.get<{ name: string }>('SELECT name FROM upload')?.name).toBe('merger-plan.pdf');
    const everythingElse = JSON.stringify({ local: { ...localStorage }, session: { ...sessionStorage }, dbs: await indexedDB.databases() });
    expect(everythingElse).not.toMatch(/merger/);
  });
});

describe('14: the shell of another build isn’t kept under this one', () => {
  it('lists nothing when the server runs another build', async () => {
    vi.stubEnv('NEXT_PUBLIC_BUILD_ID', 'build-a');
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ buildId: 'build-b', files: ['/_next/static/x.js'] }))));
    try {
      expect(await shellFiles()).toEqual([]);
      vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ buildId: 'build-a', files: ['/_next/static/x.js'] }))));
      expect(await shellFiles()).toEqual(['/_next/static/x.js']);
    } finally {
      vi.unstubAllGlobals();
      vi.unstubAllEnvs();
    }
  });
});

describe('15: only the plugin running the composer’s send counts', () => {
  it('matches the plugin and the identity of an open takeover', async () => {
    const seen: boolean[] = [];
    const token = beginComposeTakeover('i1');
    emailHooks.onComposeSend.register('smime', () => {
      seen.push(completesComposeTakeover('smime', 'i1'), completesComposeTakeover('other', 'i1'), completesComposeTakeover('smime', 'i2'));
      return false;
    });
    await emailHooks.onComposeSend.takeOver({} as never);
    endComposeTakeover(token);
    clearAllHooks();
    expect(seen).toEqual([true, false, false]);
    expect(completesComposeTakeover('smime', 'i1')).toBe(false);
  });
});
