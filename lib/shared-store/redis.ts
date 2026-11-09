import { randomBytes } from 'node:crypto';
import Redis, { type RedisOptions } from 'ioredis';
import { isConfigReadOnly } from '@/lib/admin/paths';
import { assertDocId, assertKey, assertName, toBuffer, versionOf } from './keys';
import { localCollection } from './local';
import {
  StoreUnavailableError,
  isStoreUnavailableError,
  type AppendLog,
  type CollectionOptions,
  type CounterStore,
  type DocCollection,
  type EpochStore,
  type KvStore,
  type LeaseStore,
  type LogOptions,
  type PutOptions,
  type PutResult,
  type ReplicaInfo,
  type ReplicaRegistry,
  type SharedStore,
  type StoredDoc,
} from './types';

/**
 * The shared store on a Redis-protocol server. Every check-then-write is a
 * Lua script, so it is atomic on the server: WATCH would be tied to the
 * connection, which every request in this process shares. Counter windows
 * use the caller's clock, as today's limiters do (a few seconds of skew
 * between replicas don't matter for 15-minute windows). Single endpoint only (no Cluster: the scripts touch
 * several keys).
 */

const SCRIPTS = {
  // KEYS[1] doc hash, KEYS[2] index set. ARGV: data, version, mode (any|absent|version), expected, id, ttlMs
  docPut: `
local cur = redis.call('HGET', KEYS[1], 'v')
if ARGV[3] == 'absent' and cur then return 0 end
if ARGV[3] == 'version' and cur ~= ARGV[4] then return 0 end
redis.call('HSET', KEYS[1], 'd', ARGV[1], 'v', ARGV[2])
if tonumber(ARGV[6]) > 0 then redis.call('PEXPIRE', KEYS[1], ARGV[6]) else redis.call('PERSIST', KEYS[1]) end
redis.call('SADD', KEYS[2], ARGV[5])
return 1`,
  // KEYS[1] doc hash, KEYS[2] index set. ARGV: mode (any|absent|version), expected, id
  docDelete: `
local cur = redis.call('HGET', KEYS[1], 'v')
if ARGV[1] == 'absent' and cur then return 0 end
if ARGV[1] == 'version' and cur ~= ARGV[2] then return 0 end
redis.call('DEL', KEYS[1])
redis.call('SREM', KEYS[2], ARGV[3])
return 1`,
  // KEYS[1] key. ARGV: mode (absent|value), expected, new value ('' with ARGV[4]=1 means delete), delete flag, ttlMs (-1 keep, 0 none)
  kvCas: `
local cur = redis.call('GET', KEYS[1])
if ARGV[1] == 'absent' and cur then return 0 end
if ARGV[1] == 'value' and cur ~= ARGV[2] then return 0 end
if ARGV[4] == '1' then redis.call('DEL', KEYS[1]) return 1 end
local ttl = tonumber(ARGV[5])
if ttl == -1 then
  local left = redis.call('PTTL', KEYS[1])
  if left > 0 then redis.call('SET', KEYS[1], ARGV[3], 'PX', left) else redis.call('SET', KEYS[1], ARGV[3]) end
elseif ttl > 0 then redis.call('SET', KEYS[1], ARGV[3], 'PX', ttl)
else redis.call('SET', KEYS[1], ARGV[3]) end
return 1`,
  kvTake: `
local v = redis.call('GET', KEYS[1])
if v then redis.call('DEL', KEYS[1]) end
return v`,
  // KEYS: counter hashes {n, r}. ARGV: now, max1, window1, max2, window2, … (max < 0 = no limit).
  // Returns {ok, retryAfterMs, n1, r1, n2, r2, …}
  counterReserve: `
local now = tonumber(ARGV[1])
local n, r = {}, {}
local ok, retry = 1, 0
for i, k in ipairs(KEYS) do
  local v = redis.call('HMGET', k, 'n', 'r')
  local ni, ri = tonumber(v[1] or '0'), tonumber(v[2] or '0')
  if ri <= now then ni, ri = 0, 0 end
  n[i], r[i] = ni, ri
  local max = tonumber(ARGV[2 * i])
  if max >= 0 and ni >= max then
    ok = 0
    if ri - now > retry then retry = ri - now end
  end
end
if ok == 1 then
  for i, k in ipairs(KEYS) do
    if r[i] == 0 then r[i] = now + tonumber(ARGV[2 * i + 1]) end
    n[i] = n[i] + 1
    redis.call('HSET', k, 'n', n[i], 'r', r[i])
    -- Kept a minute past the window, so clock skew between replicas can't drop it early.
    redis.call('PEXPIRE', k, math.max(r[i] - now, 0) + 60000)
  end
end
local out = {ok, retry}
for i = 1, #KEYS do out[#out + 1] = n[i]; out[#out + 1] = r[i] end
return out`,
  // KEYS: counters. ARGV: now, then resetAt per key (0 = any window)
  counterRefund: `
local now = tonumber(ARGV[1])
for i, k in ipairs(KEYS) do
  local v = redis.call('HMGET', k, 'n', 'r')
  local n, r = tonumber(v[1] or '0'), tonumber(v[2] or '0')
  local want = tonumber(ARGV[i + 1])
  if r > now and (want == 0 or want == r) and n > 0 then redis.call('HSET', k, 'n', n - 1) end
end
return 1`,
  // KEYS[1] counter. ARGV: now
  counterGet: `
local now = tonumber(ARGV[1])
local v = redis.call('HMGET', KEYS[1], 'n', 'r')
local n, r = tonumber(v[1] or '0'), tonumber(v[2] or '0')
if r <= now then return {0, 0} end
return {n, r}`,
  // KEYS[1] lease. ARGV: holder, ttlMs
  leaseAcquire: `
local h = redis.call('GET', KEYS[1])
if h == ARGV[1] then redis.call('PEXPIRE', KEYS[1], ARGV[2]) return 1 end
if h then return 0 end
redis.call('SET', KEYS[1], ARGV[1], 'PX', ARGV[2])
return 1`,
  leaseRelease: `
if redis.call('GET', KEYS[1]) == ARGV[1] then redis.call('DEL', KEYS[1]) end
return 1`,
} as const;

type ScriptName = keyof typeof SCRIPTS;
type Scripted = Redis & { [K in ScriptName]: (...args: Array<string | number | Buffer>) => Promise<unknown> };

// Server replies that mean "not available right now", not "bug in our script".
// OOM is what a full server with the required noeviction policy answers to writes.
const UNAVAILABLE_REPLY = /^(NOAUTH|WRONGPASS|LOADING|READONLY|MASTERDOWN|BUSY|CLUSTERDOWN|TRYAGAIN|OOM|NOREPLICAS|ERR max number of clients)/;

/** Throw `error` as a StoreUnavailableError when it means the store is unavailable; rethrow it as it is otherwise. */
export function unavailable(error: unknown): never {
  if (isStoreUnavailableError(error)) throw error;
  const name = (error as Error)?.name;
  const message = (error as Error)?.message ?? '';
  if (name === 'ReplyError' && !UNAVAILABLE_REPLY.test(message)) throw error;
  throw new StoreUnavailableError(`The shared store is unavailable: ${message}`, { cause: error });
}

async function call<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (error) {
    unavailable(error);
  }
}

/** The URL without its password, for logs and the admin overview. */
export function redactStoreUrl(url: string): string {
  try {
    const u = new URL(url);
    if (u.password) u.password = '***';
    return u.toString();
  } catch {
    return 'redis://(invalid url)';
  }
}

export interface RedisStoreOptions {
  url: string;
  /** Prefix for every key, so several deployments can share one server. Default `bulwark:`. */
  keyPrefix?: string;
  /** Per-command timeout (ms). Default 2000. */
  commandTimeoutMs?: number;
}

export function createRedisStore(options: RedisStoreOptions): SharedStore {
  const prefix = options.keyPrefix ?? 'bulwark:';
  const redisOptions: RedisOptions = {
    // Fail fast while disconnected, so callers see StoreUnavailableError at
    // once and can fail closed, instead of piling up behind a queue.
    enableOfflineQueue: false,
    maxRetriesPerRequest: 1,
    commandTimeout: options.commandTimeoutMs ?? 2000,
    connectTimeout: 5000,
    retryStrategy: (times) => Math.min(times * 250, 2000),
    lazyConnect: false,
  };
  const client = new Redis(options.url, redisOptions) as Scripted;
  for (const [name, lua] of Object.entries(SCRIPTS)) {
    client.defineCommand(name, { lua, numberOfKeys: name.startsWith('counter') ? undefined : name.startsWith('doc') ? 2 : 1 });
  }
  // A failed connection is reported through commands and ping(); the
  // client's own error events would otherwise go to stderr as unhandled.
  client.on('error', () => {});

  const k = {
    kv: (key: string) => `${prefix}kv:${key}`,
    ctr: (key: string) => `${prefix}ctr:${key}`,
    doc: (coll: string, id: string) => `${prefix}doc:${coll}:${id}`,
    idx: (coll: string) => `${prefix}docidx:${coll}`,
    log: (name: string) => `${prefix}log:${name}`,
    lease: (name: string) => `${prefix}lease:${name}`,
    epochs: `${prefix}epochs`,
    replicas: `${prefix}replicas`,
    seen: `${prefix}replicas:seen`,
  };

  // ─── kv ──────────────────────────────────────────────────────────────────

  const kv: KvStore = {
    async get(key) {
      assertKey(key);
      return call(() => client.get(k.kv(key)));
    },
    async set(key, value, opts = {}) {
      assertKey(key);
      const args: Array<string | number> = [k.kv(key), value];
      if (opts.ttlMs && opts.ttlMs > 0) args.push('PX', Math.ceil(opts.ttlMs));
      if (opts.ifAbsent) args.push('NX');
      const result = await call(() => client.call('SET', ...args));
      return result === 'OK';
    },
    async del(key) {
      assertKey(key);
      await call(() => client.del(k.kv(key)));
    },
    async take(key) {
      assertKey(key);
      return (await call(() => client.kvTake(k.kv(key)))) as string | null;
    },
    async update(key, fn, opts = {}) {
      assertKey(key);
      for (let attempt = 0; attempt < 20; attempt++) {
        const current = await call(() => client.get(k.kv(key)));
        const next = fn(current);
        if (next === undefined) return undefined;
        const ttl = opts.ttlMs && opts.ttlMs > 0 ? Math.ceil(opts.ttlMs) : -1;
        const ok = await call(() => client.kvCas(
          k.kv(key), current === null ? 'absent' : 'value', current ?? '', next ?? '', next === null ? '1' : '0', ttl,
        ));
        if (ok === 1) return next;
        await backoff(attempt);
      }
      // Fail closed like an outage: the callers then answer 503 instead of 500.
      throw new StoreUnavailableError(`Too many concurrent writes to ${key}`);
    },
  };

  // ─── counters ────────────────────────────────────────────────────────────

  const counters: CounterStore = {
    async reserve(limits, now = Date.now()) {
      limits.forEach((l) => assertKey(l.key));
      const args: Array<string | number> = [limits.length, ...limits.map((l) => k.ctr(l.key)), now];
      for (const l of limits) args.push(Number.isFinite(l.max) ? l.max : -1, Math.ceil(l.windowMs));
      const out = (await call(() => client.counterReserve(...args))) as number[];
      const counts: number[] = [];
      const resetAts: number[] = [];
      for (let i = 0; i < limits.length; i++) {
        counts.push(Number(out[2 + 2 * i]));
        resetAts.push(Number(out[3 + 2 * i]));
      }
      return { ok: Number(out[0]) === 1, retryAfterMs: Number(out[1]), counts, resetAts };
    },
    async refund(entries, now = Date.now()) {
      if (entries.length === 0) return;
      entries.forEach((e) => assertKey(e.key));
      await call(() => client.counterRefund(entries.length, ...entries.map((e) => k.ctr(e.key)), now, ...entries.map((e) => e.resetAt ?? 0)));
    },
    async hit(key, windowMs, now = Date.now()) {
      const result = await counters.reserve([{ key, max: Infinity, windowMs }], now);
      return { count: result.counts[0], resetAt: result.resetAts[0] };
    },
    async get(key, now = Date.now()) {
      assertKey(key);
      const [n, r] = ((await call(() => client.counterGet(1, k.ctr(key), now))) as number[]).map(Number);
      return r === 0 ? null : { count: n, resetAt: r };
    },
    async reset(key) {
      assertKey(key);
      await call(() => client.del(k.ctr(key)));
    },
  };

  // ─── documents ───────────────────────────────────────────────────────────

  function collection(name: string, opts: CollectionOptions): DocCollection {
    assertName(name);
    // Read-only config comes from the mounted files on every replica.
    if (opts.configDir && isConfigReadOnly()) return localCollection(name, opts);
    const ttlMs = opts.ttlMs ?? 0;

    async function get(id: string): Promise<StoredDoc | null> {
      assertDocId(id);
      const [data, version] = await call(() => client.hmgetBuffer(k.doc(name, id), 'd', 'v'));
      if (!data || !version) return null;
      return { data, version: version.toString('utf8') };
    }

    async function put(id: string, data: Buffer | string, putOpts: PutOptions = {}): Promise<PutResult> {
      assertDocId(id);
      const bytes = toBuffer(data);
      const version = versionOf(bytes);
      const mode = putOpts.ifVersion === undefined ? 'any' : putOpts.ifVersion === null ? 'absent' : 'version';
      const ok = await call(() => client.docPut(k.doc(name, id), k.idx(name), bytes, version, mode, putOpts.ifVersion ?? '', id, ttlMs));
      if (ok === 1) return { ok: true, version };
      return { ok: false, current: await get(id) };
    }

    return {
      name,
      get,
      put,
      async update(id, fn, updateOpts = {}) {
        const retries = updateOpts.maxRetries ?? 10;
        for (let attempt = 0; attempt <= retries; attempt++) {
          const current = await get(id);
          const next = fn(current?.data ?? null);
          if (next === undefined) return { data: undefined, version: current?.version ?? null };
          if (next === null) {
            if (!current) return { data: null, version: null };
            const ok = await call(() => client.docDelete(k.doc(name, id), k.idx(name), 'version', current.version, id));
            if (ok === 1) return { data: null, version: null };
          } else {
            const result = await put(id, next, { ifVersion: current?.version ?? null });
            if (result.ok) return { data: toBuffer(next), version: result.version };
          }
          await backoff(attempt);
        }
        throw new StoreUnavailableError(`Too many concurrent writes to ${name}/${id}`);
      },
      async delete(id, putOpts: PutOptions = {}) {
        assertDocId(id);
        const mode = putOpts.ifVersion === undefined ? 'any' : putOpts.ifVersion === null ? 'absent' : 'version';
        return (await call(() => client.docDelete(k.doc(name, id), k.idx(name), mode, putOpts.ifVersion ?? '', id))) === 1;
      },
      async list(prefix = '') {
        const ids = (await call(() => client.smembers(k.idx(name)))).filter((id) => id.startsWith(prefix));
        if (ids.length === 0) return [];
        // Expired documents (TTL collections) leave their id in the index.
        const exists = await call(() => {
          const pipeline = client.pipeline();
          for (const id of ids) pipeline.exists(k.doc(name, id));
          return pipeline.exec();
        });
        const live: string[] = [];
        const stale: string[] = [];
        ids.forEach((id, i) => ((exists?.[i]?.[1] as number) === 1 ? live : stale).push(id));
        if (stale.length) await call(() => client.srem(k.idx(name), ...stale));
        return live.sort();
      },
    };
  }

  // ─── log ─────────────────────────────────────────────────────────────────

  function log(name: string, opts: LogOptions): AppendLog {
    assertName(name);
    const key = k.log(name);
    return {
      async append(line) {
        const clean = line.replace(/[\r\n]+/g, ' ');
        await call(() => client.multi().rpush(key, clean).ltrim(key, -opts.maxEntries, -1).exec());
      },
      async appendMany(lines) {
        if (lines.length === 0) return;
        const clean = lines.map((line) => line.replace(/[\r\n]+/g, ' '));
        await call(() => client.multi().rpush(key, ...clean).ltrim(key, -opts.maxEntries, -1).exec());
      },
      async clear() {
        await call(() => client.del(key));
      },
      async readAll() {
        return call(() => client.lrange(key, 0, -1));
      },
      async length() {
        return call(() => client.llen(key));
      },
    };
  }

  // ─── coordination ────────────────────────────────────────────────────────

  const leases: LeaseStore = {
    async acquire(name, holder, ttlMs) {
      assertName(name);
      return (await call(() => client.leaseAcquire(k.lease(name), holder, Math.ceil(ttlMs)))) === 1;
    },
    async release(name, holder) {
      assertName(name);
      await call(() => client.leaseRelease(k.lease(name), holder));
    },
    async holder(name) {
      assertName(name);
      return call(() => client.get(k.lease(name)));
    },
  };

  const epochs: EpochStore = {
    async bump(area) {
      return Number(await call(() => client.hincrby(k.epochs, area, 1)));
    },
    async all() {
      const raw = await call(() => client.hgetall(k.epochs));
      return Object.fromEntries(Object.entries(raw).map(([a, n]) => [a, Number(n)]));
    },
  };

  const REPLICA_KEEP_MS = 10 * 60 * 1000;
  const replicas: ReplicaRegistry = {
    async beat(info) {
      const now = Date.now();
      await call(() => client.multi()
        .hset(k.replicas, info.id, JSON.stringify({ ...info, lastSeenAt: now }))
        .zadd(k.seen, now, info.id)
        .exec());
      const old = await call(() => client.zrangebyscore(k.seen, '-inf', now - REPLICA_KEEP_MS));
      if (old.length) await call(() => client.multi().zrem(k.seen, ...old).hdel(k.replicas, ...old).exec());
    },
    async recent(withinMs) {
      const ids = await call(() => client.zrangebyscore(k.seen, Date.now() - withinMs, '+inf'));
      if (ids.length === 0) return [];
      const raw = await call(() => client.hmget(k.replicas, ...ids));
      return raw.flatMap((r) => {
        if (!r) return [];
        try { return [JSON.parse(r) as ReplicaInfo]; } catch { return []; }
      });
    },
  };

  let readyPromise: Promise<void> | null = null;

  return {
    mode: 'redis',
    kv,
    counters,
    collection,
    log,
    leases,
    epochs,
    replicas,
    async ping(timeoutMs = 1000) {
      let timer: NodeJS.Timeout | undefined;
      try {
        await Promise.race([
          call(() => client.ping()),
          new Promise<never>((_, reject) => {
            timer = setTimeout(() => reject(new StoreUnavailableError('The shared store did not answer in time')), timeoutMs);
          }),
        ]);
      } finally {
        if (timer) clearTimeout(timer);
      }
    },
    status() {
      return { mode: 'redis', location: redactStoreUrl(options.url), connected: client.status === 'ready' };
    },
    ready() {
      readyPromise ??= client.status === 'ready'
        ? Promise.resolve()
        : new Promise<void>((resolve) => client.once('ready', () => resolve()));
      return readyPromise;
    },
    async close() {
      client.disconnect();
    },
  };
}

function backoff(attempt: number): Promise<void> {
  const ms = Math.min(5 + attempt * 10, 100) * (0.5 + Math.random());
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** An id unique to this process, for leases and the replica list. */
export function randomHolderSuffix(): string {
  return randomBytes(3).toString('hex');
}
