import path from 'node:path';
import { fakeSharedStore } from '@/lib/shared-store/__tests__/fake-shared';
import { StoreUnavailableError, type SharedStore } from '@/lib/shared-store/types';

/**
 * A shared store that can be taken down: while `down` is set every kv,
 * counter and collection call rejects with StoreUnavailableError, as the
 * Redis store does when its server can't be reached.
 *
 * With `sharedDir`, collections keep their documents under
 * `<sharedDir>/<collection>` instead of the local layout they declare, so the
 * "shared store" is apart from each replica's own files, as Redis is.
 */
export function switchableSharedStore(options: { sharedDir?: string } = {}): SharedStore & { down: boolean } {
  const base = fakeSharedStore();
  const guard = <T extends object>(target: T): T =>
    new Proxy(target, {
      get(obj, prop, receiver) {
        const value = Reflect.get(obj, prop, receiver);
        if (typeof value !== 'function') return value;
        return (...args: unknown[]) => {
          if (store.down) return Promise.reject(new StoreUnavailableError('down (test)'));
          return value.apply(obj, args);
        };
      },
    });
  const { sharedDir } = options;
  const store: SharedStore & { down: boolean } = {
    ...base,
    down: false,
    kv: guard(base.kv),
    counters: guard(base.counters),
    collection: (name, collectionOptions) => guard(base.collection(name, sharedDir
      ? { ...collectionOptions, configDir: false, local: { dir: () => path.join(sharedDir, name) } }
      : collectionOptions)),
  };
  return store;
}
