import { logger } from '@/lib/logger';
import { isSharedMode } from '@/lib/shared-store';
import { announceChange } from '@/lib/shared-store/changes';
import {
  effectiveConsent, endpointEnabled, loadState, loadStateVersioned, saveStateIfUnchanged, updateState,
} from './state';
import { buildPayload } from './payload';
import { fetchTelemetryTarget, resolveEndpointAllowed } from './endpoint-guard';
import { DEFAULT_ENDPOINT } from './types';

const DAY_MS = 24 * 60 * 60 * 1000;
const JITTER_MS = 2 * 60 * 60 * 1000; // ± 2 hours
const FIRST_DELAY_MS = 60 * 60 * 1000;  // 1 hour after consent
/** A send this long before a scheduled slot already counts for that slot. */
const SLOT_SLACK_MS = 60 * 1000;
/**
 * With a shared store, a scheduled heartbeat this recent means the day's is
 * done. A new leader computes its own slot when the old one stalled past its
 * slot or died before storing the next one, so the slot alone can't tell.
 */
const SCHEDULED_GAP_MS = 20 * 60 * 60 * 1000;

// On globalThis: Next loads this module once per bundle (instrumentation,
// each route), and a reschedule from a route must clear the timer the
// instrumentation copy started, not a copy of its own.
const TIMER_KEY = Symbol.for('bulwark.telemetry.timer');
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

function jitteredDelay(base: number): number {
  const j = (Math.random() * 2 - 1) * JITTER_MS;
  return Math.max(60_000, base + j);
}

type Claim =
  | { claimed: true; previous: string | null; previousScheduled: string | null | undefined; at: string; shared: boolean }
  | { claimed: false };

/**
 * Take the scheduled send for `slot` (its nextScheduledAt): set lastSentAt
 * with a compare-and-set on the state, unless a send at or after the slot is
 * already recorded. Of two leaders firing for one slot (a handover after a
 * long pause), only one gets it.
 */
async function claimSlot(slot: string): Promise<Claim> {
  const slotMs = new Date(slot).getTime();
  const shared = isSharedMode();
  for (let attempt = 0; attempt < 5; attempt++) {
    const { state, version } = await loadStateVersioned();
    if (version === null) return { claimed: false };
    const last = state.lastSentAt ? new Date(state.lastSentAt).getTime() : NaN;
    if (!Number.isNaN(last) && last >= slotMs - SLOT_SLACK_MS) return { claimed: false };
    if (shared && state.lastScheduledSentAt) {
      const scheduled = new Date(state.lastScheduledSentAt).getTime();
      if (!Number.isNaN(scheduled) && Date.now() - scheduled < SCHEDULED_GAP_MS) return { claimed: false };
    }
    const at = new Date().toISOString();
    const next = shared ? { ...state, lastSentAt: at, lastScheduledSentAt: at } : { ...state, lastSentAt: at };
    if (await saveStateIfUnchanged(next, version)) {
      return { claimed: true, previous: state.lastSentAt, previousScheduled: state.lastScheduledSentAt, at, shared };
    }
  }
  return { claimed: false };
}

/** Give a claimed slot back after a failed send, unless another send landed meanwhile. */
async function releaseSlot(claim: Extract<Claim, { claimed: true }>): Promise<void> {
  await updateState((state) => {
    if (state.lastSentAt === claim.at) state.lastSentAt = claim.previous;
    if (claim.shared && state.lastScheduledSentAt === claim.at) state.lastScheduledSentAt = claim.previousScheduled ?? null;
  }).catch(() => {});
}

/**
 * Send one heartbeat. A scheduled send passes its `slot` and is skipped
 * when another replica already sent for it; the admin's "send now" passes
 * none and always sends.
 */
export async function sendOnce(opts?: { reason?: string; slot?: string }): Promise<{
  ok: boolean;
  status?: number;
  error?: string;
}> {
  // effectiveConsent() is off in the no-third-party mode, so this also stops
  // a manual "send now" before any request (#903).
  const { consent, source, state } = await effectiveConsent();
  if (consent !== 'on') return { ok: false, error: `consent ${consent} (source ${source})` };
  // A cleared collector URL is stored as '' and switches sending off; only a
  // state file without the field at all gets the project's collector.
  const endpoint = state.endpoint ?? DEFAULT_ENDPOINT;
  if (!endpointEnabled(endpoint)) return { ok: false, error: 'endpoint blank' };

  // Re-check at fetch time: defeats DNS rebinding, and catches the case
  // where state.json was edited out-of-band to bypass the admin API.
  const guard = await resolveEndpointAllowed(endpoint);
  if (!guard.ok) {
    logger.warn('telemetry: endpoint blocked', { reason: guard.reason });
    return { ok: false, error: `endpoint blocked: ${guard.reason}` };
  }

  let claim: Claim | null = null;
  if (opts?.slot) {
    claim = await claimSlot(opts.slot);
    if (!claim.claimed) {
      logger.info('telemetry: heartbeat skipped, already sent for this slot', { slot: opts.slot });
      return { ok: false, error: 'already sent' };
    }
  }

  try {
    // Inside the try: a payload that can't be built (store down) gives the
    // claimed slot back instead of losing the day's heartbeat.
    const payload = await buildPayload();
    // Never follows redirects: the endpoint guard only vetted the URL we
    // were given, so a 3xx to an internal host would bypass it.
    const res = await fetchTelemetryTarget(endpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(5000),
    });
    const ok = res.ok;
    if (ok && !claim) {
      const at = new Date().toISOString();
      await updateState((next) => { next.lastSentAt = at; });
    }
    if (!ok && claim?.claimed) await releaseSlot(claim);
    logger.info('telemetry: heartbeat', {
      ok, status: res.status, reason: opts?.reason ?? 'scheduled',
    });
    return { ok, status: res.status };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.warn('telemetry: heartbeat failed', { error: msg });
    if (claim?.claimed) await releaseSlot(claim);
    return { ok: false, error: msg };
  }
}

async function scheduleNext(delayMs: number, generation: number): Promise<void> {
  const t = timer();
  if (t.generation !== generation) return; // stopped meanwhile
  if (t.current) clearTimeout(t.current);
  const at = new Date(Date.now() + delayMs).toISOString();
  // The timer first: a state write that fails (store down) must not end
  // the chain of heartbeats.
  t.current = setTimeout(() => { void tick(at, generation); }, delayMs);
  // Don't keep the process alive just for this.
  t.current.unref?.();
  try {
    await updateState((state) => { state.nextScheduledAt = at; });
  } catch (err) {
    logger.warn('telemetry: could not store the schedule', { error: err instanceof Error ? err.message : String(err) });
  }
}

async function tick(slot: string, generation: number): Promise<void> {
  try {
    await sendOnce({ reason: 'scheduled', slot });
  } catch (err) {
    logger.warn('telemetry: heartbeat failed', { error: err instanceof Error ? err.message : String(err) });
  }
  await scheduleNext(jitteredDelay(DAY_MS), generation);
}

// Run by the scheduler leader (lib/scheduler-leader.ts). Idempotent.
export async function startScheduler(): Promise<void> {
  const generation = timer().generation;
  const { consent } = await effectiveConsent();
  if (consent !== 'on') {
    logger.info('telemetry: scheduler not started', { consent });
    return;
  }
  const state = await loadState();
  if (!endpointEnabled(state.endpoint ?? DEFAULT_ENDPOINT)) {
    logger.info('telemetry: scheduler not started', { consent, endpoint: 'blank' });
    return;
  }
  // If we have a next-scheduled time in the future use it; otherwise schedule
  // FIRST_DELAY_MS out. This means after a restart we don't fire immediately.
  let delay = FIRST_DELAY_MS;
  if (state.nextScheduledAt) {
    const remaining = new Date(state.nextScheduledAt).getTime() - Date.now();
    if (remaining > 0) delay = Math.min(remaining, DAY_MS + JITTER_MS);
  }
  await scheduleNext(delay, generation);
  logger.info('telemetry: scheduler started', {
    nextInMs: delay,
    endpoint: state.endpoint,
  });
}

export async function stopScheduler(): Promise<void> {
  const t = timer();
  t.generation++;
  if (t.current) clearTimeout(t.current);
  t.current = null;
}

// Called when consent flips on/off or the collector URL changes via the UI.
// The replica that runs the jobs (any replica's change reaches it) restarts
// the timer from the stored state; in local mode that is this process, at once.
export async function reschedule(): Promise<void> {
  await announceChange('telemetry');
}
