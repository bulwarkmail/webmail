import { logger } from '@/lib/logger';
import {
  ensureSharedSessionSecret,
  hasConfiguredSessionSecret,
  localGeneratedSessionSecret,
  SHARED_SECRET_KEY,
} from '@/lib/auth/session-secret';
import { INIT_EPOCH, markEpochsSeen, startChangePoller } from './changes';
import { getStore, replicaId, setBootState } from './index';

/**
 * Boot with a shared store (#1066). Order:
 *
 * 1. Wait until the store answers (the replica reports "starting" meanwhile;
 *    the proxy answers 503 to everything but the probes).
 * 2. Under the `boot` lease, so replicas starting together take turns:
 *    - Store not initialised yet: import this replica's local files (an
 *      existing single-instance install moving over), create the session
 *      secret if none was imported, then mark the store initialised. The
 *      marker is written last, so an import that dies halfway is redone.
 *    - Already initialised: check that this replica's local data doesn't
 *      conflict with it (a generated secret of its own would mean data
 *      encrypted with another key).
 * 3. Load the secret, take the epochs as the baseline, run `load` (config
 *    and the rest), start the change poller and the replica heartbeat.
 */

export interface ImportSummary {
  /** What was written per store, e.g. { settings: 3, config: 1 }. */
  imported: Record<string, number>;
}

export interface SharedBootOptions {
  version: string;
  /** Copy this replica's local files into an uninitialised store. */
  importLocal: () => Promise<ImportSummary>;
  /** Load everything this process caches from the store (config, …). */
  load: () => Promise<void>;
}

const BOOT_LEASE = 'boot';
const BOOT_LEASE_TTL_MS = 60_000;
const HEARTBEAT_MS = 15_000;
const META_KEY = 'meta:initialized';

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForStore(): Promise<void> {
  const store = getStore();
  // The client connects by itself; give the first connection a moment
  // before calling the store unreachable.
  await Promise.race([store.ready(), sleep(5000)]);
  let warned = false;
  for (;;) {
    try {
      await store.ping(2000);
      return;
    } catch (error) {
      if (!warned) {
        warned = true;
        logger.warn('Waiting for the shared store', {
          location: store.status().location,
          error: error instanceof Error ? error.message : 'Unknown error',
        });
      }
      await sleep(2000);
    }
  }
}

/** Hold the boot lease while `task` runs, renewing it; wait for it first. */
async function withBootLease<T>(task: () => Promise<T>): Promise<T> {
  const store = getStore();
  const holder = replicaId();
  while (!(await store.leases.acquire(BOOT_LEASE, holder, BOOT_LEASE_TTL_MS))) await sleep(1000);
  const renew = setInterval(() => {
    void store.leases.acquire(BOOT_LEASE, holder, BOOT_LEASE_TTL_MS).catch(() => {});
  }, BOOT_LEASE_TTL_MS / 3);
  renew.unref();
  try {
    return await task();
  } finally {
    clearInterval(renew);
    await store.leases.release(BOOT_LEASE, holder).catch(() => {});
  }
}

async function initialise(options: SharedBootOptions): Promise<'initialised' | 'joined' | 'blocked'> {
  const store = getStore();
  return withBootLease(async () => {
    const epochs = await store.epochs.all();
    if (!epochs[INIT_EPOCH]) {
      // The local generated secret first: settings and plugin secrets
      // imported with it are encrypted with it.
      const localSecret = localGeneratedSessionSecret();
      if (localSecret) await store.kv.set(SHARED_SECRET_KEY, localSecret, { ifAbsent: true });
      const summary = await options.importLocal();
      await ensureSharedSessionSecret();
      await store.kv.set(META_KEY, JSON.stringify({ at: new Date().toISOString(), by: replicaId(), ...summary }));
      await store.epochs.bump(INIT_EPOCH);
      const total = Object.values(summary.imported).reduce((a, b) => a + b, 0);
      logger.info(
        total > 0 ? 'Shared store initialised from this instance\'s local data' : 'Shared store initialised (no local data to import)',
        summary.imported,
      );
      return 'initialised';
    }

    // Joining: a generated secret in this replica's state dir that isn't the
    // store's means its local data belongs to another install. Serving would
    // be fine, but the admin most likely meant to import that data.
    const localSecret = localGeneratedSessionSecret();
    const storedSecret = await store.kv.get(SHARED_SECRET_KEY);
    if (localSecret && storedSecret && localSecret !== storedSecret && !hasConfiguredSessionSecret()) {
      logger.error(
        'This instance has local data (a generated session secret in its state dir) from a single-instance ' +
        'install, but the shared store was already initialised without it. Its settings and plugin ' +
        'credentials could not be read. Either remove the local data dirs from this instance, or empty the ' +
        'shared store and start this instance first so it imports them. See the docs, "Running several instances".',
      );
      return 'blocked';
    }
    return 'joined';
  });
}

function startHeartbeat(version: string): void {
  const store = getStore();
  const info = { id: replicaId(), version, startedAt: Date.now() };
  const beat = () => void store.replicas.beat(info).catch(() => {});
  beat();
  setInterval(beat, HEARTBEAT_MS).unref();
}

export async function bootSharedMode(options: SharedBootOptions): Promise<void> {
  setBootState('starting');
  const store = getStore();
  logger.info('Using a shared store', { location: store.status().location, replica: replicaId() });
  await waitForStore();
  // A store that drops mid-boot is waited for again at each step.
  for (;;) {
    try {
      const result = await initialise(options);
      if (result === 'blocked') {
        setBootState('blocked');
        return;
      }
      await ensureSharedSessionSecret();
      if (!hasConfiguredSessionSecret()) {
        logger.warn(
          'No SESSION_SECRET set; using the one in the shared store. Set SESSION_SECRET on every replica, ' +
          'so a lost store does not sign everyone out and make stored settings unreadable.',
        );
      }
      // Baseline before loading, so a change during the load is seen.
      await markEpochsSeen();
      await options.load();
      break;
    } catch (error) {
      logger.warn('Shared store boot step failed; retrying', {
        error: error instanceof Error ? error.message : 'Unknown error',
      });
      await sleep(2000);
      await waitForStore();
    }
  }
  startChangePoller();
  startHeartbeat(options.version);
  setBootState('ready');
  logger.info('Shared store ready', { replica: replicaId() });
}
