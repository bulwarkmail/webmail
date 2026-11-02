import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { localCollection } from '@/lib/shared-store/local';
import { fakeSharedStore } from '@/lib/shared-store/__tests__/fake-shared';
import {
  StoreUnavailableError,
  type DocCollection,
  type KvStore,
  type LeaseStore,
  type SharedStore,
} from '@/lib/shared-store/types';

export type SeparateDiskStore = SharedStore & { down: boolean; root: string; cleanup(): void };

/**
 * A fake shared store (mode 'redis') whose documents live in a folder of
 * their own, not in the dirs a store names for local mode. Every replica has
 * its own disk: a store that still wrote its local files would not find on
 * "replica B" (another SETTINGS_DATA_DIR, …) what it saved on "replica A".
 * `down` makes every document, kv and lease call fail as an outage would.
 */
export function separateDiskStore(): SeparateDiskStore {
  const root = mkdtempSync(path.join(tmpdir(), 'bw-shared-store-'));
  const base = fakeSharedStore();
  const guard = <T>(run: () => Promise<T>): Promise<T> =>
    store.down ? Promise.reject(new StoreUnavailableError('down (test)')) : run();

  const kv: KvStore = {
    get: (key) => guard(() => base.kv.get(key)),
    set: (key, value, options) => guard(() => base.kv.set(key, value, options)),
    del: (key) => guard(() => base.kv.del(key)),
    take: (key) => guard(() => base.kv.take(key)),
    update: (key, fn, options) => guard(() => base.kv.update(key, fn, options)),
  };
  const leases: LeaseStore = {
    acquire: (name, holder, ttlMs) => guard(() => base.leases.acquire(name, holder, ttlMs)),
    release: (name, holder) => guard(() => base.leases.release(name, holder)),
    holder: (name) => guard(() => base.leases.holder(name)),
  };

  const store: SeparateDiskStore = {
    ...base,
    kv,
    leases,
    root,
    get down() {
      return base.down;
    },
    set down(value: boolean) {
      base.down = value;
    },
    collection(name, options): DocCollection {
      const inner = localCollection(name, { ...options, local: { ...options.local, dir: () => path.join(root, name) } });
      return {
        name,
        get: (id) => guard(() => inner.get(id)),
        put: (id, data, putOptions) => guard(() => inner.put(id, data, putOptions)),
        update: (id, fn, updateOptions) => guard(() => inner.update(id, fn, updateOptions)),
        delete: (id, deleteOptions) => guard(() => inner.delete(id, deleteOptions)),
        list: (prefix) => guard(() => inner.list(prefix)),
      };
    },
    cleanup() {
      rmSync(root, { recursive: true, force: true });
    },
  };
  return store;
}
