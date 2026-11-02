import { logger } from '@/lib/logger';
import { readErrors, utcDay } from '@/lib/error-reporting/aggregate';
import { effectiveConsent, effectiveErrorsConsent, endpointEnabled, getInstanceId } from './state';
import { errorsForDay } from './payload';
import { fetchTelemetryTarget, resolveEndpointAllowed } from './endpoint-guard';
import { DEFAULT_ENDPOINT, errorsEndpointFor, type TelemetryErrorBatch } from './types';

/**
 * Instant error counts. With the error-count consent on "instant", the
 * scheduler leader posts the current UTC day's counts to the collector's
 * /v1/errors every TICK_MS. Only errors that are new or whose count bucket
 * changed since the last send go out, so a known error repeating doesn't
 * cause traffic until it reaches the next bucket. The daily heartbeat still
 * carries the complete day as before.
 *
 * Each tick reads the consent, so switching it in the admin takes effect on
 * the next tick without restarting anything. Other replicas' counts reach
 * the store with their own flush (every minute), so they go out a minute later.
 */

const TICK_MS = 60_000;

interface InstantState {
  timer: NodeJS.Timeout | null;
  /** The day `sent` is for. */
  day: string;
  /** `fingerprint|version` -> the count bucket last sent. */
  sent: Map<string, string>;
  running: Promise<void> | null;
}

// On globalThis, like the heartbeat timer: one per process, whichever
// module copy starts or stops it.
const KEY = Symbol.for('bulwark.telemetry.instant-errors');
function state(): InstantState {
  const g = globalThis as typeof globalThis & { [KEY]?: InstantState };
  return (g[KEY] ??= { timer: null, day: '', sent: new Map(), running: null });
}

async function tick(now: number): Promise<void> {
  const s = state();
  const { consent } = await effectiveErrorsConsent();
  if (consent !== 'instant') {
    s.sent.clear();
    return;
  }
  const { state: stored } = await effectiveConsent();
  const endpoint = stored.endpoint ?? DEFAULT_ENDPOINT;
  if (!endpointEnabled(endpoint)) return;
  let target: string;
  try {
    target = errorsEndpointFor(endpoint);
  } catch {
    return;
  }

  const day = utcDay(now);
  if (s.day !== day) {
    s.day = day;
    s.sent.clear();
  }
  const changed = errorsForDay(await readErrors(), day)
    .filter((error) => s.sent.get(`${error.fingerprint}|${error.version}`) !== error.count);
  if (changed.length === 0) return;

  // Checked at send time, like the heartbeat: defeats DNS rebinding and a
  // state file edited past the admin API.
  const guard = await resolveEndpointAllowed(target);
  if (!guard.ok) {
    logger.warn('telemetry: errors endpoint blocked', { reason: guard.reason });
    return;
  }

  const batch: TelemetryErrorBatch = { schema: '1', instance_id: await getInstanceId(), day, errors: changed };
  const res = await fetchTelemetryTarget(target, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(batch),
    signal: AbortSignal.timeout(5000),
  });
  if (!res.ok) {
    // Not marked as sent: the next tick tries them again.
    logger.warn('telemetry: instant error counts rejected', { status: res.status });
    return;
  }
  for (const error of changed) s.sent.set(`${error.fingerprint}|${error.version}`, error.count);
}

/** One tick: send what changed, if instant mode is on. Never throws. */
export function sendInstantErrors(now = Date.now()): Promise<void> {
  const s = state();
  if (s.running) return s.running;
  s.running = tick(now)
    .catch((error) => {
      logger.warn('telemetry: instant error counts failed', { error: error instanceof Error ? error.message : String(error) });
    })
    .finally(() => { s.running = null; });
  return s.running;
}

// Run by the scheduler leader (lib/scheduler-leader.ts). Idempotent.
export async function startInstantErrors(): Promise<void> {
  const s = state();
  if (s.timer) return;
  s.timer = setInterval(() => { void sendInstantErrors(); }, TICK_MS);
  s.timer.unref?.();
}

export async function stopInstantErrors(): Promise<void> {
  const s = state();
  if (s.timer) clearInterval(s.timer);
  s.timer = null;
  // A new leader starts from nothing and sends the day's counts once.
  s.sent.clear();
}

/** For tests. */
export function resetInstantErrorsForTests(): void {
  const s = state();
  if (s.timer) clearInterval(s.timer);
  const g = globalThis as typeof globalThis & { [KEY]?: InstantState };
  delete g[KEY];
}
