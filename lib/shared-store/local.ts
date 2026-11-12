import { randomBytes } from 'node:crypto';
import { existsSync } from 'node:fs';
import { appendFile, mkdir, open, readFile, readdir, rename, stat, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { assertDocId, assertKey, assertName, toBuffer, versionOf } from './keys';
import { StoreUnavailableError } from './types';
import type {
  AppendLog,
  CollectionOptions,
  CounterLimit,
  CounterStore,
  DocCollection,
  EpochStore,
  KvSetOptions,
  KvStore,
  LeaseStore,
  LogOptions,
  PutOptions,
  PutResult,
  ReplicaInfo,
  ReplicaRegistry,
  ReserveResult,
  SharedStore,
  StoredDoc,
} from './types';

/**
 * The default store: one process, today's behaviour. Short-lived values and
 * counters live in memory, documents in the files their collection names,
 * written through a temp file and a rename. Everything that must be shared
 * by the module copies Next makes of this file (proxy, instrumentation,
 * routes) sits on globalThis.
 */

interface LocalState {
  kv: Map<string, { value: string; expiresAt: number }>;
  kvSets: number;
  /** No kv entry expires before this (a lower bound), so a full map needn't be scanned before then. */
  kvNextExpiry: number;
  counters: Map<string, { count: number; resetAt: number }>;
  /** The same for counters. */
  counterNextExpiry: number;
  queues: Map<string, Promise<unknown>>;
  pruned: Map<string, number>;
  leases: Map<string, { holder: string; expiresAt: number }>;
  epochs: Map<string, number>;
  replicas: Map<string, ReplicaInfo>;
}

const STATE_KEY = Symbol.for('bulwark.sharedStore.local');
/**
 * At most this many counters and kv entries are held. Expired ones are
 * dropped to make room; a live one never is, so a flood of new keys can't
 * make the store forget a limit that was reached (the admin sign-in ceiling
 * across all clients, say). With no room left, a new counter is refused,
 * which its caller reads as "limit reached", and a new kv entry fails with
 * StoreUnavailableError, which callers already treat as "can't be done right
 * now". Both make room again as entries expire.
 */
const MAX_COUNTERS = 50_000;
const MAX_KV_ENTRIES = 50_000;

function state(): LocalState {
  const g = globalThis as typeof globalThis & { [STATE_KEY]?: LocalState };
  if (!g[STATE_KEY]) {
    g[STATE_KEY] = {
      kv: new Map(),
      kvSets: 0,
      kvNextExpiry: Infinity,
      counters: new Map(),
      counterNextExpiry: Infinity,
      queues: new Map(),
      pruned: new Map(),
      leases: new Map(),
      epochs: new Map(),
      replicas: new Map(),
    };
  }
  return g[STATE_KEY];
}

/** Run tasks for one key one after another, across every module copy in this process. */
export function serializeLocal<T>(key: string, task: () => Promise<T>): Promise<T> {
  const queues = state().queues;
  const run = (queues.get(key) ?? Promise.resolve()).then(task, task);
  const tail = run.catch(() => {});
  queues.set(key, tail);
  void tail.then(() => {
    if (queues.get(key) === tail) queues.delete(key);
  });
  return run;
}

function isMissing(error: unknown): boolean {
  return (error as NodeJS.ErrnoException)?.code === 'ENOENT';
}

// ─── kv ────────────────────────────────────────────────────────────────────

function kvLive(key: string, now = Date.now()): { value: string; expiresAt: number } | null {
  const entry = state().kv.get(key);
  if (!entry) return null;
  if (entry.expiresAt <= now) {
    state().kv.delete(key);
    return null;
  }
  return entry;
}

/** Drop the expired kv entries; returns the earliest expiry left. */
function kvDropExpired(now: number): number {
  let next = Infinity;
  for (const [key, entry] of state().kv) {
    if (entry.expiresAt <= now) state().kv.delete(key);
    else if (entry.expiresAt < next) next = entry.expiresAt;
  }
  return next;
}

function kvSweep(): void {
  const s = state();
  if (++s.kvSets % 1000 !== 0) return;
  s.kvNextExpiry = kvDropExpired(Date.now());
}

function kvWrite(key: string, value: string, ttlMs: number | undefined): void {
  const s = state();
  const now = Date.now();
  if (!s.kv.has(key) && s.kv.size >= MAX_KV_ENTRIES) {
    if (now >= s.kvNextExpiry) s.kvNextExpiry = kvDropExpired(now);
    if (s.kv.size >= MAX_KV_ENTRIES) throw new StoreUnavailableError('The local store is full');
  }
  const expiresAt = ttlMs && ttlMs > 0 ? now + ttlMs : Infinity;
  s.kv.set(key, { value, expiresAt });
  if (expiresAt < s.kvNextExpiry) s.kvNextExpiry = expiresAt;
  kvSweep();
}

const kv: KvStore = {
  async get(key) {
    assertKey(key);
    return kvLive(key)?.value ?? null;
  },
  async set(key, value, options: KvSetOptions = {}) {
    assertKey(key);
    if (options.ifAbsent && kvLive(key)) return false;
    kvWrite(key, value, options.ttlMs);
    return true;
  },
  async del(key) {
    assertKey(key);
    state().kv.delete(key);
  },
  async take(key) {
    assertKey(key);
    const entry = kvLive(key);
    if (!entry) return null;
    state().kv.delete(key);
    return entry.value;
  },
  async update(key, fn, options = {}) {
    assertKey(key);
    // One thread, and fn is synchronous: nothing can interleave here.
    const entry = kvLive(key);
    const next = fn(entry?.value ?? null);
    if (next === undefined) return undefined;
    if (next === null) state().kv.delete(key);
    else kvWrite(key, next, options.ttlMs ?? (entry && entry.expiresAt !== Infinity ? entry.expiresAt - Date.now() : undefined));
    return next;
  },
};

// ─── counters ──────────────────────────────────────────────────────────────

function counterLive(key: string, now: number): { count: number; resetAt: number } | null {
  const entry = state().counters.get(key);
  if (!entry || entry.resetAt <= now) return null;
  return entry;
}

/**
 * Whether `newKeys` more counters fit, after dropping expired ones. Live
 * counters are never dropped (see MAX_COUNTERS).
 */
function counterRoom(newKeys: number, now: number): boolean {
  const s = state();
  if (s.counters.size + newKeys <= MAX_COUNTERS) return true;
  // Nothing has expired yet: skip the scan, so a full store costs nothing per request.
  if (now < s.counterNextExpiry) return false;
  let next = Infinity;
  for (const [key, entry] of s.counters) {
    if (entry.resetAt <= now) s.counters.delete(key);
    else if (entry.resetAt < next) next = entry.resetAt;
  }
  s.counterNextExpiry = next;
  return s.counters.size + newKeys <= MAX_COUNTERS;
}

function counterSet(key: string, entry: { count: number; resetAt: number }): void {
  const s = state();
  s.counters.set(key, entry);
  if (entry.resetAt < s.counterNextExpiry) s.counterNextExpiry = entry.resetAt;
}

/** A counter the store had no room for: more than any limit, never stored. */
const NO_ROOM = Number.MAX_SAFE_INTEGER;

const counters: CounterStore = {
  async reserve(limits: CounterLimit[], now = Date.now()): Promise<ReserveResult> {
    const current = limits.map((limit) => {
      assertKey(limit.key);
      return counterLive(limit.key, now);
    });
    let retryAfterMs = 0;
    let ok = true;
    limits.forEach((limit, i) => {
      const entry = current[i];
      if (entry && entry.count >= limit.max) {
        ok = false;
        retryAfterMs = Math.max(retryAfterMs, entry.resetAt - now);
      }
    });
    const refused = () => ({ ok: false, retryAfterMs, counts: current.map((e) => e?.count ?? 0), resetAts: current.map((e) => e?.resetAt ?? 0) });
    if (!ok) return refused();
    const newKeys = new Set(limits.map((limit) => limit.key).filter((key) => !state().counters.has(key))).size;
    if (newKeys > 0 && !counterRoom(newKeys, now)) {
      retryAfterMs = Math.max(1, state().counterNextExpiry - now);
      return refused();
    }
    const after = limits.map((limit, i) => {
      const entry = current[i] ?? { count: 0, resetAt: now + limit.windowMs };
      entry.count++;
      counterSet(limit.key, entry);
      return entry;
    });
    return { ok, retryAfterMs: 0, counts: after.map((e) => e.count), resetAts: after.map((e) => e.resetAt) };
  },
  async refund(entries, now = Date.now()) {
    for (const { key, resetAt } of entries) {
      assertKey(key);
      const entry = counterLive(key, now);
      if (!entry) continue;
      if (resetAt !== undefined && entry.resetAt !== resetAt) continue;
      entry.count = Math.max(0, entry.count - 1);
    }
  },
  async hit(key, windowMs, now = Date.now()) {
    assertKey(key);
    if (!state().counters.has(key) && !counterRoom(1, now)) return { count: NO_ROOM, resetAt: now + windowMs };
    const entry = counterLive(key, now) ?? { count: 0, resetAt: now + windowMs };
    entry.count++;
    counterSet(key, entry);
    return { count: entry.count, resetAt: entry.resetAt };
  },
  async get(key, now = Date.now()) {
    assertKey(key);
    const entry = counterLive(key, now);
    return entry ? { count: entry.count, resetAt: entry.resetAt } : null;
  },
  async reset(key) {
    assertKey(key);
    state().counters.delete(key);
  },
};

// ─── documents ─────────────────────────────────────────────────────────────

/** Files of a collection on disk, as today. Also used by the shared store for read-only config and the import. */
export function localCollection(name: string, options: CollectionOptions): DocCollection {
  assertName(name);
  const layout = options.local;

  function fileFor(id: string): string {
    assertDocId(id);
    const dir = path.resolve(layout.dir());
    const file = path.resolve(dir, layout.file ? layout.file(id) : id);
    if (!file.startsWith(dir + path.sep)) throw new Error(`Invalid path for ${name}/${id}`);
    return file;
  }

  async function readCurrent(file: string): Promise<StoredDoc | null> {
    let data: Buffer;
    try {
      if (options.ttlMs) {
        const info = await stat(file);
        if (info.mtimeMs + options.ttlMs <= Date.now()) {
          await unlink(file).catch(() => {});
          return null;
        }
      }
      data = await readFile(file);
    } catch (error) {
      if (isMissing(error)) return null;
      throw error;
    }
    return { data, version: versionOf(data) };
  }

  async function writeCurrent(file: string, data: Buffer): Promise<void> {
    await mkdir(path.dirname(file), { recursive: true });
    const tmp = layout.tmpName ? layout.tmpName(file) : `${file}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`;
    if (layout.fsync) {
      const handle = await open(tmp, 'wx', layout.mode ?? 0o666);
      try {
        await handle.writeFile(data);
        await handle.sync();
      } catch (error) {
        await handle.close().catch(() => {});
        await unlink(tmp).catch(() => {});
        throw error;
      }
      await handle.close();
    } else {
      await writeFile(tmp, data, layout.mode !== undefined ? { mode: layout.mode } : undefined);
    }
    try {
      await rename(tmp, file);
    } catch (error) {
      await unlink(tmp).catch(() => {});
      throw error;
    }
  }

  async function removeCurrent(file: string): Promise<void> {
    try {
      await unlink(file);
    } catch (error) {
      if (!isMissing(error)) throw error;
    }
  }

  // Expired documents of a TTL collection are deleted at most every 10 s.
  async function pruneExpired(): Promise<void> {
    if (!options.ttlMs) return;
    const key = `${name}\0${path.resolve(layout.dir())}`;
    const last = state().pruned.get(key) ?? 0;
    if (Date.now() - last < 10_000) return;
    state().pruned.set(key, Date.now());
    const cutoff = Date.now() - options.ttlMs;
    for (const file of await walk(path.resolve(layout.dir()))) {
      try {
        if ((await stat(file)).mtimeMs <= cutoff) await unlink(file);
      } catch {
        /* gone already */
      }
    }
  }

  const queueKey = (file: string) => `doc\0${file}`;

  return {
    name,
    async get(id) {
      return readCurrent(fileFor(id));
    },
    async put(id, data, putOptions: PutOptions = {}): Promise<PutResult> {
      const file = fileFor(id);
      const bytes = toBuffer(data);
      await pruneExpired();
      return serializeLocal(queueKey(file), async () => {
        if (putOptions.ifVersion !== undefined) {
          const current = await readCurrent(file);
          const matches = putOptions.ifVersion === null ? current === null : current?.version === putOptions.ifVersion;
          if (!matches) return { ok: false, current };
        }
        await writeCurrent(file, bytes);
        return { ok: true, version: versionOf(bytes) };
      });
    },
    async update(id, fn) {
      const file = fileFor(id);
      return serializeLocal(queueKey(file), async () => {
        const current = await readCurrent(file);
        const next = fn(current?.data ?? null);
        if (next === undefined) return { data: undefined, version: current?.version ?? null };
        if (next === null) {
          if (current) await removeCurrent(file);
          return { data: null, version: null };
        }
        const bytes = toBuffer(next);
        await writeCurrent(file, bytes);
        return { data: bytes, version: versionOf(bytes) };
      });
    },
    async delete(id, putOptions: PutOptions = {}) {
      const file = fileFor(id);
      return serializeLocal(queueKey(file), async () => {
        if (putOptions.ifVersion !== undefined) {
          const current = await readCurrent(file);
          const matches = putOptions.ifVersion === null ? current === null : current?.version === putOptions.ifVersion;
          if (!matches) return false;
        }
        await removeCurrent(file);
        return true;
      });
    },
    async list(prefix = '') {
      const dir = path.resolve(layout.dir());
      const ids: string[] = [];
      for (const file of await walk(dir)) {
        const relative = path.relative(dir, file).split(path.sep).join('/');
        const id = layout.idOf ? layout.idOf(relative) : relative;
        if (id === null || !id.startsWith(prefix)) continue;
        try {
          assertDocId(id);
        } catch {
          continue;
        }
        if (options.ttlMs) {
          try {
            if ((await stat(file)).mtimeMs + options.ttlMs <= Date.now()) continue;
          } catch {
            continue;
          }
        }
        ids.push(id);
      }
      return ids.sort();
    },
  };
}

/** Every regular file under `dir`, skipping temp files. */
async function walk(dir: string): Promise<string[]> {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch (error) {
    if (isMissing(error) || (error as NodeJS.ErrnoException)?.code === 'ENOTDIR') return [];
    throw error;
  }
  const files: string[] = [];
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) files.push(...(await walk(full)));
    else if (entry.isFile() && !entry.name.endsWith('.tmp')) files.push(full);
  }
  return files;
}

// ─── log ───────────────────────────────────────────────────────────────────

export function localLog(name: string, options: LogOptions): AppendLog {
  assertName(name);
  const { local } = options;

  async function rotateIfNeeded(file: string): Promise<void> {
    try {
      const info = await stat(file);
      if (info.size < local.maxBytes) return;
      // log.N is dropped, log.(N-1) → log.N, …, log → log.1
      for (let i = local.rotations; i >= 1; i--) {
        const from = i === 1 ? file : `${file}.${i - 1}`;
        if (existsSync(from)) {
          try { await rename(from, `${file}.${i}`); } catch { /* target may exist on overwrite */ }
        }
      }
    } catch {
      // stat failed: the file doesn't exist yet
    }
  }

  return {
    async append(line) {
      const file = path.resolve(local.path());
      await serializeLocal(`log\0${file}`, async () => {
        await mkdir(path.dirname(file), { recursive: true });
        await appendFile(file, line.replace(/[\r\n]+/g, ' ') + '\n', 'utf-8');
        await rotateIfNeeded(file);
      });
    },
    async appendMany(lines) {
      if (lines.length === 0) return;
      const file = path.resolve(local.path());
      await serializeLocal(`log\0${file}`, async () => {
        await mkdir(path.dirname(file), { recursive: true });
        await appendFile(file, lines.map((line) => line.replace(/[\r\n]+/g, ' ') + '\n').join(''), 'utf-8');
        await rotateIfNeeded(file);
      });
    },
    async clear() {
      const file = path.resolve(local.path());
      await serializeLocal(`log\0${file}`, async () => {
        await unlink(file).catch((error) => {
          if (!isMissing(error)) throw error;
        });
      });
    },
    async readAll() {
      try {
        const content = await readFile(path.resolve(local.path()), 'utf-8');
        return content.split('\n').filter(Boolean);
      } catch (error) {
        if (isMissing(error)) return [];
        throw error;
      }
    },
    async length() {
      return (await this.readAll()).length;
    },
  };
}

// ─── coordination ──────────────────────────────────────────────────────────

const leases: LeaseStore = {
  async acquire(name, holder, ttlMs) {
    const current = state().leases.get(name);
    const now = Date.now();
    if (current && current.expiresAt > now && current.holder !== holder) return false;
    state().leases.set(name, { holder, expiresAt: now + ttlMs });
    return true;
  },
  async release(name, holder) {
    if (state().leases.get(name)?.holder === holder) state().leases.delete(name);
  },
  async holder(name) {
    const current = state().leases.get(name);
    return current && current.expiresAt > Date.now() ? current.holder : null;
  },
};

const epochs: EpochStore = {
  async bump(area) {
    const next = (state().epochs.get(area) ?? 0) + 1;
    state().epochs.set(area, next);
    return next;
  },
  async all() {
    return Object.fromEntries(state().epochs);
  },
};

const replicas: ReplicaRegistry = {
  async beat(info) {
    state().replicas.set(info.id, { ...info, lastSeenAt: Date.now() });
  },
  async recent(withinMs) {
    const cutoff = Date.now() - withinMs;
    return [...state().replicas.values()].filter((r) => r.lastSeenAt >= cutoff);
  },
};

export function createLocalStore(): SharedStore {
  return {
    mode: 'local',
    kv,
    counters,
    collection: localCollection,
    log: localLog,
    leases,
    epochs,
    replicas,
    async ping() {},
    status() {
      return { mode: 'local', location: 'local files', connected: true };
    },
    async ready() {},
    async close() {},
  };
}

/** Forget all in-memory state (tests). */
export function resetLocalStoreForTests(): void {
  const g = globalThis as typeof globalThis & { [STATE_KEY]?: LocalState };
  delete g[STATE_KEY];
}
