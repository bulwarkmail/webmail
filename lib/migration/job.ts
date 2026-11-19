import { getStore, replicaId } from '@/lib/shared-store';
import { logger } from '@/lib/logger';
import { deleteAppPassword } from '@/lib/impersonation/app-password';
import { PassStoppedError, runAccountPass } from './engine';
import { accountSources, basicAuth, logMigration, migrationDeps, MigrationSetupError, targetAuthHeader } from './runtime';
import { decryptSecret } from './secrets';
import {
  accountEngineStore,
  isRunning,
  listAccounts,
  listMigrations,
  loadAccount,
  loadMigration,
  loadOptions,
  migrationVersion,
  updateAccount,
  updateMigration,
  type MigrationDoc,
} from './store';

/**
 * The `mailbox-migration` scheduled job (lib/scheduler-leader.ts): runs only
 * on the scheduler leader and keeps all its state in the shared store, so a
 * restart or a new leader picks the running accounts up where they stopped.
 *
 * Every few seconds it looks for accounts with work (queued, or a pass cut
 * off by a stop), and copies up to "Accounts copied at the same time" of
 * them at once. Each account it copies holds a lease, so an old leader that
 * hasn't noticed it lost the scheduler lease can't copy the same account
 * alongside the new one. It also forgets the stored passwords of migrations
 * whose last pass is older than "Forget source passwords after".
 */

export const JOB_NAME = 'mailbox-migration';
export const TICK_MS = 5_000;
const ACCOUNT_LEASE_MS = 60_000;
const STOP_WAIT_MS = 60_000;
const DAY_MS = 24 * 60 * 60 * 1000;

interface Runner {
  done: Promise<void>;
}

interface JobGlobals {
  timer?: NodeJS.Timeout;
  controller?: AbortController;
  runners: Map<string, Runner>;
  ticking?: Promise<void>;
  /** Migrations found without work, by the version of their document then. */
  idle: Map<string, string>;
}

const KEY = Symbol.for('bulwark.migrationJob');

function globals(): JobGlobals {
  const g = globalThis as typeof globalThis & { [KEY]?: JobGlobals };
  return (g[KEY] ??= { runners: new Map(), idle: new Map() });
}

function leaseName(migrationId: string, key: string): string {
  return `migration-${migrationId}-${key}`.replace(/[^a-z0-9-]/g, '-').slice(0, 64);
}

/** Delete a self-service migration's app password on Stalwart. Best effort: it expires anyway. */
export async function dropAppPassword(migration: MigrationDoc): Promise<void> {
  const secret = decryptSecret(migration.appPassword?.secretEnc);
  if (!secret || !migration.appPassword || !migration.owner) return;
  try {
    await deleteAppPassword({ serverUrl: migration.serverUrl, authHeader: basicAuth(migration.owner.username, secret), id: migration.appPassword.id });
  } catch {
    logMigration('app password not deleted; it expires on its own', { migration: migration.id });
  }
}

/** When a migration's stored passwords go: "Forget source passwords after" days after its last pass. */
export function forgetAt(migration: Pick<MigrationDoc, 'lastPassAt'>, days: number): number {
  return migration.lastPassAt + days * DAY_MS;
}

/** Delete every stored password of a migration and its app password. The report stays. */
export async function forgetCredentials(migration: MigrationDoc, now: number): Promise<void> {
  await dropAppPassword(migration);
  for (const account of await listAccounts(migration.id)) {
    if (account.passwordEnc) {
      await updateAccount(migration.id, account.key, (doc) => {
        const next = { ...doc };
        delete next.passwordEnc;
        return next;
      });
    }
  }
  await updateMigration(migration.id, (doc) => ({
    ...doc,
    ...(doc.appPassword ? { appPassword: { id: doc.appPassword.id, expiresAt: doc.appPassword.expiresAt } } : {}),
    credentialsForgottenAt: doc.credentialsForgottenAt ?? now,
  }));
}

async function runAccount(migrationId: string, key: string, signal: AbortSignal): Promise<void> {
  const holder = replicaId();
  const lease = leaseName(migrationId, key);
  const store = getStore();
  if (!(await store.leases.acquire(lease, holder, ACCOUNT_LEASE_MS))) return;
  const renew = setInterval(() => void store.leases.acquire(lease, holder, ACCOUNT_LEASE_MS).catch(() => {}), ACCOUNT_LEASE_MS / 3);
  renew.unref();
  try {
    const migration = await loadMigration(migrationId);
    const account = await loadAccount(migrationId, key);
    if (!migration || !account || !isRunning(account)) return;
    const engineStore = accountEngineStore(migrationId, key);
    if (account.cancelRequested && account.status === 'queued') {
      await engineStore.save({ ...account, status: 'cancelled' });
      return;
    }
    const deps = migrationDeps();
    try {
      const sources = await accountSources(migration, account);
      const auth = targetAuthHeader(migration, account, deps.clock.now());
      logMigration('copying account', { migration: migrationId, account: key, status: account.status });
      await runAccountPass({
        what: migration.what,
        sources,
        target: () => deps.openTarget(migration.serverUrl, auth),
        state: account,
        store: engineStore,
        signal,
        clock: deps.clock,
      });
      logMigration('account pass ended', { migration: migrationId, account: key, status: account.status });
    } catch (error) {
      if (error instanceof PassStoppedError) {
        logMigration('account pass stopped; it resumes on the next leader', { migration: migrationId, account: key });
        return;
      }
      if (!(error instanceof MigrationSetupError)) throw error;
      await engineStore.save({
        ...account,
        status: 'failed',
        error: error.message,
        ...(error.code ? { errorCode: error.code } : {}),
        passFinishedAt: deps.clock.now(),
      });
    }
  } catch (error) {
    // The stored state stays as it was; the next tick tries this account again.
    logger.warn('migration: account run failed', { migration: migrationId, account: key, error: error instanceof Error ? error.name : 'Error' });
  } finally {
    clearInterval(renew);
    await store.leases.release(lease, holder).catch(() => {});
  }
}

function startRunner(g: JobGlobals, migrationId: string, key: string, signal: AbortSignal): void {
  const id = `${migrationId}/${key}`;
  const done = runAccount(migrationId, key, signal).finally(() => {
    g.runners.delete(id);
    // A finished account may free a slot for the next one at once.
    if (!signal.aborted) void tick();
  });
  g.runners.set(id, { done });
}

/** One look for work. Exported for tests. */
export async function tick(): Promise<void> {
  const g = globals();
  if (!g.controller || g.controller.signal.aborted) return;
  if (g.ticking) return g.ticking;
  const signal = g.controller.signal;
  g.ticking = (async () => {
    const options = await loadOptions();
    const now = migrationDeps().clock.now();
    for (const migration of await listMigrations()) {
      if (signal.aborted) return;
      if (migration.finishedAt) continue;
      const version = await migrationVersion(migration.id);
      if (version && g.idle.get(migration.id) === version && !hasRunner(g, migration.id)) {
        // Nothing asked for work since the last scan found none; only the password expiry is left.
        await expireIfDue(migration, options.forgetAfterDays, now, g);
        continue;
      }
      const accounts = await listAccounts(migration.id);
      const waiting = accounts.filter((a) => isRunning(a) && !g.runners.has(`${migration.id}/${a.key}`));
      const due = waiting.filter((a) => a.status !== 'paused' || (a.pausedUntil ?? 0) <= now);
      for (const account of due) {
        if (g.runners.size >= options.concurrency || signal.aborted) break;
        startRunner(g, migration.id, account.key, signal);
      }
      if (waiting.length === 0 && !hasRunner(g, migration.id) && version) {
        g.idle.set(migration.id, version);
        await expireIfDue(migration, options.forgetAfterDays, now, g);
      } else {
        g.idle.delete(migration.id);
      }
    }
  })()
    .catch((error) => {
      logger.warn('migration: could not look for work', { error: error instanceof Error ? error.message : String(error) });
    })
    .finally(() => {
      g.ticking = undefined;
    });
  return g.ticking;
}

function hasRunner(g: JobGlobals, migrationId: string): boolean {
  for (const id of g.runners.keys()) if (id.startsWith(`${migrationId}/`)) return true;
  return false;
}

async function expireIfDue(migration: MigrationDoc, days: number, now: number, g: JobGlobals): Promise<void> {
  if (migration.credentialsForgottenAt || now < forgetAt(migration, days)) return;
  await forgetCredentials(migration, now);
  g.idle.delete(migration.id);
  logMigration('stored passwords deleted after the configured days', { migration: migration.id });
}

/** ScheduledJob.start: idempotent. */
export async function startMigrationJob(): Promise<void> {
  const g = globals();
  if (g.timer) return;
  g.controller = new AbortController();
  g.idle.clear();
  g.timer = setInterval(() => void tick(), TICK_MS);
  g.timer.unref();
  void tick();
}

/** ScheduledJob.stop: running accounts stop after their current batch and resume on the next start. */
export async function stopMigrationJob(): Promise<void> {
  const g = globals();
  if (g.timer) clearInterval(g.timer);
  g.timer = undefined;
  g.controller?.abort();
  const pending = [...g.runners.values()].map((r) => r.done);
  if (g.ticking) pending.push(g.ticking);
  if (pending.length > 0) {
    let timer: NodeJS.Timeout | undefined;
    await Promise.race([
      Promise.allSettled(pending),
      new Promise((resolve) => { timer = setTimeout(resolve, STOP_WAIT_MS); timer.unref?.(); }),
    ]);
    if (timer) clearTimeout(timer);
  }
}

/** Resolves when the runners started so far are done (tests). */
export async function migrationJobSettled(): Promise<void> {
  const g = globals();
  for (let i = 0; i < 100; i++) {
    const pending = [...g.runners.values()].map((r) => r.done);
    if (g.ticking) pending.push(g.ticking);
    if (pending.length === 0) return;
    await Promise.allSettled(pending);
  }
}

export function isMigrationJobRunning(): boolean {
  return !!globals().timer;
}

export const migrationJob = { name: JOB_NAME, start: startMigrationJob, stop: stopMigrationJob };
