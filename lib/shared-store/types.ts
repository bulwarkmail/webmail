/**
 * The storage interface every piece of server state that must be the same on
 * every replica goes through (#1066). Two implementations:
 *
 * - local (default): today's behaviour. Short-lived state in memory on
 *   globalThis, durable state in the files each collection declares, with
 *   the same paths and formats as before.
 * - redis: one Redis-protocol server (Redis, Valkey, KeyDB, Dragonfly)
 *   shared by every replica, selected by REDIS_URL.
 *
 * Stores never talk to Redis directly and never ask which implementation
 * they have, except to choose their behaviour when the shared store is down
 * (StoreUnavailableError).
 */

export type StoreMode = 'local' | 'redis';

/** The shared store could not be reached or didn't answer in time. */
export class StoreUnavailableError extends Error {
  constructor(message = 'The shared store is unavailable', options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'StoreUnavailableError';
  }
}

/**
 * Whether `error` is a StoreUnavailableError. Check with this, never with
 * `instanceof`: Next evaluates this module once per bundle entry, and the
 * store on globalThis throws the class of whichever copy created it, so
 * `instanceof` in another copy is false.
 */
export function isStoreUnavailableError(error: unknown): boolean {
  return (error as Error | null)?.name === 'StoreUnavailableError';
}

/** A collection or document id that would leave its namespace. */
export class InvalidStoreKeyError extends Error {
  constructor(key: string) {
    super(`Invalid store key: ${JSON.stringify(key)}`);
    this.name = 'InvalidStoreKeyError';
  }
}

// ─── Short-lived values ────────────────────────────────────────────────────

export interface KvSetOptions {
  /** Expire after this many milliseconds. Without it the value stays until deleted. */
  ttlMs?: number;
  /** Only set when the key doesn't exist. `set` then returns false if it did. */
  ifAbsent?: boolean;
}

/**
 * String values that may expire. Local: memory only, gone on restart, as
 * today's in-process maps are.
 */
export interface KvStore {
  get(key: string): Promise<string | null>;
  /** Returns false only when `ifAbsent` was set and the key existed. */
  set(key: string, value: string, options?: KvSetOptions): Promise<boolean>;
  del(key: string): Promise<void>;
  /** Read and delete in one step: of several callers, exactly one gets the value. */
  take(key: string): Promise<string | null>;
  /**
   * Read, change and write one value atomically. `fn` gets the current value
   * (null if missing) and returns the new one, or null to delete it, or
   * undefined to leave it as it is. Returns what `fn` returned. `fn` may run
   * more than once in shared mode (on a conflicting write), so it must not
   * have side effects. `ttlMs` applies to the written value.
   */
  update(key: string, fn: (current: string | null) => string | null | undefined, options?: { ttlMs?: number }): Promise<string | null | undefined>;
}

// ─── Counters for limits ───────────────────────────────────────────────────

export interface CounterLimit {
  key: string;
  /** Reserve fails when the counter already holds this many. `Infinity` for no limit. */
  max: number;
  /** Fixed window: it starts with the first count and resets after this long. */
  windowMs: number;
}

export interface ReserveResult {
  ok: boolean;
  /** When refused: how long until the fullest refusing window resets. */
  retryAfterMs: number;
  /** Counts after the reservation (or as they were, when refused), in the order given. */
  counts: number[];
  /** When each window resets (ms), in the order given; 0 for a counter that doesn't exist. Pass to refund. */
  resetAts: number[];
}

/**
 * Fixed-window counters, as every login limit uses today. Local: memory.
 */
export interface CounterStore {
  /**
   * Atomically: if every counter is below its max, add one to each and
   * return ok; otherwise change nothing. `now` (ms) is the caller's clock,
   * as today's limiters take it; default Date.now().
   */
  reserve(limits: CounterLimit[], now?: number): Promise<ReserveResult>;
  /**
   * Take back one count from each key, never below zero. With `resetAt`
   * (from reserve) only from that same window: a window that has since
   * reset is left alone.
   */
  refund(entries: Array<{ key: string; resetAt?: number }>, now?: number): Promise<void>;
  /** Add one and return the new count and when the window resets. */
  hit(key: string, windowMs: number, now?: number): Promise<{ count: number; resetAt: number }>;
  get(key: string, now?: number): Promise<{ count: number; resetAt: number } | null>;
  reset(key: string): Promise<void>;
}

// ─── Durable documents ─────────────────────────────────────────────────────

/** Where a collection lives in local mode. */
export interface LocalLayout {
  /** The directory, resolved on every call so env changes in tests apply. */
  dir: () => string;
  /** File name for an id; default: the id itself. May contain `/` for subfolders. */
  file?: (id: string) => string;
  /** Map a relative file path back to its id, for list(); default: identity. Return null to skip a file. */
  idOf?: (relativePath: string) => string | null;
  /** File mode for writes, e.g. 0o600 for files holding secrets. */
  mode?: number;
  /**
   * Today's temp-file name for a target, when a store's tests or tooling
   * depend on it. Default: `<target>.<pid>.<random>.tmp`.
   */
  tmpName?: (target: string) => string;
  /**
   * Flush the temp file to disk before the rename (open with `wx`, write,
   * fsync, close), for documents that must survive a power cut.
   */
  fsync?: boolean;
}

export interface CollectionOptions {
  local: LocalLayout;
  /**
   * The collection is part of the admin config dir. When
   * ADMIN_CONFIG_READONLY is set it is read from the mounted files on every
   * replica, in shared mode too, and writes are refused upstream.
   */
  configDir?: boolean;
  /**
   * Documents expire this long after they were written (local: by file
   * mtime, pruned when the collection is used).
   */
  ttlMs?: number;
}

export interface StoredDoc {
  data: Buffer;
  /** Changes on every write. Opaque. */
  version: string;
}

export interface PutOptions {
  /**
   * Only write when the document is at this version; `null` = only when it
   * doesn't exist. Omit for an unconditional write.
   */
  ifVersion?: string | null;
}

export type PutResult = { ok: true; version: string } | { ok: false; current: StoredDoc | null };

export interface UpdateOptions {
  /** Conflicting writes in shared mode are retried this often (default 10). */
  maxRetries?: number;
}

export interface DocCollection {
  readonly name: string;
  get(id: string): Promise<StoredDoc | null>;
  put(id: string, data: Buffer | string, options?: PutOptions): Promise<PutResult>;
  /**
   * Read, change and write one document without losing a concurrent write.
   * `fn` gets the current data (null if missing) and returns new data, null
   * to delete, or undefined to leave it. It may run more than once, so no
   * side effects. Returns `fn`'s last result and the version written.
   */
  update(
    id: string,
    fn: (current: Buffer | null) => Buffer | string | null | undefined,
    options?: UpdateOptions,
  ): Promise<{ data: Buffer | null | undefined; version: string | null }>;
  /** Returns false when `ifVersion` didn't match. */
  delete(id: string, options?: PutOptions): Promise<boolean>;
  /** Ids under a prefix (`''` for all), sorted. */
  list(prefix?: string): Promise<string[]>;
}

// ─── Append-only log ───────────────────────────────────────────────────────

export interface LogOptions {
  local: {
    /** The log file; rotated to `.1`… when it passes `maxBytes`. */
    path: () => string;
    maxBytes: number;
    rotations: number;
  };
  /** Shared mode keeps the newest this many lines. */
  maxEntries: number;
}

export interface AppendLog {
  /** One line, without a newline. Lines are never interleaved or torn. */
  append(line: string): Promise<void>;
  /**
   * Several lines in one call, in this order; no other writer's line lands
   * between them. For bulk copies such as the import.
   */
  appendMany(lines: string[]): Promise<void>;
  /** Remove every line readAll returns (local: the current file; rotated files stay). */
  clear(): Promise<void>;
  /** Every line, oldest first (local: the current file only, as today). */
  readAll(): Promise<string[]>;
  length(): Promise<number>;
}

// ─── Coordination ──────────────────────────────────────────────────────────

export interface LeaseStore {
  /** Take or renew a lease. True when `holder` holds it afterwards. */
  acquire(name: string, holder: string, ttlMs: number): Promise<boolean>;
  /** Give it up, if `holder` still holds it. */
  release(name: string, holder: string): Promise<void>;
  holder(name: string): Promise<string | null>;
}

export interface EpochStore {
  /** Add one to an area's epoch and return it. */
  bump(area: string): Promise<number>;
  all(): Promise<Record<string, number>>;
}

export interface ReplicaInfo {
  id: string;
  version: string;
  startedAt: number;
  lastSeenAt: number;
}

export interface ReplicaRegistry {
  beat(info: Omit<ReplicaInfo, 'lastSeenAt'>): Promise<void>;
  /** Replicas that beat within the last `withinMs`. */
  recent(withinMs: number): Promise<ReplicaInfo[]>;
}

// ─── The store ─────────────────────────────────────────────────────────────

export interface StoreStatus {
  mode: StoreMode;
  /** Where it is, with any password removed, e.g. `redis://valkey:6379/0`. */
  location: string;
  connected: boolean;
}

export interface SharedStore {
  readonly mode: StoreMode;
  readonly kv: KvStore;
  readonly counters: CounterStore;
  collection(name: string, options: CollectionOptions): DocCollection;
  log(name: string, options: LogOptions): AppendLog;
  readonly leases: LeaseStore;
  readonly epochs: EpochStore;
  readonly replicas: ReplicaRegistry;
  /** Resolves when the store answered; throws StoreUnavailableError otherwise. */
  ping(timeoutMs?: number): Promise<void>;
  status(): StoreStatus;
  /** Wait for the first connection (shared mode). Local: resolves at once. */
  ready(): Promise<void>;
  close(): Promise<void>;
}
