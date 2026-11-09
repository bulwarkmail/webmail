import { logger } from '@/lib/logger';
import {
  disabledByEnv, effectiveEndpoint, freshStatus, getCurrentVersion, isStatusStale, loadState, saveState,
  updateState, withVersionStatus,
} from './state';
import { isSharedMode } from '@/lib/shared-store';
import { fetchStatus } from './fetcher';
import type { UpdateStatus } from './types';
import { isNoThirdPartyTrafficOn } from '@/lib/admin/third-party-mode';

const HOUR_MS = 60 * 60 * 1000;
const JITTER_MS = 5 * 60 * 1000;       // ± 5 min, keeps containers from syncing
const FIRST_DELAY_MS = 30 * 1000;       // first check ~30s after boot
const FAILURE_BACKOFF_MS = 15 * 60 * 1000; // after a failed fetch, retry in 15 min

// On globalThis: Next loads this module once per bundle (instrumentation,
// each route), and a reschedule from a route must clear the timer the
// instrumentation copy started, not a copy of its own.
const TIMER_KEY = Symbol.for('bulwark.versionCheck.timer');
/**
 * `generation` goes up on every stop. A start or a tick captures it and
 * arms a timer only while it is unchanged, so a check or send still in
 * flight when the scheduler stops (this replica lost the lead) can't set a
 * new timer afterwards.
 */
interface TimerState { current: NodeJS.Timeout | null; generation: number }
function timer(): TimerState {
  const g = globalThis as typeof globalThis & { [TIMER_KEY]?: TimerState };
  return (g[TIMER_KEY] ??= { current: null, generation: 0 });
}

/** What checkOnce reports while NO_THIRD_PARTY_TRAFFIC is on. */
export const NO_THIRD_PARTY_ERROR = 'off: no third-party traffic';

function jitteredDelay(base: number): number {
  const j = (Math.random() * 2 - 1) * JITTER_MS;
  return Math.max(60_000, base + j);
}

export async function checkOnce(opts?: { reason?: string }): Promise<{
  ok: boolean;
  status?: UpdateStatus;
  error?: string;
}> {
  if (disabledByEnv()) return { ok: false, error: 'disabled by env' };
  if (await isNoThirdPartyTrafficOn()) return { ok: false, error: NO_THIRD_PARTY_ERROR };

  const state = await loadState();
  const endpoint = effectiveEndpoint(state);
  if (!endpoint) return { ok: false, error: 'endpoint blank' };

  const current = getCurrentVersion();
  if (!current) return { ok: false, error: 'current version unset' };

  const now = new Date().toISOString();
  const result = await fetchStatus(endpoint, current);

  const shared = isSharedMode();
  await updateState((next) => {
    next.lastCheckedAt = now;
    if (result.ok) {
      next.lastSuccessAt = now;
      next.status = result.status;
      if (shared) next.statuses = withVersionStatus(next.statuses, result.status);
    }
  });

  logger.info('version-check: ran', {
    ok: result.ok,
    severity: result.ok ? result.status.severity : null,
    reason: opts?.reason ?? 'scheduled',
  });

  if (result.ok) return { ok: true, status: result.status };
  return { ok: false, error: result.error };
}

async function scheduleNext(delayMs: number, generation: number): Promise<void> {
  const t = timer();
  if (t.generation !== generation) return; // stopped meanwhile
  if (t.current) clearTimeout(t.current);
  const at = new Date(Date.now() + delayMs).toISOString();
  // The timer first: a state write that fails (store down) must not end
  // the chain of checks.
  t.current = setTimeout(() => { void tick(generation); }, delayMs);
  // Don't keep the process alive just for this.
  t.current.unref?.();
  try {
    await updateState((state) => { state.nextScheduledAt = at; });
  } catch (err) {
    logger.warn('version-check: could not store the schedule', { error: err instanceof Error ? err.message : String(err) });
  }
}

async function tick(generation: number): Promise<void> {
  const result = await checkOnce({ reason: 'scheduled' }).catch((err: unknown) => ({
    ok: false as const, error: err instanceof Error ? err.message : String(err),
  }));
  // The scheduler keeps running while third-party traffic is off, so turning
  // the switch off at runtime resumes the checks; checkOnce skips meanwhile.
  const skipped = result.error === NO_THIRD_PARTY_ERROR;
  const delay = result.ok || skipped ? jitteredDelay(HOUR_MS) : FAILURE_BACKOFF_MS;
  await scheduleNext(delay, generation);
}

// Run by the scheduler leader (lib/scheduler-leader.ts). Idempotent - safe
// to call from instrumentation hot-reload in dev.
export async function startScheduler(): Promise<void> {
  const generation = timer().generation;
  if (disabledByEnv()) {
    logger.info('version-check: scheduler not started (disabled by env)');
    return;
  }
  const state = await loadState();
  if (!effectiveEndpoint(state)) {
    logger.info('version-check: scheduler not started (no endpoint)');
    return;
  }
  // State carried over from a previous build: the cached status is about a
  // version we no longer run, and its schedule would keep that stale answer
  // (e.g. "update available" for the version we just upgraded from) on screen
  // for up to an hour. Drop it and check promptly instead (#913).
  // With a shared store, replicas on another version may still be serving
  // that status: keep it, and only check promptly when there is none for
  // this version yet.
  const shared = isSharedMode();
  const stale = shared ? !freshStatus(state) && state.status !== null : isStatusStale(state.status);
  if (stale && !shared) {
    logger.info('version-check: discarding status from a previous version', {
      cached: state.status?.current ?? null,
      running: getCurrentVersion(),
    });
    state.status = null;
    state.nextScheduledAt = null;
    await saveState(state);
  }

  // If a previous schedule was still in the future, honor it (don't blast on
  // every restart). Cap at one hour so a wildly-in-the-future timestamp can't
  // permanently silence the check.
  let delay = FIRST_DELAY_MS;
  if (!stale && state.nextScheduledAt) {
    const remaining = new Date(state.nextScheduledAt).getTime() - Date.now();
    if (remaining > 0) delay = Math.min(remaining, HOUR_MS + JITTER_MS);
  }
  await scheduleNext(delay, generation);
  logger.info('version-check: scheduler started', { nextInMs: delay });
}

export async function stopScheduler(): Promise<void> {
  const t = timer();
  t.generation++;
  if (t.current) clearTimeout(t.current);
  t.current = null;
}
