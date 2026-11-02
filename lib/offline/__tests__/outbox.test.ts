import 'fake-indexeddb/auto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useAuthStore } from '@/stores/auth-store';
import { useAccountStore } from '@/stores/account-store';
import { useEmailStore } from '@/stores/email-store';
import { usePolicyStore } from '@/stores/policy-store';
import { DEFAULT_ORGANISATION_POLICY } from '@/lib/admin/organisation-policy';
import { passSignOutGates, addSignOutGate, purgeSignedOutData } from '@/lib/sign-out-cleanup';
import { enforcePolicy, startOfflineMode, wipeEverything } from '../offline-mode';
import { flushQueue } from '../flush';
import { holdFile, queuePatch, readQueue } from '../queue';
import { emailIndex, forgetIndexes, putEmails } from '../cache';
import { forgetDeviceKey } from '../crypto';
import { allowOfflineDbCreation, deleteOfflineDb } from '../db';
import { useOfflineStore, writeEnabled, OFFLINE_ACCOUNTS_KEY } from '../state';
import type { JMAPClient } from '@/lib/jmap/client';

function fakeClient(overrides: Record<string, unknown> = {}) {
  return {
    getServerUrl: () => 'https://mail.example.org',
    getUsername: () => 'alice@example.org',
    getAccountId: () => 'j1',
    isOfflineOnly: () => false,
    getSessionSnapshot: () => ({ apiUrl: 'https://mail.example.org/jmap' }),
    sendEmail: vi.fn(async () => ({ scheduled: false, emailId: 'sent-1', emailSubmissionId: 'sub-1' })),
    uploadBlob: vi.fn(async (file: File) => ({ blobId: `server-${file.name}`, size: file.size, type: file.type })),
    applyEmailPatches: vi.fn(async () => []),
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
  forgetIndexes();
  forgetDeviceKey();
  await deleteOfflineDb();
  allowOfflineDbCreation();
  localStorage.clear();
  useOfflineStore.setState({ enabled: [], outbox: [], pendingChanges: 0, browserOffline: false, downServers: [], startedOffline: false });
  usePolicyStore.setState({ loaded: true, subject: null, policy: { ...usePolicyStore.getState().policy, organisation: DEFAULT_ORGANISATION_POLICY } });
  useAccountStore.setState({ accounts: [{ id: 'acc', label: 'alice', serverUrl: 'https://mail.example.org', username: 'alice@example.org' } as never] });
});

afterEach(async () => {
  stop();
  setOnline(true);
  await wipeEverything();
});

const sendArgs = (client: unknown, options: Record<string, unknown>) => useEmailStore.getState().sendEmail(
  client as never, ['bob@example.org'], 'Quarterly numbers', 'Hi Bob', undefined, undefined, 'id-1', 'alice@example.org',
  'draft-1', 'Alice', '<p>Hi Bob</p>', [{ blobId: 'blob-1', name: 'a.txt', type: 'text/plain', size: 3 }], undefined, undefined, undefined, undefined, options as never,
);

describe('the outbox', () => {
  it('keeps a composer send while offline, with its label, and sends nothing', async () => {
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
    const options = (outbox[0].item as { args: unknown[] }).args[15] as Record<string, unknown>;
    expect(options.labelHeaders).toEqual({ 'header:SIO-Label:asRaw': ' marking="CONFIDENTIAL"' });
    expect(options).not.toHaveProperty('outbox');
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
      applyEmailPatches: vi.fn(async () => { order.push('patch'); return []; }),
      sendEmail: vi.fn(async () => { order.push('send'); return { scheduled: false }; }),
    });
    useAuthStore.setState({ client: client as never, activeAccountId: 'acc' });
    writeEnabled(['acc']);
    stop = startOfflineMode();
    setOnline(false);
    await queuePatch('acc', 'j1', { m1: { 'keywords/$seen': true } });
    const held = await holdFile('acc', new File(['hello'], 'note.txt', { type: 'text/plain' }), 'note.txt');
    await useEmailStore.getState().sendEmail(client as never, ['bob@example.org'], 'With file', 'x', undefined, undefined, 'id-1', 'alice@example.org', undefined, 'Alice', undefined,
      [{ blobId: held.blobId, name: 'note.txt', type: 'text/plain', size: 5 }], undefined, undefined, new Date(Date.now() + 5000).toISOString(), undefined, { outbox: true } as never);

    setOnline(true);
    const notify = vi.fn();
    await flushQueue('acc', client as unknown as JMAPClient, { notify, allowed: () => true });
    expect(order).toEqual(['patch', 'send']);
    expect(client.applyEmailPatches).toHaveBeenCalledWith('j1', { m1: { 'keywords/$seen': true } });
    const args = (client.sendEmail as ReturnType<typeof vi.fn>).mock.calls[0] as unknown[];
    expect(args[1]).toBe('With file');
    // The file attached offline was uploaded first; the passed undo hold was dropped.
    expect(args[10]).toEqual([{ blobId: 'server-note.txt', name: 'note.txt', type: 'text/plain', size: 5 }]);
    expect(args[13]).toBeUndefined();
    expect(notify).toHaveBeenCalledWith({ kind: 'sent', subject: 'With file' });
    const left = await readQueue('acc');
    expect(left.outbox).toHaveLength(0);
    expect(left.patches).toHaveLength(0);
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

    const cut = fakeClient({ sendEmail: vi.fn(async () => { throw new TypeError('Failed to fetch'); }) });
    await wipeEverything();
    allowOfflineDbCreation();
    writeEnabled(['acc']);
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
  });

  it('sends nothing once the organisation forbids offline mode', async () => {
    const client = fakeClient();
    await queuePatch('acc', 'j1', { m1: { 'keywords/$seen': true } });
    await flushQueue('acc', client as unknown as JMAPClient, { notify: vi.fn(), allowed: () => false });
    expect(client.applyEmailPatches).not.toHaveBeenCalled();
  });
});

describe('wiping offline data', () => {
  it('wipes an account when the organisation forbids offline mode', async () => {
    const client = fakeClient();
    useAuthStore.setState({ client: client as never, activeAccountId: 'acc' });
    writeEnabled(['acc']);
    stop = startOfflineMode();
    await putEmails('acc', 'j1', [{ id: 'm1', mailboxIds: { inbox: true }, receivedAt: new Date().toISOString() }]);
    usePolicyStore.setState({ policy: { ...usePolicyStore.getState().policy, organisation: { ...DEFAULT_ORGANISATION_POLICY, devices: { ...DEFAULT_ORGANISATION_POLICY.devices, noOffline: true } } } });
    enforcePolicy();
    await vi.waitFor(async () => expect(useOfflineStore.getState().enabled).toEqual([]));
    // Its only account: the whole database goes.
    await vi.waitFor(async () => expect((await indexedDB.databases()).map((d) => d.name)).not.toContain('bulwark-offline'));
    expect(localStorage.getItem(OFFLINE_ACCOUNTS_KEY)).toBeNull();
  });

  it('wipes an account that signs out', async () => {
    writeEnabled(['acc', 'other']);
    stop = startOfflineMode();
    await putEmails('acc', 'j1', [{ id: 'm1', mailboxIds: { inbox: true }, receivedAt: new Date().toISOString() }]);
    await putEmails('other', 'j1', [{ id: 'm2', mailboxIds: { inbox: true }, receivedAt: new Date().toISOString() }]);
    useAccountStore.setState({ accounts: [{ id: 'other' } as never] });
    await vi.waitFor(() => expect(useOfflineStore.getState().enabled).toEqual(['other']));
    await vi.waitFor(async () => {
      forgetIndexes();
      expect((await emailIndex('acc')).size).toBe(0);
    });
    expect((await emailIndex('other')).size).toBe(1);
  });

  it('deletes the database and the switch at a full sign-out', async () => {
    writeEnabled(['acc']);
    await putEmails('acc', 'j1', [{ id: 'm1', mailboxIds: { inbox: true }, receivedAt: new Date().toISOString() }]);
    forgetIndexes();
    purgeSignedOutData();
    expect(localStorage.getItem(OFFLINE_ACCOUNTS_KEY)).toBeNull();
    await vi.waitFor(async () => {
      const dbs = await indexedDB.databases();
      expect(dbs.map((d) => d.name)).not.toContain('bulwark-offline');
    });
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
  it('starting offline mode on the sign-in page doesn\'t create the database again', async () => {
    const stop = startOfflineMode();
    await new Promise((r) => setTimeout(r, 50));
    const { refreshQueueState, refreshUsage } = await import('../offline-mode');
    await refreshQueueState();
    await refreshUsage();
    stop();
    expect((await indexedDB.databases()).map((d) => d.name)).not.toContain('bulwark-offline');
  });
});
