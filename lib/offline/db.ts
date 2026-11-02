/**
 * The IndexedDB database of offline mode (#523): one per browser profile,
 * deleted as a whole at a full sign-out (lib/sign-out-cleanup.ts) and when
 * the last account switches offline mode off.
 *
 * Stores (every value but the key and the ledger is encrypted, see crypto.ts):
 * - keys: the AES-GCM key, non-extractable.
 * - emails: message metadata (what the list shows), per account and JMAP account.
 * - bodies: the text of a message (bodyValues and the parts that say how to show it).
 * - blobs: attachments and inline images.
 * - misc: the session, folders, identities, the folders the user opened.
 * - ledger: size and date of each cached record, unencrypted, so the cache
 *   can be kept under its cap without decrypting everything.
 * - queue: changes and messages waiting for the network (never evicted).
 * - uploads: files attached while offline, until their message is sent.
 */

export const OFFLINE_DB_NAME = 'bulwark-offline';
const VERSION = 1;

export const STORES = ['keys', 'emails', 'bodies', 'blobs', 'misc', 'ledger', 'queue', 'uploads'] as const;
export type StoreName = (typeof STORES)[number];

let dbPromise: Promise<IDBDatabase> | null = null;
/**
 * Only switching offline mode on may create the database. Everything else
 * opens it only when it exists: another tab may have deleted it (offline
 * mode switched off, a sign-out), and opening it would create it anew.
 */
let mayCreate = false;

export function allowOfflineDbCreation(): void {
  mayCreate = true;
}

async function offlineDbExists(): Promise<boolean> {
  try {
    if (typeof indexedDB.databases !== 'function') return true;
    return (await indexedDB.databases()).some((d) => d.name === OFFLINE_DB_NAME);
  } catch {
    return true;
  }
}

/** Thrown when the database was deleted (or never made) and may not be created here. */
export class OfflineDbMissingError extends Error {
  constructor() {
    super('The offline database is not set up');
    this.name = 'OfflineDbMissingError';
  }
}

export function hasIndexedDb(): boolean {
  try {
    return typeof indexedDB !== 'undefined' && indexedDB !== null;
  } catch {
    return false;
  }
}

export function openOfflineDb(): Promise<IDBDatabase> {
  if (dbPromise) return dbPromise;
  const opening = (async () => {
    if (!mayCreate && !(await offlineDbExists())) throw new OfflineDbMissingError();
    return openNow();
  })();
  dbPromise = opening;
  opening.catch(() => {
    if (dbPromise === opening) dbPromise = null;
  });
  return opening;
}

function openNow(): Promise<IDBDatabase> {
  return new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open(OFFLINE_DB_NAME, VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      for (const name of STORES) {
        if (db.objectStoreNames.contains(name)) continue;
        if (name === 'queue') {
          db.createObjectStore(name, { keyPath: 'id', autoIncrement: true }).createIndex('account', 'account');
        } else if (name === 'keys') {
          db.createObjectStore(name, { keyPath: 'id' });
        } else {
          db.createObjectStore(name, { keyPath: 'key' }).createIndex('account', 'account');
        }
      }
    };
    request.onsuccess = () => {
      const db = request.result;
      // A sign-out in this or another tab deletes the database: let it.
      db.onversionchange = () => {
        db.close();
        dbPromise = null;
        mayCreate = false;
      };
      db.onclose = () => {
        dbPromise = null;
      };
      resolve(db);
    };
    request.onerror = () => reject(request.error);
    request.onblocked = () => reject(new Error('offline database blocked'));
  });
}

function done(tx: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error ?? new Error('transaction aborted'));
  });
}

function result<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

export async function idbGet<T>(store: StoreName, key: IDBValidKey): Promise<T | undefined> {
  const db = await openOfflineDb();
  return result(db.transaction(store, 'readonly').objectStore(store).get(key)) as Promise<T | undefined>;
}

export async function idbGetAllByAccount<T>(store: StoreName, account: string): Promise<T[]> {
  const db = await openOfflineDb();
  return result(db.transaction(store, 'readonly').objectStore(store).index('account').getAll(account)) as Promise<T[]>;
}

export async function idbGetAll<T>(store: StoreName): Promise<T[]> {
  const db = await openOfflineDb();
  return result(db.transaction(store, 'readonly').objectStore(store).getAll()) as Promise<T[]>;
}

/** Writes and deletes in several stores at once. */
export async function idbWrite(ops: Array<{ store: StoreName; put?: unknown; del?: IDBValidKey }>): Promise<void> {
  if (ops.length === 0) return;
  const db = await openOfflineDb();
  const names = [...new Set(ops.map((op) => op.store))];
  const tx = db.transaction(names, 'readwrite');
  for (const op of ops) {
    const store = tx.objectStore(op.store);
    if (op.put !== undefined) store.put(op.put);
    else if (op.del !== undefined) store.delete(op.del);
  }
  await done(tx);
}

/**
 * Reads a record and writes what `change` makes of it in one transaction;
 * `change` returns undefined to leave it. True when it wrote.
 */
export async function idbUpdate<T>(store: StoreName, key: IDBValidKey, change: (value: T | undefined) => T | undefined): Promise<boolean> {
  const db = await openOfflineDb();
  const tx = db.transaction(store, 'readwrite');
  const objects = tx.objectStore(store);
  let wrote = false;
  const read = objects.get(key);
  read.onsuccess = () => {
    const next = change(read.result as T | undefined);
    if (next !== undefined) {
      objects.put(next);
      wrote = true;
    }
  };
  await done(tx);
  return wrote;
}

export async function idbAdd(store: StoreName, value: unknown): Promise<IDBValidKey> {
  const db = await openOfflineDb();
  const tx = db.transaction(store, 'readwrite');
  const key = result(tx.objectStore(store).add(value));
  await done(tx);
  return key;
}

/** Deletes every record of one account in the given stores. */
export async function idbDeleteAccount(account: string, stores: readonly StoreName[]): Promise<void> {
  const db = await openOfflineDb();
  const tx = db.transaction([...stores], 'readwrite');
  for (const name of stores) {
    const index = tx.objectStore(name).index('account');
    const request = index.openKeyCursor(IDBKeyRange.only(account));
    request.onsuccess = () => {
      const cursor = request.result;
      if (!cursor) return;
      tx.objectStore(name).delete(cursor.primaryKey);
      cursor.continue();
    };
  }
  await done(tx);
}

/** Deletes the whole database (sign-out, offline mode off everywhere). */
export async function deleteOfflineDb(): Promise<void> {
  if (!hasIndexedDb()) return;
  mayCreate = false;
  const open = dbPromise;
  dbPromise = null;
  try {
    (await open)?.close();
  } catch {
    /* it never opened */
  }
  await new Promise<void>((resolve) => {
    try {
      const request = indexedDB.deleteDatabase(OFFLINE_DB_NAME);
      request.onsuccess = () => resolve();
      request.onerror = () => resolve();
      request.onblocked = () => resolve();
    } catch {
      resolve();
    }
  });
}
