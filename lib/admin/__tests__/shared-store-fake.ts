import path from 'node:path';
import { isConfigReadOnly } from '../paths';
import { localCollection, localLog } from '@/lib/shared-store/local';
import { StoreUnavailableError, type CollectionOptions, type LogOptions, type SharedStore } from '@/lib/shared-store';
import { fakeSharedStore } from '@/lib/shared-store/__tests__/fake-shared';

/**
 * The fake shared store (lib/shared-store/__tests__/fake-shared.ts) with its
 * documents and logs under `root` instead of the dirs local mode uses, as a
 * Redis would hold them apart from this replica's files. Without that, code
 * that still read and wrote its local files would pass for shared.
 *
 * `down` makes every document, log, counter and kv call fail as an outage would.
 */
export function separateFakeStore(root: string): SharedStore & { down: boolean } {
  const fake = fakeSharedStore();
  const guard = <T>(fn: () => Promise<T>): Promise<T> =>
    fake.down ? Promise.reject(new StoreUnavailableError('down (test)')) : fn();
  const counters = fake.counters;
  const kv = fake.kv;
  return Object.assign(fake, {
    collection(name: string, options: CollectionOptions) {
      // Read-only config comes from the mounted files, as in the Redis store.
      if (options.configDir && isConfigReadOnly()) return localCollection(name, options);
      const docs = localCollection(name, { ...options, local: { ...options.local, dir: () => path.join(root, 'docs', name) } });
      return {
        name,
        get: (id: string) => guard(() => docs.get(id)),
        put: (...args: Parameters<typeof docs.put>) => guard(() => docs.put(...args)),
        update: (...args: Parameters<typeof docs.update>) => guard(() => docs.update(...args)),
        delete: (...args: Parameters<typeof docs.delete>) => guard(() => docs.delete(...args)),
        list: (prefix?: string) => guard(() => docs.list(prefix)),
      };
    },
    log(name: string, options: LogOptions) {
      const log = localLog(name, { ...options, local: { ...options.local, path: () => path.join(root, 'logs', `${name}.log`) } });
      return {
        append: (line: string) => guard(() => log.append(line)),
        appendMany: (lines: string[]) => guard(() => log.appendMany(lines)),
        clear: () => guard(() => log.clear()),
        readAll: () => guard(() => log.readAll()),
        length: () => guard(() => log.length()),
      };
    },
    kv: {
      get: (key: string) => guard(() => kv.get(key)),
      set: (...args: Parameters<typeof kv.set>) => guard(() => kv.set(...args)),
      del: (key: string) => guard(() => kv.del(key)),
      take: (key: string) => guard(() => kv.take(key)),
      update: (...args: Parameters<typeof kv.update>) => guard(() => kv.update(...args)),
    },
    counters: {
      reserve: (...args: Parameters<typeof counters.reserve>) => guard(() => counters.reserve(...args)),
      refund: (...args: Parameters<typeof counters.refund>) => guard(() => counters.refund(...args)),
      hit: (...args: Parameters<typeof counters.hit>) => guard(() => counters.hit(...args)),
      get: (...args: Parameters<typeof counters.get>) => guard(() => counters.get(...args)),
      reset: (key: string) => guard(() => counters.reset(key)),
    },
  });
}
