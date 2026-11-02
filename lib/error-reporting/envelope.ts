import type { Frame } from './stack';

/**
 * The Sentry envelope format, which Bugsink, GlitchTip and Sentry accept.
 * Only what Bulwark sends: one event item per envelope.
 * https://develop.sentry.dev/sdk/data-model/envelopes/
 */

export interface Dsn {
  /** scheme://host[:port] */
  origin: string;
  /** Anything between the host and the project id, usually ''. */
  pathPrefix: string;
  publicKey: string;
  projectId: string;
}

/** `https://<key>@host[:port][/prefix]/<project id>`, or null. */
export function parseDsn(raw: unknown): Dsn | null {
  if (typeof raw !== 'string' || !raw.trim()) return null;
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    return null;
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return null;
  if (!url.username || url.password || url.search || url.hash) return null;
  const parts = url.pathname.split('/').filter(Boolean);
  const projectId = parts.pop();
  if (!projectId || !/^\d+$/.test(projectId) || !/^[0-9a-f]{16,64}$/i.test(url.username)) return null;
  return {
    origin: `${url.protocol}//${url.host}`,
    pathPrefix: parts.length ? `/${parts.join('/')}` : '',
    publicKey: url.username,
    projectId,
  };
}

/** Where envelopes go. The key travels in the query, so a browser needs no custom header. */
export function envelopeUrl(dsn: Dsn): string {
  return `${dsn.origin}${dsn.pathPrefix}/api/${dsn.projectId}/envelope/?sentry_key=${dsn.publicKey}&sentry_version=7`;
}

/** A fixed error code: `Email/set: overQuota`, `serverFail`, `http:503`. */
export const ERROR_CODE = /^(?:(?:[A-Z][A-Za-z]{0,40}\/[a-z][A-Za-z]{0,40}: )?[a-z][A-Za-z]{1,40}|http:\d{3})$/;

export function isErrorCode(value: unknown): value is string {
  return typeof value === 'string' && ERROR_CODE.test(value);
}

export interface Breadcrumb {
  /** Seconds since the epoch. */
  timestamp: number;
  category: 'navigation' | 'jmap';
  /** A scrubbed route (`/mail/…`) or a JMAP method name. */
  message: string;
}

/** An error, scrubbed, as both sides hand it to the sender. */
export interface ErrorReport {
  name: string;
  message: string;
  frames: Frame[];
  /** One of Bulwark's fixed codes, when the error has one. */
  code?: string;
  handled: boolean;
  /** How it was caught: onerror, unhandledrejection, boundary, global-error, jmap, request, logger. */
  mechanism: string;
  breadcrumbs?: Breadcrumb[];
  /** The scrubbed route it happened on. */
  route?: string;
}

export interface EventContext {
  eventId: string;
  /** Seconds since the epoch. */
  timestamp: number;
  release: string;
  environment: string;
  platform: 'javascript' | 'node';
  fingerprint: string;
  /** Path -> debug id, for the frames' files. */
  debugIds: Map<string, string>;
  tags?: Record<string, string>;
}

/** The event payload. Frames go oldest first, as the format wants. */
export function buildEvent(report: ErrorReport, ctx: EventContext): Record<string, unknown> {
  const frames = [...report.frames].reverse().map((frame) => ({
    abs_path: frame.path,
    filename: frame.path,
    ...(frame.fn ? { function: frame.fn } : {}),
    ...(frame.line !== undefined ? { lineno: frame.line } : {}),
    ...(frame.column !== undefined ? { colno: frame.column } : {}),
    in_app: frame.path.startsWith('/_next/') || frame.path.startsWith('/.next/'),
  }));
  const images = [...new Set(report.frames.map((frame) => frame.path))]
    .filter((path) => ctx.debugIds.has(path))
    .map((path) => ({ type: 'sourcemap', code_file: path, debug_id: ctx.debugIds.get(path) }));
  return {
    event_id: ctx.eventId,
    timestamp: ctx.timestamp,
    platform: ctx.platform,
    level: 'error',
    release: ctx.release,
    environment: ctx.environment,
    // Bulwark's own grouping: the same key as the per-day counts.
    fingerprint: [ctx.fingerprint],
    exception: {
      values: [{
        type: report.name,
        value: report.code ?? report.message,
        mechanism: { type: report.mechanism, handled: report.handled },
        ...(frames.length ? { stacktrace: { frames } } : {}),
      }],
    },
    ...(report.breadcrumbs?.length
      ? { breadcrumbs: { values: report.breadcrumbs.map((b) => ({ timestamp: b.timestamp, category: b.category, message: b.message })) } }
      : {}),
    ...(images.length ? { debug_meta: { images } } : {}),
    tags: { ...(ctx.tags ?? {}), ...(report.route ? { route: report.route } : {}) },
    sdk: { name: 'bulwark.error-reporting', version: '1' },
  };
}

/** One event in an envelope. */
export function buildEnvelope(event: Record<string, unknown>): string {
  const header = { event_id: event.event_id, sent_at: new Date().toISOString() };
  return `${JSON.stringify(header)}\n${JSON.stringify({ type: 'event', content_type: 'application/json' })}\n${JSON.stringify(event)}\n`;
}

/** 32 hex digits, as event ids are. */
export function newEventId(): string {
  const bytes = new Uint8Array(16);
  globalThis.crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

/** `<version>+<commit>`, the release the source maps were uploaded for. */
export function releaseName(): string {
  const version = process.env.NEXT_PUBLIC_APP_VERSION || '0.0.0';
  const commit = process.env.NEXT_PUBLIC_GIT_COMMIT;
  return commit && commit !== 'unknown' ? `${version}+${commit}` : version;
}

export function appVersion(): string {
  return process.env.NEXT_PUBLIC_APP_VERSION || '0.0.0';
}
