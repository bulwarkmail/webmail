import 'fake-indexeddb/auto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useAuthStore } from '@/stores/auth-store';
import { useAccountStore } from '@/stores/account-store';
import { useEmailStore } from '@/stores/email-store';
import { usePolicyStore } from '@/stores/policy-store';
import { DEFAULT_ORGANISATION_POLICY } from '@/lib/admin/organisation-policy';
import { passSignOutGates, addSignOutGate, purgeSignedOutData } from '@/lib/sign-out-cleanup';
import { setStoreBackend } from '@/lib/store/client/api';
import { FakeJmapMail } from '@/lib/store/__tests__/helpers/fake-jmap-mail';
import { InProcessStore } from '@/lib/store/__tests__/helpers/in-process-store';
import { enforcePolicy, startOfflineMode, wipeEverything } from '../offline-mode';
import { flushQueue } from '../flush';
import { holdFile, readQueue } from '../queue';
import { forgetLegacyMove } from '../migrate-legacy';
import { useOfflineStore, writeEnabled, OFFLINE_ACCOUNTS_KEY } from '../state';
import type { JMAPClient } from '@/lib/jmap/client';

let server: FakeJmapMail;
let store: InProcessStore;

function fakeClient(overrides: Record<string, unknown> = {}) {
  return {
    getServerUrl: () => 'https://mail.example.org',
    getUsername: () => 'alice@example.org',
    getAccountId: () => 'acc1',
    isOfflineOnly: () => false,
    getSessionSnapshot: () => null,
    getAuthHeader: () => 'Basic x',
    keywordSortInverted: () => null,
    sendEmail: vi.fn(async () => ({ scheduled: false, emailId: 'sent-1', emailSubmissionId: 'sub-1' })),
    uploadBlob: vi.fn(async (file: File) => ({ blobId: `server-${file.name}`, size: file.size, type: file.type })),
    requestNetworkOnly: vi.fn((calls: never) => server.request(calls)),
    resolveSendAccountId: vi.fn(async () => 'acc1'),
    submissionAccountFor: () => 'acc1',
    pruneEmailSubmissions: vi.fn(async () => {}),
    getMailboxes: vi.fn(async () => [{ id: 'sent', role: 'sent' }, { id: 'drafts', role: 'drafts' }]),
    sendRawEmail: vi.fn(async () => ({ scheduled: false })),
    submitRawEmail: vi.fn(async () => ({ scheduled: false })),
    ...overrides,
  };
}

function setOnline(online: boolean) {
  Object.defineProperty(window.navigator, 'onLine', { configurable: true, get: () => online });
  window.dispatchEvent(new Event(online ? 'online' : 'offline'));
}

let stop: () => void = () => {};

beforeEach(async () => {
  server = new FakeJmapMail({ mailboxes: [{ id: 'inbox', role: 'inbox' }, { id: 'drafts', role: 'drafts' }, { id: 'sent', role: 'sent' }] });
  server.addEmail({ id: 'm1', keywords: {}, subject: 'One' });
  store = new InProcessStore(server);
  setStoreBackend(store);
  forgetLegacyMove();
  localStorage.clear();
  useOfflineStore.setState({ enabled: [], outbox: [], pendingChanges: 0, conflicts: [], browserOffline: false, downServers: [], startedOffline: false });
  usePolicyStore.setState({ loaded: true, subject: null, policy: { ...usePolicyStore.getState().policy, organisation: DEFAULT_ORGANISATION_POLICY } });
  useAccountStore.setState({ accounts: [{ id: 'acc', label: 'alice', serverUrl: 'https://mail.example.org', username: 'alice@example.org' } as never] });
});

afterEach(async () => {
  stop();
  stop = () => {};
  setOnline(true);
  await wipeEverything();
  setStoreBackend(null);
});

const sendArgs = (client: unknown, options: Record<string, unknown>) => useEmailStore.getState().sendEmail(
  client as never, ['bob@example.org'], 'Quarterly numbers', 'Hi Bob', undefined, undefined, 'id-1', 'alice@example.org',
  'draft-1', 'Alice', '<p>Hi Bob</p>', [{ blobId: 'blob-1', name: 'a.txt', type: 'text/plain', size: 3 }], undefined, undefined, undefined, undefined, options as never,
);

const patchOffline = (update: Record<string, unknown>) => store.answer('acc', [['Email/set', { update }, '0']]);

describe('the outbox', () => {
  it('keeps a composer send while offline, with its label and a fixed Message-ID, and sends nothing', async () => {
    const client = fakeClient();
    useAuthStore.setState({ client: client as never, activeAccountId: 'acc' });
    writeEnabled(['acc']);
    stop = startOfflineMode();
    setOnline(false);

    const result = await sendArgs(client, { outbox: true, labelHeaders: { 'header:SIO-Label:asRaw': ' marking="CONFIDENTIAL"' } });
    expect(result.queued).toBe(true);
    expect(client.sendEmail).not.toHaveBeenCalled();
    const { outbox } = await readQueue('acc');
    expect(outbox).toHaveLength(1);
    expect(outbox[0].summary).toEqual({ subject: 'Quarterly numbers', to: ['bob@example.org'] });
    expect(outbox[0].item).toMatchObject({ kind: 'email' });
    expect(outbox[0].messageId).toMatch(/@example\.org$/);
    const options = (outbox[0].item as { args: unknown[] }).args[15] as Record<string, unknown>;
    expect(options.labelHeaders).toEqual({ 'header:SIO-Label:asRaw': ' marking="CONFIDENTIAL"' });
    expect(options).not.toHaveProperty('outbox');
  });

  it('takes the domain of a Message-ID from a sender written with a name', async () => {
    const client = fakeClient();
    useAuthStore.setState({ client: client as never, activeAccountId: 'acc' });
    writeEnabled(['acc']);
    stop = startOfflineMode();
    setOnline(false);
    await useEmailStore.getState().sendEmail(client as never, ['b@example.org'], 'S', 'x', undefined, undefined, 'i', 'Alice <alice@example.net>', undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, { outbox: true } as never);
    expect((await readQueue('acc')).outbox[0].messageId).toMatch(/@example\.net$/);
  });

  it('sends with the Message-ID fixed at queueing, and the same one after a retry', async () => {
    const client = fakeClient({
      sendEmail: vi.fn()
        .mockRejectedValueOnce(Object.assign(new Error('x'), { name: 'SendNotStartedError' }))
        .mockResolvedValue({ scheduled: false }),
    });
    useAuthStore.setState({ client: client as never, activeAccountId: 'acc' });
    writeEnabled(['acc']);
    stop = startOfflineMode();
    setOnline(false);
    await sendArgs(client, { outbox: true });
    const fixed = (await readQueue('acc')).outbox[0].messageId;
    setOnline(true);
    await flushQueue('acc', client as unknown as JMAPClient, { notify: vi.fn(), allowed: () => true });
    await flushQueue('acc', client as unknown as JMAPClient, { notify: vi.fn(), allowed: () => true });
    const calls = (client.sendEmail as ReturnType<typeof vi.fn>).mock.calls as unknown[][];
    expect(calls).toHaveLength(2);
    expect((calls[0][15] as { messageId: string }).messageId).toBe(fixed);
    expect((calls[1][15] as { messageId: string }).messageId).toBe(fixed);
    expect((await readQueue('acc')).outbox).toEqual([]);
  });

  it('leaves sends from elsewhere (plugin forward, phishing report) to the network', async () => {
    const client = fakeClient({ sendEmail: vi.fn(async () => { throw new TypeError('Failed to fetch'); }) });
    useAuthStore.setState({ client: client as never, activeAccountId: 'acc' });
    writeEnabled(['acc']);
    stop = startOfflineMode();
    setOnline(false);
    await expect(sendArgs(client, {})).rejects.toThrow('Failed to fetch');
    expect((await readQueue('acc')).outbox).toHaveLength(0);
  });

  it('sends normally while online, and without offline mode', async () => {
    const client = fakeClient();
    useAuthStore.setState({ client: client as never, activeAccountId: 'acc' });
    stop = startOfflineMode();
    setOnline(false);
    // Offline mode is off for this account: nothing is kept.
    await sendArgs(client, { outbox: true });
    expect(client.sendEmail).toHaveBeenCalledTimes(1);
  });

  it('sends what waited in order once the server answers: changes first, then mail', async () => {
    const order: string[] = [];
    const client = fakeClient({
      requestNetworkOnly: vi.fn(async (calls: Array<[string]>) => {
        if (calls[0][0] === 'Email/set') order.push('patch');
        return server.request(calls as never);
      }),
      sendEmail: vi.fn(async () => { order.push('send'); return { scheduled: false }; }),
    });
    useAuthStore.setState({ client: client as never, activeAccountId: 'acc' });
    writeEnabled(['acc']);
    stop = startOfflineMode();
    await store.sync('acc');
    setOnline(false);
    await patchOffline({ m1: { 'keywords/$seen': true } });
    const held = await holdFile('acc', new File(['hello'], 'note.txt', { type: 'text/plain' }), 'note.txt');
    await useEmailStore.getState().sendEmail(client as never, ['bob@example.org'], 'With file', 'x', undefined, undefined, 'id-1', 'alice@example.org', undefined, 'Alice', undefined,
      [{ blobId: held.blobId, name: 'note.txt', type: 'text/plain', size: 5 }], undefined, undefined, new Date(Date.now() + 5000).toISOString(), undefined, { outbox: true } as never);

    setOnline(true);
    const notify = vi.fn();
    await flushQueue('acc', client as unknown as JMAPClient, { notify, allowed: () => true });
    expect(order).toEqual(['patch', 'send']);
    expect(server.emails.get('m1')?.keywords).toEqual({ $seen: true });
    const args = (client.sendEmail as ReturnType<typeof vi.fn>).mock.calls[0] as unknown[];
    expect(args[1]).toBe('With file');
    // The file attached offline was uploaded first; the passed undo hold was dropped.
    expect(args[10]).toEqual([{ blobId: 'server-note.txt', name: 'note.txt', type: 'text/plain', size: 5 }]);
    expect(args[13]).toBeUndefined();
    expect(notify).toHaveBeenCalledWith({ kind: 'sent', subject: 'With file' });
    const left = await readQueue('acc');
    expect(left.outbox).toHaveLength(0);
    expect(left.patches).toBe(0);
  });

  it('a change made after a send goes after it', async () => {
    const order: string[] = [];
    const client = fakeClient({
      requestNetworkOnly: vi.fn(async (calls: Array<[string]>) => {
        if (calls[0][0] === 'Email/set') order.push('patch');
        return server.request(calls as never);
      }),
      sendEmail: vi.fn(async () => { order.push('send'); return { scheduled: false }; }),
    });
    useAuthStore.setState({ client: client as never, activeAccountId: 'acc' });
    writeEnabled(['acc']);
    stop = startOfflineMode();
    await store.sync('acc');
    setOnline(false);
    await sendArgs(client, { outbox: true });
    await patchOffline({ m1: { 'keywords/$answered': true } });
    setOnline(true);
    await flushQueue('acc', client as unknown as JMAPClient, { notify: vi.fn(), allowed: () => true });
    expect(order).toEqual(['send', 'patch']);
  });

  it('keeps a send the server refused, marked failed, and one cut off on the way, marked uncertain', async () => {
    const client = fakeClient({ sendEmail: vi.fn(async () => { throw new Error('Recipient address rejected'); }) });
    useAuthStore.setState({ client: client as never, activeAccountId: 'acc' });
    writeEnabled(['acc']);
    stop = startOfflineMode();
    setOnline(false);
    await sendArgs(client, { outbox: true });
    setOnline(true);
    await flushQueue('acc', client as unknown as JMAPClient, { notify: vi.fn(), allowed: () => true });
    let { outbox } = await readQueue('acc');
    expect(outbox[0].status).toBe('failed');
    expect(outbox[0].error).toEqual({ text: 'Recipient address rejected' });

    store.stop();
    writeEnabled(['acc']);
    // The lookup that follows can't reach the server either, so it stays uncertain.
    const cut = fakeClient({
      sendEmail: vi.fn(async () => { throw new TypeError('Failed to fetch'); }),
      requestNetworkOnly: vi.fn(async () => { throw new TypeError('Failed to fetch'); }),
    });
    useAuthStore.setState({ client: cut as never, activeAccountId: 'acc' });
    setOnline(false);
    await sendArgs(cut, { outbox: true });
    setOnline(true);
    await flushQueue('acc', cut as unknown as JMAPClient, { notify: vi.fn(), allowed: () => true });
    ({ outbox } = await readQueue('acc'));
    expect(outbox[0].status).toBe('uncertain');
    // Not tried again on its own.
    await flushQueue('acc', cut as unknown as JMAPClient, { notify: vi.fn(), allowed: () => true });
    expect(cut.sendEmail).toHaveBeenCalledTimes(1);

    // With the server still there, nothing else would start the lookup.
    const entry = (await readQueue('acc')).outbox[0];
    await store.area('acc', 'outbox.update', { id: entry.id, status: 'waiting' });
    const retryLater = vi.fn();
    await flushQueue('acc', cut as unknown as JMAPClient, { notify: vi.fn(), allowed: () => true, retryLater });
    expect(retryLater).toHaveBeenCalledTimes(1);
  });

  it('sends nothing once the organisation forbids offline mode', async () => {
    const client = fakeClient();
    await store.sync('acc');
    await patchOffline({ m1: { 'keywords/$seen': true } });
    await flushQueue('acc', client as unknown as JMAPClient, { notify: vi.fn(), allowed: () => false });
    expect(client.requestNetworkOnly).not.toHaveBeenCalled();
    expect(server.emails.get('m1')?.keywords).toEqual({});
  });
});

describe('a send whose response got lost', () => {
  async function uncertainSend(client: ReturnType<typeof fakeClient>) {
    useAuthStore.setState({ client: client as never, activeAccountId: 'acc' });
    writeEnabled(['acc']);
    stop = startOfflineMode();
    setOnline(false);
    await sendArgs(client, { outbox: true });
    setOnline(true);
    const entry = (await readQueue('acc')).outbox[0];
    await store.area('acc', 'outbox.claim', { id: entry.id });
    await store.area('acc', 'outbox.update', { id: entry.id, status: 'uncertain' });
    // The wait before a lookup has passed.
    store.dbs.get('acc')!.run('UPDATE outbox SET last_attempt_at = ?', [Date.now() - 31_000]);
    return entry;
  }

  const flush = (client: ReturnType<typeof fakeClient>, notify = vi.fn()) => flushQueue('acc', client as unknown as JMAPClient, { notify, allowed: () => true });

  const copy = (messageId: string | undefined, over: Record<string, unknown>) => server.addEmail({
    id: 'copy', messageId: [messageId as string], receivedAt: new Date().toISOString(), ...over,
  });

  it('never arrived: sends it again, with the same Message-ID', async () => {
    const client = fakeClient();
    const entry = await uncertainSend(client);
    const notify = vi.fn();
    await flush(client, notify);
    expect(client.sendEmail).toHaveBeenCalledTimes(1);
    const args = (client.sendEmail as ReturnType<typeof vi.fn>).mock.calls[0] as unknown[];
    expect((args[15] as { messageId?: string; existingCopyId?: string })).toMatchObject({ messageId: entry.messageId });
    expect(args[15]).not.toHaveProperty('existingCopyId');
    expect(notify).toHaveBeenCalledWith({ kind: 'sent', subject: 'Quarterly numbers' });
  });

  it('draft arrived, submission didn\'t: submits that copy and uploads nothing again', async () => {
    const client = fakeClient();
    const entry = await uncertainSend(client);
    copy(entry.messageId, { mailboxIds: { drafts: true }, keywords: { $draft: true } });
    await flush(client);
    expect(client.sendEmail).toHaveBeenCalledTimes(1);
    const args = (client.sendEmail as ReturnType<typeof vi.fn>).mock.calls[0] as unknown[];
    expect(args[15]).toMatchObject({ messageId: entry.messageId, existingCopyId: 'copy' });
    expect(client.uploadBlob).not.toHaveBeenCalled();
  });

  it('both arrived: done, nothing sent, and the old draft goes', async () => {
    const client = fakeClient();
    const entry = await uncertainSend(client);
    copy(entry.messageId, { mailboxIds: { sent: true }, keywords: {} });
    server.addEmail({ id: 'draft-1', mailboxIds: { drafts: true }, keywords: { $draft: true } });
    const notify = vi.fn();
    await flush(client, notify);
    expect(client.sendEmail).not.toHaveBeenCalled();
    expect((await readQueue('acc')).outbox).toEqual([]);
    expect(server.emails.has('draft-1')).toBe(false);
    expect(notify).toHaveBeenCalledWith({ kind: 'sent', subject: 'Quarterly numbers' });
  });

  it('scheduled: done, the submission stays', async () => {
    const client = fakeClient();
    const entry = await uncertainSend(client);
    copy(entry.messageId, { mailboxIds: { drafts: true }, keywords: { $draft: true } });
    server.addSubmission('copy', 'pending');
    await flush(client);
    expect(client.sendEmail).not.toHaveBeenCalled();
    expect((await readQueue('acc')).outbox).toEqual([]);
  });

  it('canceled: done without a "sent" notice, and it doesn\'t go', async () => {
    const client = fakeClient();
    const entry = await uncertainSend(client);
    copy(entry.messageId, { mailboxIds: { drafts: true }, keywords: { $draft: true } });
    server.addSubmission('copy', 'canceled');
    const notify = vi.fn();
    await flush(client, notify);
    expect(client.sendEmail).not.toHaveBeenCalled();
    expect((await readQueue('acc')).outbox).toEqual([]);
    expect(notify).not.toHaveBeenCalledWith(expect.objectContaining({ kind: 'sent' }));
  });

  it('a lookup that can\'t decide leaves it uncertain for the user, who can still send it', async () => {
    const client = fakeClient();
    const entry = await uncertainSend(client);
    server.failNext.set('Email/query', 'forbidden');
    await flush(client);
    expect(client.sendEmail).not.toHaveBeenCalled();
    expect((await readQueue('acc')).outbox[0].status).toBe('uncertain');

    const { retryOutboxEntry } = await import('../flush');
    await retryOutboxEntry('acc', entry.id);
    expect((await readQueue('acc')).outbox[0].status).toBe('waiting');
    await flush(client);
    expect(client.sendEmail).toHaveBeenCalledTimes(1);
  });

  it('a send that fails on the server clears the copy, so a retry starts clean', async () => {
    const client = fakeClient({ sendEmail: vi.fn(async () => { throw new Error('Refused'); }) });
    const entry = await uncertainSend(client);
    copy(entry.messageId, { mailboxIds: { drafts: true }, keywords: { $draft: true } });
    await flush(client);
    const [after] = (await readQueue('acc')).outbox;
    expect(after.status).toBe('failed');
    expect(after.copyId).toBeUndefined();
  });
});

describe('what the other areas queued', () => {
  const flushWith = async (tally: unknown) => {
    const { flushAll } = await import('../offline-mode');
    const client = fakeClient();
    useAuthStore.setState({ client: client as never, activeAccountId: 'acc' });
    usePolicyStore.setState({ fetchPolicy: vi.fn(async () => {}), source: 'server' } as never);
    const realArea = store.area.bind(store);
    const calls: string[] = [];
    store.area = (async (account: string, name: string, params?: unknown) => {
      if (name.endsWith('.flush')) {
        calls.push(name);
        return tally;
      }
      return realArea(account, name, params);
    }) as typeof store.area;
    const { subscribePushStateChanges } = await import('@/lib/push-events');
    const pushes: unknown[] = [];
    const unsubscribe = subscribePushStateChanges((change, _client, role) => pushes.push([change.changed, role]));
    useAccountStore.setState({ accounts: [{ id: 'acc', serverUrl: 'https://mail.example.org', username: 'alice@example.org' } as never] });
    useAuthStore.setState({ getClientForAccount: () => client } as never);
    writeEnabled(['acc']);
    await flushAll();
    unsubscribe();
    return { calls, pushes };
  };

  it('flushes them, also with nothing in the outbox, and has the page read again', async () => {
    const { calls, pushes } = await flushWith({ sent: 1, conflicts: 0, pending: 0 });
    expect(calls).toEqual(['calendar.flush', 'contacts.flush']);
    expect(pushes).toEqual([
      [{ acc1: { Calendar: 'flushed', CalendarEvent: 'flushed' } }, 'active'],
      [{ acc1: { AddressBook: 'flushed', ContactCard: 'flushed' } }, 'active'],
    ]);
  });

  it('doesn\u2019t have the page read again when nothing went out', async () => {
    const { pushes } = await flushWith({ sent: 0, conflicts: 0, pending: 0 });
    expect(pushes).toEqual([]);
  });
});

describe('conflicts reach the page', () => {
  it('lists a refused change and tells the user', async () => {
    const client = fakeClient();
    useAuthStore.setState({ client: client as never, activeAccountId: 'acc' });
    writeEnabled(['acc']);
    stop = startOfflineMode();
    await store.sync('acc');
    await patchOffline({ m1: { 'keywords/$seen': true } });
    server.refuse.set('m1', { type: 'forbidden' });
    const notify = vi.fn();
    await flushQueue('acc', client as unknown as JMAPClient, { notify, allowed: () => true });
    expect(notify).toHaveBeenCalledWith({ kind: 'conflict', count: 1 });
    const { conflicts, patches } = await readQueue('acc');
    expect(patches).toBe(0);
    expect(conflicts).toEqual([expect.objectContaining({ account: 'acc', recordId: 'm1', summary: expect.objectContaining({ subject: 'One', reason: 'refused' }) })]);
  });
});

describe('wiping offline data', () => {
  it('wipes an account when the organisation forbids offline mode', async () => {
    const client = fakeClient();
    useAuthStore.setState({ client: client as never, activeAccountId: 'acc' });
    writeEnabled(['acc']);
    stop = startOfflineMode();
    usePolicyStore.setState({ policy: { ...usePolicyStore.getState().policy, organisation: { ...DEFAULT_ORGANISATION_POLICY, devices: { ...DEFAULT_ORGANISATION_POLICY.devices, noOffline: true } } } });
    enforcePolicy();
    await vi.waitFor(async () => expect(useOfflineStore.getState().enabled).toEqual([]));
    // Its only account: the whole store goes.
    await vi.waitFor(() => expect(store.stopped).toBeGreaterThan(0));
    expect(localStorage.getItem(OFFLINE_ACCOUNTS_KEY)).toBeNull();
  });

  it('wipes an account that signs out or is removed on purpose', async () => {
    useAccountStore.setState({ accounts: [{ id: 'acc' } as never, { id: 'other' } as never] });
    writeEnabled(['acc', 'other']);
    stop = startOfflineMode();
    await store.sync('acc');
    await store.sync('other');
    useAccountStore.getState().removeAccount('acc');
    await vi.waitFor(() => expect(useOfflineStore.getState().enabled).toEqual(['other']));
    await vi.waitFor(() => expect(store.removed).toEqual(['acc']));
    expect(store.has('acc')).toBe(false);
    expect(store.has('other')).toBe(true);
  });

  it('keeps the data of an account the app dropped by itself', async () => {
    useAccountStore.setState({ accounts: [{ id: 'acc' } as never, { id: 'other' } as never] });
    writeEnabled(['acc', 'other']);
    stop = startOfflineMode();
    await store.sync('acc');
    useAccountStore.getState().removeAccount('acc', 'evicted');
    await new Promise((r) => setTimeout(r, 20));
    expect(useAccountStore.getState().accounts.map((a) => a.id)).toEqual(['other']);
    expect(useOfflineStore.getState().enabled).toEqual(['acc', 'other']);
    expect(store.removed).toEqual([]);
  });

  it('deletes the old database, the key database and the switch at a full sign-out', async () => {
    writeEnabled(['acc']);
    await new Promise<void>((resolve) => {
      const request = indexedDB.open('bulwark-offline');
      request.onsuccess = () => { request.result.close(); resolve(); };
    });
    await new Promise<void>((resolve) => {
      const request = indexedDB.open('bulwark-store');
      request.onsuccess = () => { request.result.close(); resolve(); };
    });
    const removeEntry = vi.fn(async () => {});
    const getDirectory = vi.fn(async () => ({ removeEntry }));
    Object.defineProperty(window.navigator, 'storage', { configurable: true, value: { getDirectory } });
    try {
      purgeSignedOutData();
      expect(localStorage.getItem(OFFLINE_ACCOUNTS_KEY)).toBeNull();
      await vi.waitFor(async () => {
        const dbs = (await indexedDB.databases()).map((d) => d.name);
        expect(dbs).not.toContain('bulwark-offline');
        expect(dbs).not.toContain('bulwark-store');
      });
      // With no worker running: straight from the page.
      await vi.waitFor(() => expect(removeEntry).toHaveBeenCalledWith('.bulwark-store', { recursive: true }));
      expect(store.stopped).toBeGreaterThan(0);
    } finally {
      delete (window.navigator as { storage?: unknown }).storage;
    }
  });
});

describe('signing out with unsent mail', () => {
  it('asks first, and a no keeps everyone signed in', async () => {
    const remove = addSignOutGate(async () => false);
    expect(await passSignOutGates('all')).toBe(false);
    remove();
    expect(await passSignOutGates('all')).toBe(true);
  });
});

describe('after a sign-out', () => {
  it('starting offline mode on the sign-in page doesn\'t create the store again', async () => {
    const stopHere = startOfflineMode();
    await new Promise((r) => setTimeout(r, 50));
    const { refreshQueueState, refreshUsage } = await import('../offline-mode');
    await refreshQueueState();
    await refreshUsage();
    stopHere();
    expect(store.engines.size).toBe(0);
    expect((await indexedDB.databases()).map((d) => d.name)).not.toContain('bulwark-store');
  });
});
