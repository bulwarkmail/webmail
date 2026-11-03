/**
 * What app lock keeps on disk, in its own IndexedDB database: the lock key wrapped
 * under the PIN and the other ways in, the count of wrong PINs, and drafts sealed
 * on their way to the lock screen.
 *
 * The count is written before a PIN is checked, so reloading during the check or
 * after a wrong one gains nothing. This slows guessing through the app. Someone
 * with the disk can skip it, and then only the PIN's length and PBKDF2 stand in the
 * way, which is why a PIN has a minimum length, letters are allowed and the obvious
 * ones are refused.
 *
 * In the desktop app the PIN's wrap goes through main's safeStorage as well, so a copy of
 * the disk can't be guessed at without this user's OS login. A browser has nothing like
 * that, and the settings page says so. A shell whose storage only obfuscates (Linux with
 * no secret service) says no, and the wrap stays as it is.
 */

import { VAULT_DB } from './state';
import { getDesktopBridge } from '@/lib/desktop/bridge';
import { sealFor, createSessionOpener, type SealedAnswer } from '@/lib/popout/sealed';
import { keyFromPin, keyFromPrf, ObviousPinError, open, PBKDF2_ITERATIONS, pinIsObvious, randomBytes, seal, type WrappedBytes } from './crypto';

export { VAULT_DB };
const DB_VERSION = 1;
const RECORDS = 'records';
const SEALED = 'sealed';
const VAULT_ID = 'vault';
const ATTEMPTS_ID = 'attempts';

export interface PinWrap extends WrappedBytes {
  salt: Uint8Array;
  iterations: number;
  /** `data` is wrapped once more by the desktop app's main process. */
  shell?: true;
}

export interface PrfWrap extends WrappedBytes {
  credentialId: Uint8Array;
  /** What the authenticator's PRF is asked about. */
  salt: Uint8Array;
}

export interface VaultRecord {
  id: typeof VAULT_ID;
  pin: PinWrap;
  prf?: PrfWrap;
  /** For sealing drafts in tabs with no key: anyone may seal, only the lock key opens. */
  sealing: { publicKey: JsonWebKey; privateKey: WrappedBytes };
}

export interface AttemptsRecord {
  id: typeof ATTEMPTS_ID;
  failures: number;
  blockedUntil: number;
}

function promisify<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

function done(tx: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onabort = () => reject(tx.error);
    tx.onerror = () => reject(tx.error);
  });
}

function openDb(): Promise<IDBDatabase> {
  const request = indexedDB.open(VAULT_DB, DB_VERSION);
  request.onupgradeneeded = () => {
    const db = request.result;
    if (!db.objectStoreNames.contains(RECORDS)) db.createObjectStore(RECORDS, { keyPath: 'id' });
    if (!db.objectStoreNames.contains(SEALED)) db.createObjectStore(SEALED, { keyPath: 'id', autoIncrement: true });
  };
  return promisify(request);
}

async function withDb<T>(run: (db: IDBDatabase) => Promise<T>): Promise<T> {
  const db = await openDb();
  try {
    return await run(db);
  } finally {
    db.close();
  }
}

async function readRecord<T>(id: string): Promise<T | null> {
  return withDb(async (db) => (await promisify(db.transaction(RECORDS, 'readonly').objectStore(RECORDS).get(id)) as T | undefined) ?? null);
}

async function writeRecord(record: VaultRecord | AttemptsRecord): Promise<void> {
  await withDb(async (db) => {
    const tx = db.transaction(RECORDS, 'readwrite');
    tx.objectStore(RECORDS).put(record);
    await done(tx);
  });
}

export function readVault(): Promise<VaultRecord | null> {
  return readRecord<VaultRecord>(VAULT_ID);
}

/** Without creating the database by looking. A vault means the lock is on, whatever else says. */
export async function vaultExists(): Promise<boolean> {
  if (typeof indexedDB === 'undefined') return false;
  try {
    if (typeof indexedDB.databases === 'function' && !(await indexedDB.databases()).some((db) => db.name === VAULT_DB)) return false;
    return (await readVault()) !== null;
  } catch {
    return false;
  }
}

/** A vault holds the lock key the store's keys depend on: a new one would lock them out for good. */
export class VaultExistsError extends Error {
  constructor() {
    super('There is a vault already');
    this.name = 'VaultExistsError';
  }
}

/** Main didn't open the PIN's wrap: another user, or a copied profile. Says nothing about the PIN. */
export class VaultShellError extends Error {
  constructor() {
    super('The desktop app could not open the PIN record');
    this.name = 'VaultShellError';
  }
}

async function throughShell(data: Uint8Array): Promise<{ data: Uint8Array; shell?: true }> {
  const member = getDesktopBridge()?.appLock;
  if (!member?.wrap) return { data };
  const status = await member.status().catch(() => null);
  if (!status?.wrap) return { data };
  const wrapped = await member.wrap(data).catch(() => null);
  return wrapped ? { data: wrapped, shell: true } : { data };
}

async function outOfShell(pin: PinWrap): Promise<Uint8Array> {
  if (!pin.shell) return pin.data;
  const data = await getDesktopBridge()?.appLock?.unwrap?.(pin.data).catch(() => null);
  if (!data) throw new VaultShellError();
  return data;
}

async function pinWrapOf(pin: string, raw: Uint8Array): Promise<PinWrap> {
  const salt = randomBytes(32);
  const key = await keyFromPin(pin, salt, PBKDF2_ITERATIONS);
  const sealed = await seal(key, raw);
  return { salt, iterations: PBKDF2_ITERATIONS, iv: sealed.iv, ...(await throughShell(sealed.data)) };
}

/** A new lock key under this PIN. The caller holds the bytes only long enough to use them. */
export async function createVault(pin: string): Promise<Uint8Array> {
  if (pinIsObvious(pin)) throw new ObviousPinError();
  if (await vaultExists()) throw new VaultExistsError();
  const raw = randomBytes(32);
  const lockKey = await crypto.subtle.importKey('raw', raw.slice().buffer as ArrayBuffer, 'AES-GCM', false, ['encrypt']);
  const pair = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveKey']);
  const privateJwk = new TextEncoder().encode(JSON.stringify(await crypto.subtle.exportKey('jwk', pair.privateKey)));
  const record: VaultRecord = {
    id: VAULT_ID,
    pin: await pinWrapOf(pin, raw),
    sealing: {
      publicKey: await crypto.subtle.exportKey('jwk', pair.publicKey),
      privateKey: await seal(lockKey, privateJwk),
    },
  };
  await writeRecord(record);
  await writeRecord({ id: ATTEMPTS_ID, failures: 0, blockedUntil: 0 });
  return raw;
}

/** Wrong PINs that cost nothing. A typo or two shouldn't make anyone wait. */
export const FREE_FAILURES = 4;
const FIRST_WAIT_MS = 30_000;
/** A long wait, and no wipe: forgetting a PIN must not be the way mail gets deleted. */
export const LONGEST_WAIT_MS = 60 * 60_000;

/** How long after this many wrong tries the next is allowed. */
export function waitAfter(failures: number): number {
  if (failures <= FREE_FAILURES) return 0;
  return Math.min(FIRST_WAIT_MS * 2 ** (failures - FREE_FAILURES - 1), LONGEST_WAIT_MS);
}

export class PinBlockedError extends Error {
  constructor(readonly until: number) {
    super('Too many wrong PINs');
    this.name = 'PinBlockedError';
  }
}

export class WrongPinError extends Error {
  constructor() {
    super('Wrong PIN');
    this.name = 'WrongPinError';
  }
}

export async function pinBlockedUntil(now = Date.now()): Promise<number> {
  const attempts = await readRecord<AttemptsRecord>(ATTEMPTS_ID);
  return attempts && attempts.blockedUntil > now ? attempts.blockedUntil : 0;
}

/** The lock key's bytes for the right PIN. Counts first, checks after. */
export async function openVaultWithPin(pin: string, now = Date.now()): Promise<Uint8Array> {
  const vault = await readVault();
  if (!vault) throw new WrongPinError();
  const attempts = (await readRecord<AttemptsRecord>(ATTEMPTS_ID)) ?? { id: ATTEMPTS_ID, failures: 0, blockedUntil: 0 };
  if (attempts.blockedUntil > now) throw new PinBlockedError(attempts.blockedUntil);
  // Before the count: main saying no costs nobody a try.
  const data = await outOfShell(vault.pin);
  const failures = attempts.failures + 1;
  await writeRecord({ id: ATTEMPTS_ID, failures, blockedUntil: now + waitAfter(failures) });
  try {
    const key = await keyFromPin(pin, vault.pin.salt, vault.pin.iterations);
    const raw = await open(key, { iv: vault.pin.iv, data });
    await writeRecord({ id: ATTEMPTS_ID, failures: 0, blockedUntil: 0 });
    return raw;
  } catch {
    throw new WrongPinError();
  }
}

/** Only ever the PIN's own wrap: the lock key and everything under it stay. */
export async function changeVaultPin(currentPin: string, newPin: string): Promise<void> {
  if (pinIsObvious(newPin)) throw new ObviousPinError();
  const raw = await openVaultWithPin(currentPin);
  try {
    const vault = await readVault();
    if (!vault) throw new WrongPinError();
    await writeRecord({ ...vault, pin: await pinWrapOf(newPin, raw) });
  } finally {
    raw.fill(0);
  }
}

/** The passkey's way in. `prfOutput` is what the authenticator gave for `salt`. */
export async function addVaultPrf(raw: Uint8Array, credentialId: Uint8Array, salt: Uint8Array, prfOutput: ArrayBuffer | Uint8Array): Promise<void> {
  const vault = await readVault();
  if (!vault) throw new Error('The app lock is not set up');
  await writeRecord({ ...vault, prf: { credentialId, salt, ...(await seal(await keyFromPrf(prfOutput), raw)) } });
}

export async function removeVaultPrf(): Promise<void> {
  const vault = await readVault();
  if (!vault?.prf) return;
  const { prf: _gone, ...rest } = vault;
  await writeRecord(rest);
}

export async function openVaultWithPrf(prfOutput: ArrayBuffer | Uint8Array): Promise<Uint8Array> {
  const vault = await readVault();
  if (!vault?.prf) throw new WrongPinError();
  return open(await keyFromPrf(prfOutput), vault.prf);
}

/** Deleted at sign-out and when the lock goes off. The store's keys can't depend on it then. */
export async function deleteVault(): Promise<void> {
  await new Promise<void>((resolve) => {
    try {
      const request = indexedDB.deleteDatabase(VAULT_DB);
      request.onsuccess = () => resolve();
      request.onerror = () => resolve();
      request.onblocked = () => resolve();
    } catch {
      resolve();
    }
  });
}

// ---- Drafts a locking window couldn't save ----

interface SealedRow {
  id?: number;
  sealed: SealedAnswer;
  /** The localStorage key this came out of. No key: a draft. */
  local?: string;
}

function sealedRows(): Promise<SealedRow[]> {
  return withDb((db) => promisify(db.transaction(SEALED, 'readonly').objectStore(SEALED).getAll())) as Promise<SealedRow[]>;
}

async function deleteSealedRows(rows: SealedRow[]): Promise<void> {
  if (rows.length === 0) return;
  await withDb(async (db) => {
    const tx = db.transaction(SEALED, 'readwrite');
    for (const row of rows) tx.objectStore(SEALED).delete(row.id!);
    await done(tx);
  });
}

async function openerFor(lockKey: CryptoKey, vault: VaultRecord) {
  const jwk = JSON.parse(new TextDecoder().decode(await open(lockKey, vault.sealing.privateKey))) as JsonWebKey;
  return createSessionOpener(jwk);
}

/** Works in any tab, with no key: the public half is enough to seal. */
export async function sealDraft(state: unknown): Promise<boolean> {
  const vault = await readVault();
  if (!vault) return false;
  const sealed = await sealFor(vault.sealing.publicKey, state);
  await withDb(async (db) => {
    const tx = db.transaction(SEALED, 'readwrite');
    tx.objectStore(SEALED).add({ sealed } satisfies SealedRow);
    await done(tx);
  });
  return true;
}

/** Only with the lock key's bytes. Takes the drafts off the list. */
export async function openSealedDrafts(lockKey: CryptoKey): Promise<unknown[]> {
  const vault = await readVault();
  if (!vault) return [];
  const rows = (await sealedRows()).filter((row) => !row.local);
  if (rows.length === 0) return [];
  const opener = await openerFor(lockKey, vault);
  const out: unknown[] = [];
  for (const row of rows) {
    try {
      out.push(await opener.open(row.sealed));
    } catch {
      // Sealed under an older key: nothing can read it, and it must not block the rest.
    }
  }
  await deleteSealedRows(rows);
  return out;
}

// ---- Stores that name people, taken out of plain storage while locked ----

/** Only the newest copy of a key stays. False with no vault to seal for. */
export async function sealLocal(key: string, value: string): Promise<boolean> {
  const vault = await readVault();
  if (!vault) return false;
  const sealed = await sealFor(vault.sealing.publicKey, value);
  const older = (await sealedRows()).filter((row) => row.local === key);
  await deleteSealedRows(older);
  await withDb(async (db) => {
    const tx = db.transaction(SEALED, 'readwrite');
    tx.objectStore(SEALED).add({ sealed, local: key } satisfies SealedRow);
    await done(tx);
  });
  return true;
}

/** With the lock key. What's opened comes off the list: the caller puts it back in storage. */
export async function openSealedLocal(lockKey: CryptoKey): Promise<Array<[string, string]>> {
  const vault = await readVault();
  if (!vault) return [];
  const rows = (await sealedRows()).filter((row) => row.local);
  if (rows.length === 0) return [];
  const opener = await openerFor(lockKey, vault);
  const out: Array<[string, string]> = [];
  for (const row of rows) {
    try {
      out.push([row.local!, await opener.open(row.sealed) as string]);
    } catch {
      // As with a draft above.
    }
  }
  await deleteSealedRows(rows);
  return out;
}

export async function countSealed(): Promise<number> {
  if (!(await vaultExists())) return 0;
  return (await sealedRows()).length;
}

/** A wipe: sealed text can't be told apart by account, and a device told to remove it keeps none. */
export async function clearSealed(): Promise<void> {
  if (!(await vaultExists())) return;
  await withDb(async (db) => {
    const tx = db.transaction(SEALED, 'readwrite');
    tx.objectStore(SEALED).clear();
    await done(tx);
  });
}
