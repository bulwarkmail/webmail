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

function hasIdb(): boolean {
  try {
    return typeof indexedDB !== "undefined" && indexedDB !== null;
  } catch {
    return false;
  }
}

let dbPromise: Promise<IDBDatabase> | null = null;

function openDb(): Promise<IDBDatabase> {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, 1);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(STORE)) {
        db.createObjectStore(STORE, { keyPath: "key" }).createIndex("scope", "scope");
      }
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

function done<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

async function withStore<T>(mode: IDBTransactionMode, run: (store: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  const db = await openDb();
  return done(run(db.transaction(STORE, mode).objectStore(STORE)));
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
  if (!hasIdb()) return;
  try {
    const db = await openDb();
    const tx = db.transaction(STORE, "readwrite");
    const keys = await done(tx.objectStore(STORE).index("scope").getAllKeys(scope));
    const store = db.transaction(STORE, "readwrite").objectStore(STORE);
    await Promise.all(keys.map((k) => done(store.delete(k))));
  } catch {
    /* nothing stored */
  }
}

/** Removes every checkpoint (everyone signed out). */
export async function clearAllCheckpoints(): Promise<void> {
  memory.clear();
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
