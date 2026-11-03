import 'fake-indexeddb/auto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { setStoreBackend } from '@/lib/store/client/api';
import { InProcessStore } from '@/lib/store/__tests__/helpers/in-process-store';
import { forgetLegacyMove, LEGACY_DB_NAME, moveLegacyOutbox } from '../migrate-legacy';
import { readQueue } from '../queue';
import { useOfflineStore } from '../state';

/** The old database, exactly as lib/offline/db.ts laid it out. */
const STORES = ['keys', 'emails', 'bodies', 'blobs', 'misc', 'ledger', 'queue', 'uploads'];

function openOld(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(LEGACY_DB_NAME, 1);
    request.onupgradeneeded = () => {
      const db = request.result;
      for (const name of STORES) {
        if (name === 'queue') db.createObjectStore(name, { keyPath: 'id', autoIncrement: true }).createIndex('account', 'account');
        else if (name === 'keys') db.createObjectStore(name, { keyPath: 'id' });
        else db.createObjectStore(name, { keyPath: 'key' }).createIndex('account', 'account');
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

function put(db: IDBDatabase, store: string, value: unknown): Promise<void> {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(store, 'readwrite');
    tx.objectStore(store).put(value);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

let key: CryptoKey;

async function seal(value: unknown): Promise<{ iv: Uint8Array; data: ArrayBuffer }> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const bytes = ArrayBuffer.isView(value) ? value as Uint8Array : new TextEncoder().encode(JSON.stringify(value));
  return { iv, data: await crypto.subtle.encrypt({ name: 'AES-GCM', iv: iv as BufferSource }, key, bytes as BufferSource) };
}

const RAW = 'Subject: Signed\r\nMessage-ID: <raw-1@example.org>\r\n\r\nbody';

async function seedOld(): Promise<void> {
  key = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
  const db = await openOld();
  await put(db, 'keys', { id: 'aes', key });
  await put(db, 'misc', { key: 'acc\u0001misc\u0001session', account: 'acc', ...(await seal({ apiUrl: 'https://old/jmap', accounts: {}, primaryAccounts: {}, capabilities: {}, downloadUrl: '', uploadUrl: '' })) });
  await put(db, 'queue', { id: 1, account: 'acc', kind: 'patch', createdAt: 1, ...(await seal({ kind: 'patch', jmap: 'acc1', update: { m1: { 'keywords/$seen': true } } })) });
  await put(db, 'queue', { id: 2, account: 'acc', kind: 'patch', createdAt: 2, ...(await seal({ kind: 'patch', jmap: 'acc1', update: { m1: { 'keywords/$flagged': true } } })) });
  await put(db, 'queue', {
    id: 3, account: 'acc', kind: 'send', createdAt: 3, status: 'waiting',
    ...(await seal({ summary: { subject: 'Waiting', to: ['b@example.org'] }, item: { kind: 'email', args: [['b@example.org'], 'Waiting', 'x', null, null, 'i', 'a@example.org'] }, fingerprint: { labelRequired: false, hasLabel: false, guards: [] } })),
  });
  await put(db, 'queue', { id: 4, account: 'acc', kind: 'send', createdAt: 4, status: 'sending', sendingSince: 4, ...(await seal({ summary: { subject: 'On its way', to: [] }, item: { kind: 'email', args: [] } })) });
  await put(db, 'queue', { id: 5, account: 'acc', kind: 'send', createdAt: 5, status: 'failed', ...(await seal({ summary: { subject: 'Refused', to: [] }, item: { kind: 'email', args: [] }, error: { text: 'No' } })) });
  await put(db, 'queue', { id: 6, account: 'acc', kind: 'send', createdAt: 6, status: 'waiting', ...(await seal({ summary: { subject: 'Signed', to: [] }, item: { kind: 'raw', blobId: 'bulwark-local-raw', identityId: 'i' } })) });
  await put(db, 'uploads', { key: 'acc\u0001bulwark-local-raw', account: 'acc', createdAt: 6, meta: await seal({ name: 'message.eml', type: 'message/rfc822' }), ...(await seal(new TextEncoder().encode(RAW))) });
  // Someone else's, with offline mode off here.
  await put(db, 'queue', { id: 7, account: 'stranger', kind: 'send', createdAt: 7, status: 'waiting', ...(await seal({ summary: { subject: 'Not moved', to: [] }, item: { kind: 'email', args: [] } })) });
  db.close();
}

const oldExists = async () => (await indexedDB.databases()).some((d) => d.name === LEGACY_DB_NAME);

let store: InProcessStore;

beforeEach(async () => {
  store = new InProcessStore();
  setStoreBackend(store);
  forgetLegacyMove();
  useOfflineStore.setState({ enabled: ['acc'] });
  await new Promise<void>((resolve) => {
    const request = indexedDB.deleteDatabase(LEGACY_DB_NAME);
    request.onsuccess = () => resolve();
  });
});

afterEach(() => {
  setStoreBackend(null);
});

describe('moving the old outbox into the store', () => {
  it('moves everything that can\'t be fetched again, then deletes the old database', async () => {
    await seedOld();
    await moveLegacyOutbox();
    const { outbox, patches } = await readQueue('acc');
    expect(outbox.map((entry) => [entry.summary.subject, entry.status])).toEqual([
      ['Waiting', 'waiting'],
      ['On its way', 'uncertain'],
      ['Refused', 'failed'],
      ['Signed', 'waiting'],
    ]);
    expect(outbox[0].createdAt).toBe(3);
    expect(outbox[0].fingerprint).toEqual({ labelRequired: false, hasLabel: false, guards: [] });
    expect(outbox[2].error).toEqual({ text: 'No' });
    // The patches of one message merge.
    expect(patches).toBe(1);
    const rows = await store.area<Array<{ patch: unknown }>>('acc', 'outbox.pendingPatches', {});
    expect(rows[0].patch).toEqual({ 'keywords/$seen': true, 'keywords/$flagged': true });
    // A waiting message gets a fixed id; one that may have left under another id doesn't pretend.
    expect(outbox[0].messageId).toMatch(/@example\.org$/);
    expect(outbox[1].messageId).toBeUndefined();
    expect(outbox[3].messageId).toBe('raw-1@example.org');
    const file = await store.area<{ name: string; blob: Blob }>('acc', 'outbox.heldFile', { blobId: 'bulwark-local-raw' });
    expect(file.name).toBe('message.eml');
    expect(await file.blob.text()).toBe(RAW);
    expect(await oldExists()).toBe(false);
    expect(store.has('stranger')).toBe(false);
  });

  it('keeps the old database when the store can\'t take it, and moves it next time without doubling', async () => {
    await seedOld();
    store.failArea = (name) => name === 'outbox.importLegacy';
    await moveLegacyOutbox();
    expect(await oldExists()).toBe(true);
    expect((await readQueue('acc')).outbox).toEqual([]);

    store.failArea = null;
    forgetLegacyMove();
    await moveLegacyOutbox();
    expect((await readQueue('acc')).outbox).toHaveLength(4);
    expect(await oldExists()).toBe(false);
  });

  it('adds nothing when a later account failed and the first runs again', async () => {
    await seedOld();
    const db = await openOld();
    await put(db, 'queue', { id: 8, account: 'second', kind: 'send', createdAt: 8, status: 'waiting', ...(await seal({ summary: { subject: 'Second', to: [] }, item: { kind: 'email', args: [] } })) });
    db.close();
    useOfflineStore.setState({ enabled: ['acc', 'second'] });
    const realArea = store.area.bind(store);
    let failSecond = true;
    store.area = (async (account: string, name: string, params?: unknown) => {
      if (failSecond && account === 'second' && name === 'outbox.importLegacy') throw new Error('full');
      return realArea(account, name, params);
    }) as typeof store.area;
    await moveLegacyOutbox();
    expect(await oldExists()).toBe(true);
    expect((await readQueue('acc')).outbox).toHaveLength(4);

    failSecond = false;
    forgetLegacyMove();
    await moveLegacyOutbox();
    expect((await readQueue('acc')).outbox).toHaveLength(4);
    expect((await readQueue('second')).outbox).toHaveLength(1);
    expect(await oldExists()).toBe(false);
  });

  it('hands the kept session to the store, for a first start without a network', async () => {
    await seedOld();
    await moveLegacyOutbox();
    expect(await store.area('acc', 'mail.session')).toMatchObject({ apiUrl: 'https://old/jmap' });
  });

  it('never creates the old database when it isn\'t there', async () => {
    await moveLegacyOutbox();
    expect(await oldExists()).toBe(false);
    expect(store.has('acc')).toBe(false);
  });

  it('skips records sealed with a key that\'s gone, and finishes', async () => {
    await seedOld();
    const db = await openOld();
    const other = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
    const iv = crypto.getRandomValues(new Uint8Array(12));
    await put(db, 'queue', { id: 9, account: 'acc', kind: 'send', createdAt: 9, status: 'waiting', iv, data: await crypto.subtle.encrypt({ name: 'AES-GCM', iv: iv as BufferSource }, other, new Uint8Array([1])) });
    db.close();
    await moveLegacyOutbox();
    expect((await readQueue('acc')).outbox).toHaveLength(4);
    expect(await oldExists()).toBe(false);
  });
});
