import { logger } from '@/lib/logger';
import { telemetryDocs } from '@/lib/telemetry/state';
import { isErrorCode } from './envelope';
import { fingerprint as fingerprintOf } from './fingerprint';
import type { Frame } from './stack';
import { debugIdsByPath } from './debug-ids';

/**
 * Errors counted per UTC day: fingerprint -> name, top frames, version and
 * how often. The admin's "errors today", the metrics endpoint and the
 * telemetry error counts read it. Only what scrubbing leaves goes in.
 *
 * Bounded: MAX_PER_DAY fingerprints per day (the rarest go first) and
 * KEEP_DAYS days. Counts gather in memory and are added to `errors.json` in
 * telemetry's document collection every FLUSH_MS, so several replicas add up
 * (an update, not an overwrite).
 */

export const MAX_PER_DAY = 200;
export const KEEP_DAYS = 8;
export const MAX_FRAMES_KEPT = 5;
const FLUSH_MS = 60_000;
export const ERRORS_DOC = 'errors.json';

export interface AggregateEntry {
  name: string;
  frames: Frame[];
  version: string;
  /** A fixed error code when the error has one. */
  code?: string;
  runtime: 'browser' | 'server';
  count: number;
}

/** day (YYYY-MM-DD) -> fingerprint -> entry */
export type Aggregate = Record<string, Record<string, AggregateEntry>>;

export interface Recordable {
  name: string;
  frames: Frame[];
  code?: string;
}

interface AggregateState {
  pending: Aggregate;
  timer: ReturnType<typeof setInterval> | null;
  flushing: Promise<void> | null;
}

const KEY = Symbol.for('bulwark.error-reporting.aggregate');
function state(): AggregateState {
  const g = globalThis as typeof globalThis & { [KEY]?: AggregateState };
  return (g[KEY] ??= { pending: {}, timer: null, flushing: null });
}

export function utcDay(at = Date.now()): string {
  return new Date(at).toISOString().slice(0, 10);
}

/** Keep the newest KEEP_DAYS days and the MAX_PER_DAY most frequent per day. */
export function bound(agg: Aggregate, today = utcDay()): Aggregate {
  const cutoff = utcDay(Date.parse(`${today}T00:00:00Z`) - (KEEP_DAYS - 1) * 86_400_000);
  const out: Aggregate = {};
  for (const [day, entries] of Object.entries(agg)) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(day) || day < cutoff) continue;
    const kept = Object.entries(entries)
      .sort(([, a], [, b]) => b.count - a.count)
      .slice(0, MAX_PER_DAY);
    out[day] = Object.fromEntries(kept);
  }
  return out;
}

/** Add `delta`'s counts to `base`. */
export function merge(base: Aggregate, delta: Aggregate): Aggregate {
  const out: Aggregate = {};
  for (const [day, entries] of Object.entries(base)) out[day] = { ...entries };
  for (const [day, entries] of Object.entries(delta)) {
    const target = (out[day] ??= {});
    for (const [print, entry] of Object.entries(entries)) {
      const existing = target[print];
      target[print] = existing ? { ...existing, count: existing.count + entry.count } : { ...entry };
    }
  }
  return out;
}

function parseStored(data: Buffer | null): Aggregate {
  if (!data) return {};
  try {
    const parsed = JSON.parse(data.toString('utf8')) as unknown;
    return parsed && typeof parsed === 'object' ? (parsed as Aggregate) : {};
  } catch {
    return {};
  }
}

/** Count one error. Returns its fingerprint. */
export function recordError(report: Recordable, runtime: 'browser' | 'server', version: string, at = Date.now()): string {
  const print = fingerprintOf(report.name, report.frames, version, report.code);
  const s = state();
  const day = utcDay(at);
  const entries = (s.pending[day] ??= {});
  const existing = entries[print];
  if (existing) {
    existing.count += 1;
  } else if (Object.keys(entries).length < MAX_PER_DAY) {
    entries[print] = {
      name: report.name,
      // The server's own bundle files get this process's debug IDs; browser
      // frames bring theirs along.
      frames: report.frames.slice(0, MAX_FRAMES_KEPT).map((frame) => {
        if (frame.debugId) return frame;
        const id = runtime === 'server' ? debugIdsByPath().get(frame.path) : undefined;
        return id ? { ...frame, debugId: id } : frame;
      }),
      version,
      ...(isErrorCode(report.code) ? { code: report.code } : {}),
      runtime,
      count: 1,
    };
  }
  startTimer();
  return print;
}

function startTimer(): void {
  const s = state();
  if (s.timer) return;
  s.timer = setInterval(() => { void flushErrors(); }, FLUSH_MS);
  s.timer.unref?.();
}

/** Add what this process counted since the last flush to the stored aggregate. */
export function flushErrors(): Promise<void> {
  const s = state();
  if (s.flushing) return s.flushing;
  const delta = s.pending;
  if (Object.keys(delta).length === 0) return Promise.resolve();
  s.pending = {};
  s.flushing = telemetryDocs()
    .update(ERRORS_DOC, (current) => JSON.stringify(bound(merge(parseStored(current), delta))))
    .then(() => undefined)
    .catch((error) => {
      // Keep the counts for the next try.
      s.pending = merge(delta, s.pending);
      logger.warn('error counts not stored', { error: error instanceof Error ? error.message : String(error) });
    })
    .finally(() => { s.flushing = null; });
  return s.flushing;
}

/** The stored aggregate with this process's unflushed counts added. */
export async function readErrors(): Promise<Aggregate> {
  let stored: Aggregate = {};
  try {
    stored = parseStored((await telemetryDocs().get(ERRORS_DOC))?.data ?? null);
  } catch (error) {
    logger.warn('error counts not readable', { error: error instanceof Error ? error.message : String(error) });
  }
  return bound(merge(stored, state().pending));
}

export interface DaySummary {
  total: number;
  top: Array<{ fingerprint: string } & AggregateEntry>;
}

export function summarizeDay(agg: Aggregate, day = utcDay(), limit = 20): DaySummary {
  const entries = Object.entries(agg[day] ?? {});
  return {
    total: entries.reduce((sum, [, e]) => sum + e.count, 0),
    top: entries
      .sort(([, a], [, b]) => b.count - a.count)
      .slice(0, limit)
      .map(([fingerprint, e]) => ({ fingerprint, ...e })),
  };
}

/** For tests. */
export function resetAggregateForTests(): void {
  const s = state();
  if (s.timer) clearInterval(s.timer);
  const g = globalThis as typeof globalThis & { [KEY]?: AggregateState };
  delete g[KEY];
}
