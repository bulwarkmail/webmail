/**
 * Where an import stopped, per file, so a cancelled, crashed or paused import
 * of a large file continues instead of importing every message again
 * (Email/import doesn't skip duplicates). Kept in IndexedDB, keyed by the
 * Bulwark account, the target and the file's name, size and date; removed
 * when the import finishes, when the account signs out and on a full
 * sign-out. Falls back to memory where IndexedDB isn't available.
 */

export interface ImportCheckpoint {
  key: string;
  /** The Bulwark account that ran the import. */
  scope: string;
  fileName: string;
  /** Items done for good (imported or skipped) from the start of the file, without a gap. */
  done: number;
  /** Items done after the first gap (a message that failed and is tried again). */
  ahead?: number[];
  imported: number;
  updatedAt: number;
}

const DB_NAME = "bulwark-mail-import";
const STORE = "checkpoints";
/** What lib/mail-import/dedupe.ts remembers. Same database, so a sign-out takes it along. */
export const SEEN_STORE = "seen";
/** What an import from this computer needs to go on after a restart (the desktop app). One per account. */
const JOB_STORE = "jobs";
/** Older checkpoints are dropped: the file has likely changed or been forgotten. */
const MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;

export function checkpointKey(parts: {
  scope: string;
  accountId: string;
  target: string | null;
  keepFolders: boolean;
  file: { name: string; size: number; lastModified: number };
}): string {
  return [parts.scope, parts.accountId, parts.target ?? "", parts.keepFolders ? "1" : "0", parts.file.name, parts.file.size, parts.file.lastModified].join("\u0000");
}

const memory = new Map<string, ImportCheckpoint>();

/** The fallback where IndexedDB isn't available, by key, with the scope as the value. */
export const seenInMemory = new Map<string, string>();
const jobsInMemory = new Map<string, unknown>();

function forgetSeenInMemory(scope?: string): void {
  for (const [key, value] of seenInMemory) if (!scope || value === scope) seenInMemory.delete(key);
}

export function hasIdb(): boolean {
  try {
    return typeof indexedDB !== "undefined" && indexedDB !== null;
  } catch {
    return false;
  }
}

let dbPromise: Promise<IDBDatabase> | null = null;

export function openDb(): Promise<IDBDatabase> {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, 2);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(STORE)) {
        db.createObjectStore(STORE, { keyPath: "key" }).createIndex("scope", "scope");
      }
      if (!db.objectStoreNames.contains(SEEN_STORE)) {
        db.createObjectStore(SEEN_STORE, { keyPath: "key" }).createIndex("scope", "scope");
      }
      if (!db.objectStoreNames.contains(JOB_STORE)) db.createObjectStore(JOB_STORE, { keyPath: "key" });
    };
    request.onsuccess = () => {
      const db = request.result;
      // Another tab deleting the database (sign-out) must not wait on us.
      db.onversionchange = () => { db.close(); dbPromise = null; };
      resolve(db);
    };
    request.onerror = () => { dbPromise = null; reject(request.error); };
    request.onblocked = () => { dbPromise = null; reject(new Error("IndexedDB blocked")); };
  });
  return dbPromise;
}

export function done<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

async function withStore<T>(mode: IDBTransactionMode, run: (store: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  const db = await openDb();
  return done(run(db.transaction(STORE, mode).objectStore(STORE)));
}

/**
 * In IndexedDB rather than localStorage, which Chromium writes to disk late: an import
 * killed in its first minute would come back as if it had never started. One per Bulwark
 * account, so one account's import doesn't overwrite another's.
 */
export async function readStoredJob<T>(scope: string): Promise<T | null> {
  const inMemory = () => (jobsInMemory.get(scope) as T | undefined) ?? null;
  if (!hasIdb()) return inMemory();
  try {
    const db = await openDb();
    const found = (await done(db.transaction(JOB_STORE, "readonly").objectStore(JOB_STORE).get(scope))) as { value: T } | undefined;
    return found?.value ?? null;
  } catch {
    return inMemory();
  }
}

export async function writeStoredJob(scope: string, value: unknown): Promise<void> {
  if (value === null) jobsInMemory.delete(scope);
  else jobsInMemory.set(scope, value);
  if (!hasIdb()) return;
  try {
    const db = await openDb();
    const store = db.transaction(JOB_STORE, "readwrite").objectStore(JOB_STORE);
    if (value === null) await done(store.delete(scope));
    else await done(store.put({ key: scope, value }));
  } catch {
    /* kept in memory for this window */
  }
}

/** Every account's. */
export async function clearStoredJobs(): Promise<void> {
  jobsInMemory.clear();
  if (!hasIdb()) return;
  try {
    const db = await openDb();
    await done(db.transaction(JOB_STORE, "readwrite").objectStore(JOB_STORE).clear());
  } catch {
    /* nothing stored */
  }
}

export async function readCheckpoint(key: string, now = Date.now()): Promise<ImportCheckpoint | null> {
  let found: ImportCheckpoint | null;
  if (!hasIdb()) {
    found = memory.get(key) ?? null;
  } else {
    try {
      found = ((await withStore("readonly", (s) => s.get(key))) as ImportCheckpoint | undefined) ?? null;
    } catch {
      found = memory.get(key) ?? null;
    }
  }
  if (found && now - found.updatedAt > MAX_AGE_MS) {
    await deleteCheckpoint(key);
    return null;
  }
  return found;
}

export async function writeCheckpoint(checkpoint: ImportCheckpoint): Promise<void> {
  memory.set(checkpoint.key, checkpoint);
  if (!hasIdb()) return;
  try {
    await withStore("readwrite", (s) => s.put(checkpoint));
    memory.delete(checkpoint.key);
  } catch {
    /* kept in memory for this tab */
  }
}

export async function deleteCheckpoint(key: string): Promise<void> {
  memory.delete(key);
  if (!hasIdb()) return;
  try {
    await withStore("readwrite", (s) => s.delete(key));
  } catch {
    /* nothing stored */
  }
}

/** Removes the checkpoints of one Bulwark account (it signs out). */
export async function clearCheckpointsFor(scope: string): Promise<void> {
  for (const [key, value] of memory) if (value.scope === scope) memory.delete(key);
  forgetSeenInMemory(scope);
  if (!hasIdb()) return;
  try {
    const db = await openDb();
    for (const name of [STORE, SEEN_STORE]) {
      const tx = db.transaction(name, "readwrite");
      const keys = await done(tx.objectStore(name).index("scope").getAllKeys(scope));
      const store = db.transaction(name, "readwrite").objectStore(name);
      await Promise.all(keys.map((k) => done(store.delete(k))));
    }
  } catch {
    /* nothing stored */
  }
}

/** Removes every checkpoint (everyone signed out). */
export async function clearAllCheckpoints(): Promise<void> {
  memory.clear();
  jobsInMemory.clear();
  forgetSeenInMemory();
  if (!hasIdb()) return;
  const db = dbPromise ? await dbPromise.catch(() => null) : null;
  db?.close();
  dbPromise = null;
  await new Promise<void>((resolve) => {
    try {
      const request = indexedDB.deleteDatabase(DB_NAME);
      request.onsuccess = request.onerror = request.onblocked = () => resolve();
    } catch {
      resolve();
    }
  });
}
