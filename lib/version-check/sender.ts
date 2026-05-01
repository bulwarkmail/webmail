import { logger } from '@/lib/logger';
import { disabledByEnv, effectiveEndpoint, loadState, saveState } from './state';
import { fetchStatus } from './fetcher';
import type { UpdateStatus } from './types';

const HOUR_MS = 60 * 60 * 1000;
const JITTER_MS = 5 * 60 * 1000;       // ± 5 min, keeps containers from syncing
const FIRST_DELAY_MS = 30 * 1000;       // first check ~30s after boot
const FAILURE_BACKOFF_MS = 15 * 60 * 1000; // after a failed fetch, retry in 15 min

let currentTimer: NodeJS.Timeout | null = null;

function jitteredDelay(base: number): number {
  const j = (Math.random() * 2 - 1) * JITTER_MS;
  return Math.max(60_000, base + j);
}

function getCurrentVersion(): string {
  return (process.env.NEXT_PUBLIC_APP_VERSION || '').trim();
}

export async function checkOnce(opts?: { reason?: string }): Promise<{
  ok: boolean;
  status?: UpdateStatus;
  error?: string;
}> {
  if (disabledByEnv()) return { ok: false, error: 'disabled by env' };

  const state = await loadState();
  const endpoint = effectiveEndpoint(state);
  if (!endpoint) return { ok: false, error: 'endpoint blank' };

  const current = getCurrentVersion();
  if (!current) return { ok: false, error: 'current version unset' };

  const now = new Date().toISOString();
  const result = await fetchStatus(endpoint, current);

  const next = await loadState();
  next.lastCheckedAt = now;
  if (result.ok) {
    next.lastSuccessAt = now;
    next.status = result.status;
  }
  await saveState(next);

  logger.info('version-check: ran', {
    ok: result.ok,
    severity: result.ok ? result.status.severity : null,
    reason: opts?.reason ?? 'scheduled',
  });

  if (result.ok) return { ok: true, status: result.status };
  return { ok: false, error: result.error };
}

async function scheduleNext(delayMs: number): Promise<void> {
  if (currentTimer) clearTimeout(currentTimer);
  const at = new Date(Date.now() + delayMs).toISOString();
  const state = await loadState();
  state.nextScheduledAt = at;
  await saveState(state);
  currentTimer = setTimeout(() => { void tick(); }, delayMs);
  // Don't keep the process alive just for this.
  currentTimer.unref?.();
}

async function tick(): Promise<void> {
  const result = await checkOnce({ reason: 'scheduled' });
  const delay = result.ok ? jitteredDelay(HOUR_MS) : FAILURE_BACKOFF_MS;
  await scheduleNext(delay);
}

// Idempotent — safe to call from instrumentation hot-reload in dev.
export async function startScheduler(): Promise<void> {
  if (disabledByEnv()) {
    logger.info('version-check: scheduler not started (disabled by env)');
    return;
  }
  const state = await loadState();
  if (!effectiveEndpoint(state)) {
    logger.info('version-check: scheduler not started (no endpoint)');
    return;
  }
  // If a previous schedule was still in the future, honor it (don't blast on
  // every restart). Cap at one hour so a wildly-in-the-future timestamp can't
  // permanently silence the check.
  let delay = FIRST_DELAY_MS;
  if (state.nextScheduledAt) {
    const remaining = new Date(state.nextScheduledAt).getTime() - Date.now();
    if (remaining > 0) delay = Math.min(remaining, HOUR_MS + JITTER_MS);
  }
  await scheduleNext(delay);
  logger.info('version-check: scheduler started', { nextInMs: delay });
}

export async function stopScheduler(): Promise<void> {
  if (currentTimer) clearTimeout(currentTimer);
  currentTimer = null;
}
