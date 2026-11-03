import { apiFetch, getPathPrefix } from '@/lib/browser-navigation';
import { getDesktopBridge } from '@/lib/desktop/bridge';
import { scrubRoutePath } from '@/lib/route-groups';
import { debugIdsByPath } from './debug-ids';
import {
  appVersion, buildEnvelope, buildEvent, envelopeUrl, isErrorCode, newEventId, parseDsn, releaseName,
  type Breadcrumb, type ErrorReport,
} from './envelope';
import { fingerprint } from './fingerprint';
import { ReportLimiter } from './limiter';
import { scrubJmapErrorType, scrubMethodName, scrubName, scrubText } from './scrub';
import { parseStack } from './stack';

/**
 * Error reporting in the browser, off until the config names a DSN or asks
 * for errors to be collected (lib/error-reporting/settings.ts). Captures what
 * the error boundaries, window.onerror, unhandled rejections and failed JMAP
 * requests hand it, scrubs it (./scrub.ts) and sends it to the DSN and/or
 * this server's /api/errors. Nothing is sent before the config arrived, and
 * nothing at all when both are off.
 *
 * https://bulwarkmail.org/docs/deployment/monitoring
 */

export interface ClientSettings {
  /** The error tracker's DSN; '' for none. */
  dsn: string;
  /** 0..1, applied to what goes to the DSN. */
  sampleRate: number;
  environment: string;
  /** Also post errors to this server's /api/errors (the per-day counts). */
  collect: boolean;
}

const MAX_PENDING = 10;
const MAX_BREADCRUMBS = 20;

interface ClientState {
  /** undefined until configured; null when reporting is off. */
  settings: ClientSettings | null | undefined;
  pending: ErrorReport[];
  breadcrumbs: Breadcrumb[];
  limiter: ReportLimiter | null;
  installed: boolean;
  /** In the desktop app: the shell's privacy changes are being listened to. */
  watchingConsent: boolean;
  /** The user took crash reports back, or a policy did. A later config doesn't undo that. */
  withdrawn: boolean;
}

// On globalThis: the error boundary, the JMAP client and the root component
// may each end up with their own copy of this module.
const KEY = Symbol.for('bulwark.error-reporting.client');
function state(): ClientState {
  const g = globalThis as typeof globalThis & { [KEY]?: ClientState };
  return (g[KEY] ??= { settings: undefined, pending: [], breadcrumbs: [], limiter: null, installed: false, watchingConsent: false, withdrawn: false });
}

function sessionStore(): Storage | null {
  try {
    return typeof sessionStorage === 'undefined' ? null : sessionStorage;
  } catch {
    return null;
  }
}

function limiter(): ReportLimiter {
  const s = state();
  return (s.limiter ??= new ReportLimiter({ perMinute: 10, perSession: 30, dedupWindowMs: Infinity, storage: sessionStore() }));
}

function basePath(): string {
  return getPathPrefix();
}

function currentRoute(): string | undefined {
  if (typeof location === 'undefined') return undefined;
  return scrubRoutePath(location.pathname, basePath());
}

/**
 * Consent taken back while a page is open, in the desktop app. A change to anything else
 * with crash reports never on leaves an instance's own settings alone: its admin chose
 * those, and the settings page says so.
 */
function watchDesktopConsent(): void {
  const s = state();
  const bridge = getDesktopBridge();
  if (s.watchingConsent || !bridge?.privacy?.onChange) return;
  s.watchingConsent = true;
  let on: boolean | null = null;
  void Promise.resolve(bridge.privacy.get?.()).then((current) => {
    on ??= current?.crashReports.on ?? null;
  }).catch(() => {});
  bridge.privacy.onChange((next) => {
    const tookBack = on === true && !next.crashReports.on;
    on = next.crashReports.on;
    if (on) s.withdrawn = false;
    if (tookBack || next.crashReports.forcedOff) {
      s.withdrawn = true;
      configureErrorReporting(null);
    }
  });
}

/** Apply the settings from /api/config (or Lite's policy.json); null switches reporting off. */
export function configureErrorReporting(settings: ClientSettings | null): void {
  const s = state();
  watchDesktopConsent();
  const on = !s.withdrawn && settings && (parseDsn(settings.dsn) || settings.collect) ? settings : null;
  s.settings = on;
  const queued = s.pending;
  s.pending = [];
  if (on) for (const report of queued) deliver(report);
}

export function isErrorReportingOn(): boolean {
  return !!state().settings;
}

/** A route change or a JMAP call, kept for the next report. */
export function addBreadcrumb(category: Breadcrumb['category'], message: string): void {
  const s = state();
  if (s.settings === null) return;
  s.breadcrumbs.push({ timestamp: Date.now() / 1000, category, message });
  if (s.breadcrumbs.length > MAX_BREADCRUMBS) s.breadcrumbs.shift();
}

/** A route change: only the scrubbed route is kept. */
export function recordNavigation(pathname: string): void {
  addBreadcrumb('navigation', scrubRoutePath(pathname, basePath()));
}

/** A JMAP request: only the method names. */
export function recordJmapCall(methods: readonly string[]): void {
  addBreadcrumb('jmap', methods.slice(0, 5).map(scrubMethodName).join(', '));
}

/** Turn anything thrown into a scrubbed report; null for what isn't worth one. */
export function reportFromError(error: unknown, mechanism: string, handled: boolean): ErrorReport | null {
  let name = 'Error';
  let message = '';
  let stack: string | undefined;
  if (error instanceof Error || (error && typeof error === 'object' && 'message' in error)) {
    const e = error as { name?: unknown; message?: unknown; stack?: unknown };
    name = scrubName(e.name);
    message = scrubText(e.message);
    stack = typeof e.stack === 'string' ? e.stack : undefined;
  } else if (typeof error === 'string') {
    name = mechanism === 'unhandledrejection' ? 'UnhandledRejection' : 'Error';
    message = scrubText(error);
  } else {
    return null;
  }
  // Offline mode (#523): a request the device can't answer while the
  // network is gone, and any fetch failing while the browser says it is
  // offline, are the expected state of an offline session, not bugs.
  if (name === 'OfflineUnavailableError') return null;
  if (name === 'TypeError' && typeof navigator !== 'undefined' && navigator.onLine === false) return null;
  const frames = parseStack(stack);
  // Every frame outside our bundles: a browser extension or injected script.
  if (frames.length > 0 && frames.every((frame) => frame.path === '[other]')) return null;
  return { name, message, frames, handled, mechanism, route: currentRoute() };
}

/** Report an error caught by a boundary, a global handler or a caller. */
export function captureException(error: unknown, mechanism = 'manual', handled = true): void {
  try {
    const report = reportFromError(error, mechanism, handled);
    if (report) captureReport(report);
  } catch {
    // Reporting must never throw into the code that reported.
  }
}

/** Report a JMAP request that failed: the method names and the status or error type only. */
export function reportJmapFailure(failure: { status: number } | { method: string; type: string }): void {
  try {
    const code = 'status' in failure
      ? `http:${Number.isInteger(failure.status) ? failure.status : 0}`
      : `${scrubMethodName(failure.method)}: ${scrubJmapErrorType(failure.type)}`;
    if (!isErrorCode(code)) return;
    const name = 'status' in failure ? 'JmapRequestError' : 'JmapMethodError';
    const frames = parseStack(new Error().stack).slice(1);
    captureReport({
      name,
      message: code,
      code,
      frames,
      handled: true,
      mechanism: 'jmap',
      route: currentRoute(),
    });
  } catch {
    // never throws into the JMAP client
  }
}

export function captureReport(report: ErrorReport): void {
  const s = state();
  if (s.settings === null) return;
  const withCrumbs = { ...report, breadcrumbs: report.breadcrumbs ?? [...s.breadcrumbs] };
  if (s.settings === undefined) {
    if (s.pending.length < MAX_PENDING) s.pending.push(withCrumbs);
    return;
  }
  deliver(withCrumbs);
}

/**
 * `CrashReportsAllowed` forced off, on any page of the desktop app. An instance's own
 * settings decide the rest there: its admin chose what its pages report to it.
 */
function forbiddenByDevicePolicy(): boolean {
  const entry = getDesktopBridge()?.policy?.get?.().CrashReportsAllowed;
  return !!entry && entry.locked && entry.value === false;
}

function deliver(report: ErrorReport): void {
  const s = state();
  const settings = s.settings;
  if (!settings || forbiddenByDevicePolicy()) return;
  const version = appVersion();
  const print = fingerprint(report.name, report.frames, version, report.code);
  if (!limiter().allow(print)) return;

  const dsn = parseDsn(settings.dsn);
  if (dsn && Math.random() < settings.sampleRate) {
    const event = buildEvent(report, {
      eventId: newEventId(),
      timestamp: Date.now() / 1000,
      release: releaseName(),
      environment: settings.environment,
      platform: 'javascript',
      fingerprint: print,
      debugIds: debugIdsByPath(),
      tags: {
        runtime: 'browser',
        ...(process.env.NEXT_PUBLIC_BULWARK_LITE === '1' ? { lite: 'yes' } : {}),
        // An instance's build knows nothing of the app it's in, so the bridge says.
        ...(getDesktopBridge() ? { platform: 'desktop' } : {}),
      },
    });
    send(envelopeUrl(dsn), buildEnvelope(event), {
      // text/plain keeps it a simple request: no preflight, no custom header.
      headers: { 'Content-Type': 'text/plain;charset=UTF-8' },
      credentials: 'omit',
      // The page URL holds folder names and message ids.
      referrerPolicy: 'no-referrer',
      mode: 'cors',
    });
  }
  // Lite has no server. Read here, not through IS_LITE: the bundler inlines
  // the variable only in this module, so the branch and the endpoint string
  // leave the Lite bundle (scripts/lite/verify.mjs).
  if (process.env.NEXT_PUBLIC_BULWARK_LITE !== '1' && settings.collect) {
    send('/api/errors', JSON.stringify({
      name: report.name,
      message: report.message,
      code: report.code,
      // With debug IDs, so the counts can point at the uploaded source maps.
      frames: withDebugIds(report.frames.slice(0, 10)),
      mechanism: report.mechanism,
      handled: report.handled,
      route: report.route,
      version,
    }), { headers: { 'Content-Type': 'application/json' }, credentials: 'same-origin' }, true);
  }
}

// A failed send is dropped quietly: it never turns into another report.
function send(url: string, body: string, init: RequestInit, sameOrigin = false): void {
  const request = sameOrigin
    ? apiFetch(url, { method: 'POST', body, keepalive: true, ...init })
    : fetch(url, { method: 'POST', body, keepalive: true, ...init });
  void Promise.resolve(request).catch(() => undefined);
}

function withDebugIds(frames: ErrorReport['frames']): ErrorReport['frames'] {
  const ids = debugIdsByPath();
  return frames.map((frame) => (ids.has(frame.path) ? { ...frame, debugId: ids.get(frame.path) } : frame));
}

/** window.onerror and unhandled rejections, once. */
export function installGlobalHandlers(): void {
  const s = state();
  if (s.installed || typeof window === 'undefined') return;
  s.installed = true;
  window.addEventListener('error', (event: ErrorEvent) => {
    // "Script error." from another origin carries nothing to report.
    if (!event.error) return;
    captureException(event.error, 'onerror', false);
  });
  window.addEventListener('unhandledrejection', (event: PromiseRejectionEvent) => {
    captureException(event.reason, 'unhandledrejection', false);
  });
}

/** For tests. */
export function resetErrorReportingForTests(): void {
  const g = globalThis as typeof globalThis & { [KEY]?: ClientState };
  delete g[KEY];
}
