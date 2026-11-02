// Schema v1 of the anonymous heartbeat, and v2 (v1 plus error counts, sent
// only with the separate error-count consent). Documented at
// https://bulwarkmail.org/docs/legal/privacy/telemetry

export type ConsentState = 'pending' | 'on' | 'off';

export type Platform = 'docker' | 'bare' | 'k8s' | 'unknown';
export type OsFamily = 'linux' | 'darwin' | 'windows' | 'unknown';
export type CountBucket = '0' | '1' | '2-5' | '6-10' | '11-50' | '51-200' | '201+';

export interface TelemetryFeatures {
  calendar: boolean;
  contacts: boolean;
  files: boolean;
  extensions: boolean;
  oauth_enabled: boolean;
  smime_enabled: boolean;
}

export interface TelemetryPayload {
  schema: '1';
  instance_id: string;
  ts: string;
  version: string;
  build: string | null;
  platform: Platform;
  node_version: string;
  os_family: OsFamily;
  stalwart_version: string | null;
  features: TelemetryFeatures;
  counts: {
    accounts: CountBucket;
    accounts_active_7d: CountBucket;
    extensions_installed: number;
    themes_installed: number;
  };
  uptime_days: number;
}

/** At most this many errors in a v2 heartbeat, the most frequent first. */
export const MAX_TELEMETRY_ERRORS = 50;
/** Top frames per error. */
export const MAX_TELEMETRY_FRAMES = 5;

export interface TelemetryErrorFrame {
  /** The bundle file without origin: `/_next/static/chunks/x.js` or `/.next/server/...`. */
  path: string;
  line: number | null;
  col: number | null;
  /** The file's debug ID, which finds its uploaded source map. */
  debug_id: string | null;
}

/** One error fingerprint of the last complete UTC day. */
export interface TelemetryError {
  /** The error's class name (TypeError, JmapMethodError). */
  name: string;
  fingerprint: string;
  frames: TelemetryErrorFrame[];
  version: string;
  /** How often that day, bucketed like the account counts. */
  count: CountBucket;
  /** On how many of the last 7 days it occurred (1-7). */
  days: number;
  /** Only one of Bulwark's fixed error codes (`Email/set: overQuota`), never free text. */
  message?: string;
}

export interface TelemetryPayloadV2 extends Omit<TelemetryPayload, 'schema'> {
  schema: '2';
  errors: TelemetryError[];
}

export type AnyTelemetryPayload = TelemetryPayload | TelemetryPayloadV2;

/**
 * Error counts: off, daily (with the heartbeat, for the day before) or
 * instant (daily, plus the current day's counts within about a minute).
 * 'on' is the daily mode; the stored value predates the instant one.
 */
export type ErrorsConsent = 'on' | 'off' | 'instant';

/**
 * What instant mode posts to the collector's /v1/errors: the current UTC
 * day's errors that are new or whose count bucket changed since the last send.
 */
export interface TelemetryErrorBatch {
  schema: '1';
  instance_id: string;
  /** The UTC day the counts are for (YYYY-MM-DD). */
  day: string;
  errors: TelemetryError[];
}

/** The collector's errors URL next to its heartbeat URL: `.../v1/heartbeat` -> `.../v1/errors`. */
export function errorsEndpointFor(heartbeatEndpoint: string): string {
  return new URL('errors', heartbeatEndpoint).toString();
}

export interface TelemetryStateFile {
  consent: ConsentState;
  endpoint: string;
  consentedAt: string | null;
  lastSentAt: string | null;
  /**
   * With a shared store only: when the last scheduled heartbeat went out.
   * Unlike lastSentAt, the admin's "send now" doesn't set it.
   */
  lastScheduledSentAt?: string | null;
  nextScheduledAt: string | null;
  /**
   * The separate consent to add error counts (schema v2), and whether they
   * also go out instantly. Off unless an admin turns it on; switching
   * telemetry off switches it off too.
   */
  errorsConsent?: ErrorsConsent;
}

export const DEFAULT_ENDPOINT = 'https://telemetry.bulwarkmail.org/v1/heartbeat';
