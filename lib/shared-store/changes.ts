import { logger } from '@/lib/logger';
import { getStore, isSharedMode, setBootState } from './index';

/**
 * How admin changes reach every replica (#1066).
 *
 * Every write to shared state calls announceChange(area): that bumps the
 * area's epoch in the store and runs this process's listeners at once (they
 * may live in another module copy: proxy, instrumentation, routes). Every
 * replica reads all epochs once a second and runs the listeners of each
 * area whose epoch moved. A replica therefore sees a change within about a
 * second, and one that couldn't reach the store for a while catches up on
 * its first successful read.
 *
 * The epoch is noted before the listeners reload, so a change that lands
 * while they read is picked up by the next poll.
 *
 * Local mode: no poller; announceChange only runs this process's listeners.
 */

export type ChangeOrigin = 'local' | 'remote';
export type ChangeListener = (origin: ChangeOrigin) => void | Promise<void>;

/** Set once the store holds a deployment; its absence later means the store lost its data. */
export const INIT_EPOCH = '_init';

export const POLL_INTERVAL_MS = 1000;

interface ChangeGlobals {
  listeners: Map<string, Set<ChangeListener>>;
  seen: Map<string, number>;
  poller?: NodeJS.Timeout;
  polling?: Promise<void>;
  lastPollOk: number;
  storeLost: boolean;
  /** Areas whose epoch bump failed (store unreachable after the write). */
  pendingBumps: Set<string>;
}

const KEY = Symbol.for('bulwark.sharedStore.changes');

function globals(): ChangeGlobals {
  const g = globalThis as typeof globalThis & { [KEY]?: ChangeGlobals };
  return (g[KEY] ??= { listeners: new Map(), seen: new Map(), lastPollOk: 0, storeLost: false, pendingBumps: new Set() });
}

/**
 * Run `fn` when `area` changes: at once for a write in this process
 * (origin 'local'), and after another replica's write (origin 'remote',
 * shared mode only). Returns an unsubscribe function.
 */
export function onSharedChange(area: string, fn: ChangeListener): () => void {
  const listeners = globals().listeners;
  let set = listeners.get(area);
  if (!set) listeners.set(area, (set = new Set()));
  set.add(fn);
  return () => set!.delete(fn);
}

async function runListeners(area: string, origin: ChangeOrigin): Promise<boolean> {
  let ok = true;
  for (const fn of [...(globals().listeners.get(area) ?? [])]) {
    try {
      await fn(origin);
    } catch (error) {
      ok = false;
      logger.warn('Could not apply a change from the shared store', {
        area,
        error: error instanceof Error ? error.message : 'Unknown error',
      });
    }
  }
  return ok;
}

/**
 * Tell every replica that `area` changed. Call it after the write went
 * through. In shared mode a failure to bump the epoch is logged, not thrown:
 * the write itself succeeded. The bump is kept and retried by every poll
 * until it goes through, so the other replicas still pick the change up.
 */
export async function announceChange(area: string): Promise<void> {
  const g = globals();
  if (isSharedMode()) {
    try {
      const epoch = await getStore().epochs.bump(area);
      // Only skip our own change when nothing else landed in between;
      // otherwise the poller reloads to pick up the other replica's.
      if ((g.seen.get(area) ?? 0) === epoch - 1) g.seen.set(area, epoch);
    } catch (error) {
      g.pendingBumps.add(area);
      logger.warn('Could not announce a change to the other replicas; retrying with the next poll', {
        area,
        error: error instanceof Error ? error.message : 'Unknown error',
      });
    }
  }
  await runListeners(area, 'local');
}

/** Send the bumps that failed earlier. A failure leaves them for the next poll. */
async function retryPendingBumps(g: ChangeGlobals): Promise<void> {
  for (const area of [...g.pendingBumps]) {
    await getStore().epochs.bump(area);
    g.pendingBumps.delete(area);
    logger.info('Announced a change to the other replicas after a retry', { area });
  }
}

/** One poll: read the epochs, run the listeners of every area that moved. */
export async function pollChanges(): Promise<void> {
  const g = globals();
  if (g.polling) return g.polling;
  g.polling = (async () => {
    // Our own retried bump then shows up as a change on this replica too,
    // which costs one reload and keeps the logic simple.
    if (g.pendingBumps.size) await retryPendingBumps(g);
    const epochs = await getStore().epochs.all();
    if (!epochs[INIT_EPOCH]) {
      if (!g.storeLost) {
        g.storeLost = true;
        setBootState('store-lost');
        logger.error(
          'The shared store no longer holds this deployment (restarted without persistence, flushed or evicted). ' +
          'Keeping the last loaded config; nothing is regenerated. Restore the store from a backup, ' +
          'or restart every replica to start it over.',
        );
      }
      return;
    }
    g.lastPollOk = Date.now();
    if (g.storeLost) {
      // Restored from a backup: reload everything from it.
      g.storeLost = false;
      g.seen.clear();
      setBootState('ready');
      logger.warn('The shared store holds this deployment again; reloading from it');
      for (const area of g.listeners.keys()) if (!(area in epochs)) await runListeners(area, 'remote');
    }
    for (const [area, epoch] of Object.entries(epochs)) {
      if (area === INIT_EPOCH) continue;
      const before = g.seen.get(area) ?? 0;
      if (epoch === before) continue;
      g.seen.set(area, epoch);
      if (!(await runListeners(area, 'remote'))) {
        // Try again on the next poll.
        if (g.seen.get(area) === epoch) g.seen.set(area, before);
      }
    }
  })()
    .catch(() => {
      // Store unreachable: readiness reports it; the next poll catches up.
    })
    .finally(() => {
      g.polling = undefined;
    });
  return g.polling;
}

/**
 * Take the current epochs as the baseline, so the first poll doesn't reload
 * what boot just loaded. Call before loading the data the listeners reload.
 */
export async function markEpochsSeen(): Promise<void> {
  const epochs = await getStore().epochs.all();
  const g = globals();
  for (const [area, epoch] of Object.entries(epochs)) g.seen.set(area, epoch);
}

export function startChangePoller(intervalMs = POLL_INTERVAL_MS): void {
  const g = globals();
  if (g.poller || !isSharedMode()) return;
  g.poller = setInterval(() => void pollChanges(), intervalMs);
  g.poller.unref();
}

export function stopChangePoller(): void {
  const g = globals();
  if (g.poller) clearInterval(g.poller);
  g.poller = undefined;
}

/** When the epochs were last read successfully (ms), 0 if never. */
export function lastSuccessfulPoll(): number {
  return globals().lastPollOk;
}

export function storeLostItsData(): boolean {
  return globals().storeLost;
}

/** Forget listeners and epochs (tests). */
export function resetChangesForTests(): void {
  stopChangePoller();
  const g = globalThis as typeof globalThis & { [KEY]?: ChangeGlobals };
  delete g[KEY];
}
