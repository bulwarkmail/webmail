import { hostname } from 'node:os';
import { logger } from '@/lib/logger';
import { readFileEnv } from '@/lib/read-file-env';
import { createLocalStore } from './local';
import { createRedisStore, randomHolderSuffix } from './redis';
import type { SharedStore } from './types';

export * from './types';

/**
 * The one store of this process. On globalThis, because Next evaluates this
 * module once per bundle entry (proxy, instrumentation, each route bundle)
 * and they must all share one connection and one set of local maps.
 */
interface StoreGlobals {
  store?: SharedStore;
  replicaId?: string;
  boot?: BootState;
  refusalLogged?: boolean;
}

/**
 * starting: connecting to the store and loading. ready: serving.
 * store-lost: the store was emptied under a running deployment (see
 * changes.ts); the replica keeps its last loaded state and isn't ready.
 * blocked: this replica's local data conflicts with an already initialised
 * store (see boot.ts); it won't serve until an admin resolves it.
 */
export type BootState = 'starting' | 'ready' | 'store-lost' | 'blocked';

const KEY = Symbol.for('bulwark.sharedStore');

function globals(): StoreGlobals {
  const g = globalThis as typeof globalThis & { [KEY]?: StoreGlobals };
  return (g[KEY] ??= {});
}

/** The shared store URL from REDIS_URL or REDIS_URL_FILE, or null for local mode. */
export function sharedStoreUrl(): string | null {
  return process.env.REDIS_URL || readFileEnv(process.env.REDIS_URL_FILE) || null;
}

/** The password in a store address, read as ioredis reads it; undefined when it isn't one. */
function storeUrlPassword(url: string): string | undefined {
  try {
    // A socket path takes its password from the query only.
    if (url.startsWith('/') && !url.startsWith('//')) {
      return new URLSearchParams(url.split('?')[1] ?? '').get('password') ?? '';
    }
    const parsed = new URL(/^rediss?:\/\//i.test(url) ? url : url.startsWith('//') ? `redis:${url}` : `redis://${url}`);
    return decodeURIComponent(parsed.password) || parsed.searchParams.get('password') || '';
  } catch {
    return undefined;
  }
}

/**
 * Why this process must not use the store at `url`, or null when it may. A
 * store without a password takes commands from anything that reaches it,
 * and it holds the admin config, the admin sign-in and the plugins, so the
 * address has to carry one unless SHARED_STORE_ALLOW_NO_PASSWORD=true says
 * only this deployment can reach the store.
 */
export function storeUrlRefusal(url: string): string | null {
  const password = storeUrlPassword(url);
  if (password === undefined) {
    return 'The shared store address (REDIS_URL or REDIS_URL_FILE) is not a valid URL. A password with / ? # @ or % ' +
      'in it has to be percent-encoded; openssl rand -hex 32 makes one that needs no encoding.';
  }
  if (password || process.env.SHARED_STORE_ALLOW_NO_PASSWORD?.trim().toLowerCase() === 'true') return null;
  return 'The shared store address (REDIS_URL or REDIS_URL_FILE) has no password, so Bulwark does not connect. ' +
    'Set a password on the store and put it in the address (redis://:<password>@host:6379/0), or set ' +
    'SHARED_STORE_ALLOW_NO_PASSWORD=true if nothing but this deployment can reach the store.';
}

export function getStore(): SharedStore {
  const g = globals();
  if (!g.store) {
    const url = sharedStoreUrl();
    const refusal = url ? storeUrlRefusal(url) : null;
    if (refusal) {
      if (!g.refusalLogged) logger.error(refusal);
      g.refusalLogged = true;
      throw new Error(refusal);
    }
    g.store = url
      ? createRedisStore({ url, keyPrefix: process.env.REDIS_KEY_PREFIX || 'bulwark:' })
      : createLocalStore();
  }
  return g.store;
}

/** True when this process runs with a shared store (several replicas possible). */
export function isSharedMode(): boolean {
  return getStore().mode !== 'local';
}

/** Stable for the life of the process: host name plus a random suffix. */
export function replicaId(): string {
  const g = globals();
  g.replicaId ??= `${hostname()}-${randomHolderSuffix()}`;
  return g.replicaId;
}

/**
 * How far the boot chain got. Local mode starts out ready, as it always
 * has; shared mode is "starting" until instrumentation finished connecting,
 * importing and loading (see instrumentation.node.ts).
 */
export function bootState(): BootState {
  const g = globals();
  return g.boot ?? (isSharedMode() ? 'starting' : 'ready');
}

export function setBootState(state: BootState): void {
  globals().boot = state;
}

/** Replace the store (tests). Pass null to go back to the one from the environment. */
export function setStoreForTests(store: SharedStore | null): void {
  const g = globals();
  g.store = store ?? undefined;
  g.boot = undefined;
  g.refusalLogged = undefined;
}
