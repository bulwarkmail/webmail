import { createLocalStore } from '../local';
import type { SharedStore } from '../types';

/**
 * The local store under the shared store's name: everything that branches
 * on isSharedMode() takes its shared path, in one process. The contract
 * suite proves both implementations behave alike, so this stands in for a
 * Redis in unit tests. `down` makes every call fail as an outage would.
 */
export function fakeSharedStore(): SharedStore & { down: boolean } {
  const local = createLocalStore();
  const fake = {
    ...local,
    mode: 'redis' as const,
    down: false,
    async ping() {
      if (fake.down) {
        const { StoreUnavailableError } = await import('../types');
        throw new StoreUnavailableError('down (test)');
      }
    },
    status() {
      return { mode: 'redis' as const, location: 'redis://fake:6379/0', connected: !fake.down };
    },
  };
  return fake;
}
