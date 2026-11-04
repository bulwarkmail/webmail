/**
 * The per-account database keys, as the page sees them.
 *
 * Each account's database has a random 32-byte key. It is only ever stored
 * wrapped: AES-GCM with a non-extractable key that lives in IndexedDB, then
 * any extra layers on top (the desktop app's OS keychain, app lock).
 *
 * That first key is non-extractable for script only: the browser keeps its bytes
 * in plain form in its IndexedDB files, next to the record. So in a browser with no
 * app lock, someone with a copy of those files can open the database. And a record
 * deleted or overwritten here stays in those files until the browser compacts them.
 * So forgetting a record stops the app, and script, from using the key. It doesn't
 * make a file on disk safe from a copy of the disk: deleting the file does that. And
 * more layers on a record only count for a key that never sat there with fewer,
 * which is why those ask for a new key and file (`rekey`).
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
  /** An older copy of this record, with fewer layers, may still be on disk: the key has to change. */
  rekey?: true;
  /** The file from before a new key, until it's known to be deleted. */
  leftover?: string;
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

export async function listAccountRecords(onlyIfThere = false): Promise<AccountRecord[]> {
  if (onlyIfThere && !(await keyDatabaseExists())) return [];
  return withDb((db) => promisify(db.transaction(ACCOUNTS, 'readonly').objectStore(ACCOUNTS).getAll()) as Promise<AccountRecord[]>);
}

function sameLayers(names: readonly string[], layers: readonly WrapLayer[]): boolean {
  return names.length === layers.length && layers.every((layer, index) => layer.name === names[index]);
}

function hasMore(from: readonly string[], to: readonly string[]): boolean {
  return to.some((name) => !from.includes(name));
}

/**
 * The account's key in hex, created on first use. Returns the record too, for the file name.
 * A record with other layers than these gets these. `wrapFailed`: it couldn't, the OS refused,
 * and the key comes anyway since what's stored is no worse than it was. The caller says so.
 */
export async function openAccountKey(account: string, layers: readonly WrapLayer[] = []): Promise<{ keyHex: string; record: AccountRecord; fresh: boolean; wrapFailed?: boolean }> {
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
      if (sameLayers(found.layers, layers)) return { keyHex, record: found, fresh: false };
      let rewrapped = data;
      try {
        for (const layer of layers) rewrapped = new Uint8Array(await layer.wrap(rewrapped));
      } catch {
        return { keyHex, record: found, fresh: false, wrapFailed: true };
      }
      const names = layers.map((layer) => layer.name);
      const record: AccountRecord = { ...found, wrapped: rewrapped, layers: names, ...(found.rekey || hasMore(found.layers, names) ? { rekey: true as const } : {}) };
      await promisify(db.transaction(ACCOUNTS, 'readwrite').objectStore(ACCOUNTS).put(record));
      return { keyHex, record, fresh: false };
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

/**
 * Adds or removes wrap layers without touching the database key. More layers than before ask for
 * a new key (`rekey`), and so does the caller who knows better, for a lock key that changed.
 */
export async function rewrapAccountKey(
  account: string,
  from: readonly WrapLayer[],
  to: readonly WrapLayer[],
  options: { rekey?: boolean } = {},
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
    const names = to.map((layer) => layer.name);
    const { rekey: _before, ...rest } = found;
    const record: AccountRecord = {
      ...rest,
      wrapped: data,
      layers: names,
      ...(options.rekey || found.rekey || hasMore(found.layers, names) ? { rekey: true as const } : {}),
    };
    await promisify(db.transaction(ACCOUNTS, 'readwrite').objectStore(ACCOUNTS).put(record));
  });
}

/** A new random key for a re-encryption, in hex, and a file for it. */
export function newStoreKey(): { keyHex: string; file: string } {
  const raw = crypto.getRandomValues(new Uint8Array(32));
  const keyHex = toHex(raw);
  raw.fill(0);
  return { keyHex, file: newStoreFileName() };
}

/** The account's data is whole under this key in this file now. One write, so a crash leaves one or the other. */
export async function replaceAccountKey(account: string, keyHex: string, file: string, layers: readonly WrapLayer[] = []): Promise<void> {
  await withDb(async (db) => {
    const wrapping = await wrapKey(db);
    const found = await promisify(db.transaction(ACCOUNTS, 'readonly').objectStore(ACCOUNTS).get(account)) as AccountRecord | undefined;
    if (!found) return;
    const raw = Uint8Array.from(keyHex.match(/../g)!.map((pair) => parseInt(pair, 16)));
    const iv = crypto.getRandomValues(new Uint8Array(12));
    let wrapped = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, wrapping, raw));
    raw.fill(0);
    for (const layer of layers) wrapped = new Uint8Array(await layer.wrap(wrapped));
    const { rekey: _done, ...rest } = found;
    const record: AccountRecord = { ...rest, file, iv, wrapped, layers: layers.map((layer) => layer.name), leftover: found.file };
    await promisify(db.transaction(ACCOUNTS, 'readwrite').objectStore(ACCOUNTS).put(record));
  });
}

/** The old file is gone. */
export async function clearLeftover(account: string): Promise<void> {
  await withDb(async (db) => {
    const found = await promisify(db.transaction(ACCOUNTS, 'readonly').objectStore(ACCOUNTS).get(account)) as AccountRecord | undefined;
    if (!found?.leftover) return;
    const { leftover: _gone, ...rest } = found;
    await promisify(db.transaction(ACCOUNTS, 'readwrite').objectStore(ACCOUNTS).put(rest));
  });
}

/** Forgets the account's key. The app can't read the database file after this. */
export async function forgetAccountKey(account: string): Promise<void> {
  await withDb((db) => promisify(db.transaction(ACCOUNTS, 'readwrite').objectStore(ACCOUNTS).delete(account)).then(() => undefined));
}

/**
 * This browser profile's row at the instance, for one account: its id, and the
 * secret that lets a device answer for that row without a session. In this
 * database and nowhere else, because a start has to read it before any store
 * opens, and a copy in the store could never outlive the key that opens it. A
 * cleared database means a new device at the next registration.
 *
 * Not sealed. Sealing it with the wrap key would change nothing, since that sits beside
 * it, and a device at the lock screen still has to hear a wipe. So someone with a copy of
 * these files can act as this row at the instance: read whether a wipe waits, and report one
 * as done. It reaches no mail. An admin's "wiped" means the device said so.
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
export function deleteKeyDatabase(): Promise<void> {
  return new Promise((resolve) => {
    try {
      const request = indexedDB.deleteDatabase(DB_NAME);
      request.onsuccess = () => resolve();
      request.onerror = () => resolve();
      // A connection still open goes on its own: withDb closes after each use.
      request.onblocked = () => resolve();
    } catch {
      // Private mode or similar: nothing was stored either.
      resolve();
    }
  });
}
