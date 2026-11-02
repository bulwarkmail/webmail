import { configManager } from '@/lib/admin/config-manager';
import { recordError } from './aggregate';
import {
  appVersion, buildEnvelope, buildEvent, envelopeUrl, newEventId, parseDsn, releaseName, type ErrorReport,
} from './envelope';
import { fingerprint } from './fingerprint';
import { ReportLimiter } from './limiter';
import { errorReportingSettings, shouldCollectErrors } from './settings';
import { scrubName, scrubText } from './scrub';
import { parseStack, type Frame } from './stack';
import { debugIdsByPath } from './debug-ids';

/**
 * Error reporting on the server: errors Next hands to onRequestError
 * (instrumentation.ts) and errors routes catch and log with logger.error.
 * While collection is on (a DSN, the metrics endpoint or error-count
 * consent, lib/error-reporting/settings.ts) every one is counted in the
 * per-day aggregate; with a DSN it is also sent there, at most once an hour
 * per fingerprint and 60 a minute. Sending never blocks or fails the request
 * that had the error. With everything off nothing happens at all.
 */

const SEND_TIMEOUT_MS = 5000;
const ROUTE_PATTERN = /^\/[\w/[\]().@-]*$/;

interface ServerState {
  limiter: ReportLimiter;
  sending: number;
}

const KEY = Symbol.for('bulwark.error-reporting.server');
function state(): ServerState {
  const g = globalThis as typeof globalThis & { [KEY]?: ServerState };
  return (g[KEY] ??= {
    limiter: new ReportLimiter({ perMinute: 60, perSession: Number.POSITIVE_INFINITY, dedupWindowMs: 60 * 60_000 }),
    sending: 0,
  });
}

async function deliver(report: ErrorReport): Promise<void> {
  if (!(await shouldCollectErrors())) return;
  const version = appVersion();
  recordError(report, 'server', version);
  const settings = errorReportingSettings();
  const dsn = parseDsn(settings.dsn);
  if (!dsn) return;
  const print = fingerprint(report.name, report.frames, version, report.code);
  const s = state();
  if (s.sending > 4 || !s.limiter.allow(print)) return;
  if (Math.random() >= settings.sampleRate) return;
  const event = buildEvent(report, {
    eventId: newEventId(),
    timestamp: Date.now() / 1000,
    release: releaseName(),
    environment: settings.environment,
    platform: 'node',
    fingerprint: print,
    debugIds: debugIdsByPath(),
    tags: { runtime: 'server' },
  });
  s.sending++;
  try {
    await fetch(envelopeUrl(dsn), {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-sentry-envelope' },
      body: buildEnvelope(event),
      redirect: 'manual',
      signal: AbortSignal.timeout(SEND_TIMEOUT_MS),
    });
  } finally {
    s.sending--;
  }
}

/** Count `report` and send it to the DSN when one is set. Never rejects. */
export function handleServerReport(report: ErrorReport): Promise<void> {
  return deliver(report).catch(() => undefined);
}

/** Next's onRequestError: an error a route, page or server action threw. */
export function captureRequestError(error: unknown, routePattern?: string): Promise<void> {
  try {
    const e = (error && typeof error === 'object' ? error : { message: String(error) }) as { name?: unknown; message?: unknown; stack?: unknown };
    return handleServerReport({
      name: scrubName(e.name),
      message: scrubText(e.message),
      frames: parseStack(e.stack),
      handled: false,
      mechanism: 'request',
      // A route pattern from the code ("/api/admin/[id]"), never the request's URL.
      ...(typeof routePattern === 'string' && ROUTE_PATTERN.test(routePattern) ? { route: routePattern } : {}),
    });
  } catch {
    return Promise.resolve();
  }
}

/**
 * logger.error: a route that caught an error and logged it. The frames are
 * the logging call's, minus the logger's own `skip` frames.
 */
export function captureLoggedError(
  message: string,
  extra: Record<string, unknown> | undefined,
  stack: string | undefined,
  skip = 2,
): Promise<void> {
  try {
    const detail = typeof extra?.error === 'string' ? extra.error : extra?.error instanceof Error ? extra.error.message : '';
    const frames: Frame[] = parseStack(stack).slice(skip);
    return handleServerReport({
      name: 'LoggedError',
      message: scrubText(detail ? `${message}: ${detail}` : message),
      frames,
      handled: true,
      mechanism: 'logger',
    });
  } catch {
    return Promise.resolve();
  }
}

/**
 * Hook the logger up (instrumentation.node.ts). The logger only knows a
 * function on globalThis, so it stays free of config code and safe for any
 * bundle that imports it.
 */
export async function installServerErrorReporting(): Promise<void> {
  await configManager.ensureLoaded();
  const { setErrorSink } = await import('@/lib/logger');
  setErrorSink((message, extra, stack) => { void captureLoggedError(message, extra, stack); });
}
