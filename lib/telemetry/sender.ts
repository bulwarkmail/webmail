import { logger } from '@/lib/logger';
import { effectiveConsent, endpointEnabled, loadState, saveState } from './state';
import { buildPayload } from './payload';
import { DEFAULT_ENDPOINT } from './types';

const DAY_MS = 24 * 60 * 60 * 1000;
const JITTER_MS = 2 * 60 * 60 * 1000; // ± 2 hours
const FIRST_DELAY_MS = 60 * 60 * 1000;  // 1 hour after consent

let currentTimer: NodeJS.Timeout | null = null;

function jitteredDelay(base: number): number {
  const j = (Math.random() * 2 - 1) * JITTER_MS;
  return Math.max(60_000, base + j);
}

export async function sendOnce(opts?: { reason?: string }): Promise<{
  ok: boolean;
  status?: number;
  error?: string;
}> {
  const { consent, source, state } = await effectiveConsent();
  if (consent !== 'on') return { ok: false, error: `consent ${consent} (source ${source})` };
  const endpoint = state.endpoint || DEFAULT_ENDPOINT;
  if (!endpointEnabled(endpoint)) return { ok: false, error: 'endpoint blank' };

  const payload = await buildPayload();
  try {
    const res = await fetch(endpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(5000),
    });
    const ok = res.ok;
    if (ok) {
      const next = await loadState();
      next.lastSentAt = new Date().toISOString();
      await saveState(next);
    }
    logger.info('telemetry: heartbeat', {
      ok, status: res.status, reason: opts?.reason ?? 'scheduled',
    });
    return { ok, status: res.status };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.warn('telemetry: heartbeat failed', { error: msg });
    return { ok: false, error: msg };
  }
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
  await sendOnce({ reason: 'scheduled' });
  await scheduleNext(jitteredDelay(DAY_MS));
}

// Called from instrumentation. Idempotent.
export async function startScheduler(): Promise<void> {
  const { consent } = await effectiveConsent();
  if (consent !== 'on') {
    logger.info('telemetry: scheduler not started', { consent });
    return;
  }
  const state = await loadState();
  // If we have a next-scheduled time in the future use it; otherwise schedule
  // FIRST_DELAY_MS out. This means after a restart we don't fire immediately.
  let delay = FIRST_DELAY_MS;
  if (state.nextScheduledAt) {
    const remaining = new Date(state.nextScheduledAt).getTime() - Date.now();
    if (remaining > 0) delay = Math.min(remaining, DAY_MS + JITTER_MS);
  }
  await scheduleNext(delay);
  logger.info('telemetry: scheduler started', {
    nextInMs: delay,
    endpoint: state.endpoint,
  });
}

export async function stopScheduler(): Promise<void> {
  if (currentTimer) clearTimeout(currentTimer);
  currentTimer = null;
}

// Called when consent flips on/off via the UI.
export async function reschedule(): Promise<void> {
  await stopScheduler();
  await startScheduler();
}
