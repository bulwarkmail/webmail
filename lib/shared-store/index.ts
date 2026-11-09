import { hostname } from 'node:os';
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

export function getStore(): SharedStore {
  const g = globals();
  if (!g.store) {
    const url = sharedStoreUrl();
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
}
