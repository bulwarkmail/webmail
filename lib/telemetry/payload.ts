import { readFileSync } from 'node:fs';
import path from 'node:path';
import { configManager } from '@/lib/admin/config-manager';
import { effectiveErrorsConsent, getInstanceId } from './state';
import { getLoginCounts } from './login-tracker';
import { isErrorCode } from '@/lib/error-reporting/envelope';
import { readErrors, utcDay, type Aggregate } from '@/lib/error-reporting/aggregate';
import {
  MAX_TELEMETRY_ERRORS,
  MAX_TELEMETRY_FRAMES,
  type AnyTelemetryPayload,
  type TelemetryError,
  type TelemetryPayload,
  type TelemetryFeatures,
  type Platform,
  type OsFamily,
  type CountBucket,
} from './types';

let processStartedAt = Date.now();
export function markProcessStart(): void {
  processStartedAt = Date.now();
}

function readPackage(): { version: string; build: string | null } {
  try {
    const pkg = JSON.parse(
      readFileSync(path.join(process.cwd(), 'package.json'), 'utf8'),
    ) as { version?: string };
    return { version: pkg.version ?? '0.0.0', build: process.env.BULWARK_BUILD ?? 'release' };
  } catch {
    return { version: '0.0.0', build: null };
  }
}

function detectPlatform(): Platform {
  if (process.env.KUBERNETES_SERVICE_HOST) return 'k8s';
  // /.dockerenv is the standard Docker container marker.
  try {
    readFileSync('/.dockerenv');
    return 'docker';
  } catch { /* not in docker */ }
  return 'bare';
}

function detectOs(): OsFamily {
  switch (process.platform) {
    case 'linux':   return 'linux';
    case 'darwin':  return 'darwin';
    case 'win32':   return 'windows';
    default:        return 'unknown';
  }
}

export function bucketCount(n: number): CountBucket {
  if (n <= 0) return '0';
  if (n === 1) return '1';
  if (n <= 5) return '2-5';
  if (n <= 10) return '6-10';
  if (n <= 50) return '11-50';
  if (n <= 200) return '51-200';
  return '201+';
}

async function readFeatures(): Promise<TelemetryFeatures> {
  await configManager.ensureLoaded();
  const gates = configManager.getPolicy().features;
  const cfg = configManager.getAll();
  return {
    // Booleans only. We read whether a feature is enabled - never any
    // config value beyond a presence check.
    calendar:      gates.calendarEnabled === true,
    contacts:      gates.contactsEnabled === true,
    files:         gates.filesEnabled === true,
    extensions:    gates.pluginsEnabled === true,
    oauth_enabled: cfg['oauthEnabled'] === true,
    smime_enabled: gates.smimeEnabled === true,
  };
}

// Only what the admin sets in STALWART_VERSION. Stalwart publishes no version
// a client could read: it sends no Server header (0.16.0 through 1.0), and
// the version it names elsewhere is a fixed "1.0.0" even on 0.16. Reading the
// Server header of /.well-known/jmap reported null, or whatever version a
// reverse proxy in front of Stalwart put there.
function stalwartVersion(): string | null {
  return process.env.STALWART_VERSION?.trim() || null;
}

// Account counts come from the local login tracker, which records a per-
// instance HMAC of every successful login plus the timestamp. Total = unique
// identities seen in the last 90 days; active7d = identities with a login in
// the last 7 days.

async function countExtensions(): Promise<{ extensions: number; themes: number }> {
  try {
    const { getPluginRegistry, getThemeRegistry } = await import('@/lib/admin/plugin-registry');
    const [plugins, themes] = await Promise.all([getPluginRegistry(), getThemeRegistry()]);
    return {
      extensions: plugins.plugins.length,
      themes: themes.themes.length,
    };
  } catch {
    return { extensions: 0, themes: 0 };
  }
}

const BUNDLE_PATH = /^\/(?:_next\/static|\.next\/server)\/[\w./()[\]@+~-]{1,200}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/**
 * The error counts of the last complete UTC day (the day before `now`), for
 * schema v2: at most MAX_TELEMETRY_ERRORS, the most frequent first. Only
 * frames in Bulwark's own bundles go (no extension, plugin or Node paths),
 * and a message only when it is one of Bulwark's fixed error codes.
 */
export function errorsForPayload(agg: Aggregate, now = Date.now()): TelemetryError[] {
  return errorsForDay(agg, utcDay(now - 86_400_000));
}

/**
 * The error counts of one UTC day, shaped as in errorsForPayload. `days`
 * counts the days of the week ending on `day` the error occurred on.
 * Instant mode sends the current day's this way.
 */
export function errorsForDay(agg: Aggregate, day: string): TelemetryError[] {
  const end = Date.parse(`${day}T00:00:00Z`);
  const recentDays = Array.from({ length: 7 }, (_, i) => utcDay(end - i * 86_400_000));
  return Object.entries(agg[day] ?? {})
    .sort(([, a], [, b]) => b.count - a.count)
    .slice(0, MAX_TELEMETRY_ERRORS)
    .map(([fingerprint, entry]) => ({
      name: entry.name,
      fingerprint,
      frames: entry.frames
        .filter((frame) => BUNDLE_PATH.test(frame.path))
        .slice(0, MAX_TELEMETRY_FRAMES)
        .map((frame) => ({
          path: frame.path,
          line: frame.line ?? null,
          col: frame.column ?? null,
          debug_id: frame.debugId && UUID.test(frame.debugId) ? frame.debugId : null,
        })),
      version: entry.version,
      count: bucketCount(entry.count),
      days: recentDays.filter((d) => agg[d]?.[fingerprint]).length,
      ...(isErrorCode(entry.code) ? { message: entry.code } : {}),
    }));
}

/**
 * The heartbeat. Schema 1, exactly as before, unless the admin also agreed
 * to send error counts; then schema 2 with `errors` added.
 */
export async function buildPayload(): Promise<AnyTelemetryPayload> {
  const base = await buildPayloadV1();
  // Daily and instant mode both send the last complete day with the heartbeat.
  if ((await effectiveErrorsConsent()).consent === 'off') return base;
  return { ...base, schema: '2', errors: errorsForPayload(await readErrors()) };
}

async function buildPayloadV1(): Promise<TelemetryPayload> {
  const instance_id = await getInstanceId();
  const { version, build } = readPackage();
  const features = await readFeatures();
  const accounts = await getLoginCounts();
  const exts = await countExtensions();
  const stalwart_version = stalwartVersion();
  const uptime_days = Math.min(
    365,
    Math.floor((Date.now() - processStartedAt) / 86_400_000),
  );

  return {
    schema: '1',
    instance_id,
    ts: new Date().toISOString(),
    version,
    build,
    platform: detectPlatform(),
    node_version: process.versions.node,
    os_family: detectOs(),
    stalwart_version,
    features,
    counts: {
      accounts: bucketCount(accounts.total),
      accounts_active_7d: bucketCount(accounts.active7d),
      extensions_installed: exts.extensions,
      themes_installed: exts.themes,
    },
    uptime_days,
  };
}
