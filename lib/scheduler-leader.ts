import { logger } from '@/lib/logger';
import { getStore, isSharedMode, replicaId } from '@/lib/shared-store';
import { onSharedChange, storeLostItsData } from '@/lib/shared-store/changes';

/**
 * One replica runs the background jobs (telemetry heartbeat, update check)
 * for the whole deployment (#1066). It holds the `scheduler-leader` lease,
 * renewing it every 10 s; every other replica tries to take it every 10 s,
 * so when the leader dies or loses the store another one takes over within
 * the 30 s lease plus one try. A leader that can't renew stops its jobs at
 * once. The jobs keep their schedule in the shared state, so a new leader
 * continues it instead of starting over.
 *
 * Local mode: the one process is always the leader.
 *
 * Everything lives on globalThis: instrumentation starts it, and the
 * `telemetry` change listener may be run from a route's module copy.
 */

export const LEADER_LEASE = 'scheduler-leader';
export const LEADER_TTL_MS = 30_000;
export const LEADER_TRY_MS = 10_000;

export interface ScheduledJob {
  name: string;
  /** Start the job's timer from its stored schedule. Must be idempotent. */
  start(): Promise<void>;
  stop(): Promise<void>;
}

interface LeaderGlobals {
  jobs: ScheduledJob[];
  /** Jobs whose start went through while leading; the others are retried on each renewal. */
  started: Set<string>;
  leading: boolean;
  interval?: NodeJS.Timeout;
  trying?: Promise<boolean>;
  unlisten?: () => void;
}

const KEY = Symbol.for('bulwark.schedulerLeader');

function globals(): LeaderGlobals {
  const g = globalThis as typeof globalThis & { [KEY]?: LeaderGlobals };
  return (g[KEY] ??= { jobs: [], started: new Set(), leading: false });
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** True while this process runs the background jobs. */
export function isSchedulerLeader(): boolean {
  return globals().leading;
}

async function startJobs(g: LeaderGlobals): Promise<void> {
  for (const job of g.jobs) {
    if (g.started.has(job.name)) continue;
    try {
      await job.start();
      // Stepped down while it started: don't leave its timer running.
      if (g.leading) g.started.add(job.name);
      else await job.stop();
    } catch (error) {
      logger.warn('scheduler: could not start a job; retrying', { job: job.name, error: message(error) });
    }
  }
}

async function stopJobs(g: LeaderGlobals): Promise<void> {
  g.started.clear();
  for (const job of g.jobs) {
    try {
      await job.stop();
    } catch (error) {
      logger.warn('scheduler: could not stop a job', { job: job.name, error: message(error) });
    }
  }
}

async function becomeLeader(g: LeaderGlobals): Promise<void> {
  g.leading = true;
  logger.info('scheduler: leading', { replica: replicaId() });
  await startJobs(g);
}

async function stepDown(g: LeaderGlobals, reason: string): Promise<void> {
  g.leading = false;
  logger.info('scheduler: stopped leading', { replica: replicaId(), reason });
  await stopJobs(g);
}

/**
 * One try: take or renew the lease, start the jobs on taking it, stop them
 * on losing it (or on not reaching the store). Returns whether this replica
 * leads afterwards.
 */
export async function tryLead(): Promise<boolean> {
  const g = globals();
  if (g.trying) return g.trying;
  g.trying = (async () => {
    let holds: boolean;
    let reason = 'another replica holds the lease';
    if (storeLostItsData()) {
      // The store was emptied under us: a lease taken there now proves
      // nothing, and the jobs' stored schedule is gone. Wait for it back.
      holds = false;
      reason = 'the shared store lost its data';
    } else {
      try {
        holds = await getStore().leases.acquire(LEADER_LEASE, replicaId(), LEADER_TTL_MS);
      } catch (error) {
        holds = false;
        reason = `could not reach the shared store: ${message(error)}`;
      }
    }
    if (holds && !g.leading) await becomeLeader(g);
    else if (holds) await startJobs(g);
    else if (g.leading) await stepDown(g, reason);
    return g.leading;
  })().finally(() => {
    g.trying = undefined;
  });
  return g.trying;
}

/** Restart one job on the leader (its settings changed), keeping its stored schedule. */
async function restartJob(name: string): Promise<void> {
  const g = globals();
  if (!g.leading) return;
  const job = g.jobs.find((j) => j.name === name);
  if (!job) return;
  g.started.delete(name);
  await job.stop();
  await job.start();
  if (g.leading) g.started.add(name);
  else await job.stop();
}

/**
 * Start leading or trying to (instrumentation, once per process). In shared
 * mode every replica calls it; only the lease holder runs `jobs`.
 */
export async function startSchedulerLeader(jobs: ScheduledJob[]): Promise<void> {
  const g = globals();
  g.jobs = jobs;
  // Consent or the collector changed on some replica: the leader picks it up.
  g.unlisten ??= onSharedChange('telemetry', () => restartJob('telemetry'));
  if (!isSharedMode()) {
    if (!g.leading) await becomeLeader(g);
    return;
  }
  if (!g.interval) {
    g.interval = setInterval(() => void tryLead(), LEADER_TRY_MS);
    g.interval.unref();
  }
  await tryLead();
}

/** Stop the jobs and give the lease up (shutdown, tests). */
export async function stopSchedulerLeader(): Promise<void> {
  const g = globals();
  if (g.interval) clearInterval(g.interval);
  g.interval = undefined;
  g.unlisten?.();
  g.unlisten = undefined;
  if (g.leading) {
    if (isSharedMode()) await getStore().leases.release(LEADER_LEASE, replicaId()).catch(() => {});
    await stepDown(g, 'stopped');
  }
}

/** Resolves when the current try (and the job starts it set off) is done (tests). */
export function schedulerLeaderSettled(): Promise<unknown> {
  return globals().trying ?? Promise.resolve();
}

/** Forget everything (tests). */
export function resetSchedulerLeaderForTests(): void {
  const g = globals();
  if (g.interval) clearInterval(g.interval);
  g.unlisten?.();
  const holder = globalThis as typeof globalThis & { [KEY]?: LeaderGlobals };
  delete holder[KEY];
}
