/**
 * The per-account database keys, as the page sees them.
 *
 * Each account's database has a random 32-byte key. It is only ever stored
 * wrapped: AES-GCM with a non-extractable key that lives in IndexedDB, then
 * any extra layers on top (the desktop app's OS keychain, app lock). Forgetting
 * the record makes the file unreadable even if deleting it failed.
 */

/**
 * localStorage: accounts that have had a store here. Holds nothing but the
 * account's id, and it outlives what a browser may clear of the rest.
 */
export const STORE_OPENED_KEY = 'bulwark-store-opened';

const DB_NAME = 'bulwark-store';
const DB_VERSION = 1;
const KEYS = 'keys';
const ACCOUNTS = 'accounts';
const WRAP_ID = 'wrap';

export interface WrapLayer {
  /** A name for the layer: 'safeStorage', 'pin', 'prf'. */
  name: string;
  wrap(data: Uint8Array): Promise<Uint8Array>;
  unwrap(data: Uint8Array): Promise<Uint8Array>;
}

export interface AccountRecord {
  account: string;
  /** `/a<hex>.db`. */
  file: string;
  iv: Uint8Array;
  wrapped: Uint8Array;
  /** Layers applied after the WebCrypto wrap, innermost first. */
  layers: string[];
  createdAt: number;
}

function promisify<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

function openDb(): Promise<IDBDatabase> {
  const request = indexedDB.open(DB_NAME, DB_VERSION);
  request.onupgradeneeded = () => {
    const db = request.result;
    if (!db.objectStoreNames.contains(KEYS)) db.createObjectStore(KEYS, { keyPath: 'id' });
    if (!db.objectStoreNames.contains(ACCOUNTS)) db.createObjectStore(ACCOUNTS, { keyPath: 'account' });
  };
  return promisify(request);
}

async function withDb<T>(fn: (db: IDBDatabase) => Promise<T>): Promise<T> {
  const db = await openDb();
  try {
    return await fn(db);
  } finally {
    db.close();
  }
}

async function wrapKey(db: IDBDatabase): Promise<CryptoKey> {
  const read = db.transaction(KEYS, 'readonly').objectStore(KEYS).get(WRAP_ID);
  const existing = await promisify(read) as { key: CryptoKey } | undefined;
  if (existing) return existing.key;
  const key = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
  const tx = db.transaction(KEYS, 'readwrite');
  const store = tx.objectStore(KEYS);
  // Another tab may have got there first: keep theirs.
  const raced = await promisify(store.get(WRAP_ID)) as { key: CryptoKey } | undefined;
  if (raced) return raced.key;
  await promisify(store.put({ id: WRAP_ID, key }));
  return key;
}

function toHex(bytes: Uint8Array): string {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

function asBuffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}

export function newStoreFileName(): string {
  return `/a${toHex(crypto.getRandomValues(new Uint8Array(8)))}.db`;
}

/** The file of every account with a key. Any other file in the pool can't be read by anyone. */
export async function knownStoreFiles(): Promise<string[]> {
  return withDb(async (db) => {
    const records = await promisify(db.transaction(ACCOUNTS, 'readonly').objectStore(ACCOUNTS).getAll()) as AccountRecord[];
    return records.map((record) => record.file);
  });
}

export async function getAccountRecord(account: string): Promise<AccountRecord | null> {
  return withDb(async (db) => {
    const found = await promisify(db.transaction(ACCOUNTS, 'readonly').objectStore(ACCOUNTS).get(account)) as AccountRecord | undefined;
    return found ?? null;
  });
}

export async function listAccountRecords(): Promise<AccountRecord[]> {
  return withDb((db) => promisify(db.transaction(ACCOUNTS, 'readonly').objectStore(ACCOUNTS).getAll()) as Promise<AccountRecord[]>);
}

/** The account's key in hex, created on first use. Returns the record too, for the file name. */
export async function openAccountKey(account: string, layers: readonly WrapLayer[] = []): Promise<{ keyHex: string; record: AccountRecord; fresh: boolean }> {
  return withDb(async (db) => {
    const wrapping = await wrapKey(db);
    const found = await promisify(db.transaction(ACCOUNTS, 'readonly').objectStore(ACCOUNTS).get(account)) as AccountRecord | undefined;
    if (found) {
      let data = found.wrapped;
      for (const name of [...found.layers].reverse()) {
        const layer = layers.find((candidate) => candidate.name === name);
        if (!layer) throw new StoreKeyLayerMissingError(name);
        data = await layer.unwrap(data);
      }
      const raw = new Uint8Array(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: asBuffer(found.iv) }, wrapping, asBuffer(data)));
      const keyHex = toHex(raw);
      raw.fill(0);
      return { keyHex, record: found, fresh: false };
    }
    const raw = crypto.getRandomValues(new Uint8Array(32));
    const iv = crypto.getRandomValues(new Uint8Array(12));
    let wrapped = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, wrapping, raw));
    for (const layer of layers) wrapped = new Uint8Array(await layer.wrap(wrapped));
    const record: AccountRecord = {
      account,
      file: newStoreFileName(),
      iv,
      wrapped,
      layers: layers.map((layer) => layer.name),
      createdAt: Date.now(),
    };
    await promisify(db.transaction(ACCOUNTS, 'readwrite').objectStore(ACCOUNTS).put(record));
    const keyHex = toHex(raw);
    raw.fill(0);
    return { keyHex, record, fresh: true };
  });
}

/** Adds or removes wrap layers without touching the database key. */
export async function rewrapAccountKey(
  account: string,
  from: readonly WrapLayer[],
  to: readonly WrapLayer[],
): Promise<void> {
  await withDb(async (db) => {
    const found = await promisify(db.transaction(ACCOUNTS, 'readonly').objectStore(ACCOUNTS).get(account)) as AccountRecord | undefined;
    if (!found) return;
    let data = found.wrapped;
    for (const name of [...found.layers].reverse()) {
      const layer = from.find((candidate) => candidate.name === name);
      if (!layer) throw new StoreKeyLayerMissingError(name);
      data = await layer.unwrap(data);
    }
    for (const layer of to) data = new Uint8Array(await layer.wrap(data));
    const record: AccountRecord = { ...found, wrapped: data, layers: to.map((layer) => layer.name) };
    await promisify(db.transaction(ACCOUNTS, 'readwrite').objectStore(ACCOUNTS).put(record));
  });
}

/** Forgets the account's key. The database file can't be read after this. */
export async function forgetAccountKey(account: string): Promise<void> {
  await withDb((db) => promisify(db.transaction(ACCOUNTS, 'readwrite').objectStore(ACCOUNTS).delete(account)).then(() => undefined));
}

/**
 * This browser profile's row at the instance, for one account: its id, and the
 * secret that lets a device answer for that row without a session. In this
 * database and nowhere else, because a start has to read it before any store
 * opens, and a copy in the store could never outlive the key that opens it. A
 * cleared database means a new device at the next registration.
 */
export interface DeviceRecord {
  account: string;
  id: string;
  secret: string;
  createdAt: number;
}

const DEVICE_RECORD_PREFIX = 'device:';
// ':' + 1, so the range holds exactly the prefixed keys.
const DEVICE_RECORD_END = 'device;';

export async function getDeviceRecord(account: string): Promise<DeviceRecord | null> {
  return withDb(async (db) => {
    const found = await promisify(db.transaction(KEYS, 'readonly').objectStore(KEYS).get(DEVICE_RECORD_PREFIX + account)) as { record: DeviceRecord } | undefined;
    return found?.record ?? null;
  });
}

export async function putDeviceRecord(record: DeviceRecord): Promise<void> {
  await withDb((db) => promisify(db.transaction(KEYS, 'readwrite').objectStore(KEYS).put({ id: DEVICE_RECORD_PREFIX + record.account, record })).then(() => undefined));
}

export async function deleteDeviceRecord(account: string): Promise<void> {
  if (!(await keyDatabaseExists())) return;
  await withDb((db) => promisify(db.transaction(KEYS, 'readwrite').objectStore(KEYS).delete(DEVICE_RECORD_PREFIX + account)).then(() => undefined));
}

/** Opening the database makes it, so a browser that can say it isn't there doesn't open it. */
async function keyDatabaseExists(): Promise<boolean> {
  if (typeof indexedDB.databases !== 'function') return true;
  return (await indexedDB.databases()).some((database) => database.name === DB_NAME);
}

export async function listDeviceRecords(onlyIfThere = true): Promise<DeviceRecord[]> {
  if (onlyIfThere && !(await keyDatabaseExists())) return [];
  return withDb(async (db) => {
    const range = IDBKeyRange.bound(DEVICE_RECORD_PREFIX, DEVICE_RECORD_END, false, true);
    const rows = await promisify(db.transaction(KEYS, 'readonly').objectStore(KEYS).getAll(range)) as Array<{ record: DeviceRecord }>;
    return rows.map((row) => row.record);
  });
}

export class StoreKeyLayerMissingError extends Error {
  constructor(readonly layer: string) {
    super(`The key needs the ${layer} layer`);
    this.name = 'StoreKeyLayerMissingError';
  }
}

/** Deletes every key at sign-out. Works with no worker running, on any page. */
export function deleteKeyDatabase(): void {
  try {
    indexedDB.deleteDatabase(DB_NAME);
  } catch {
    // Private mode or similar: nothing was stored either.
  }
}
