import { readFileSync } from 'node:fs';
import path from 'node:path';
import { configManager } from '@/lib/admin/config-manager';
import { logger } from '@/lib/logger';
import { resolveEndpointAllowed } from './endpoint-guard';
import { getInstanceId } from './state';
import { getLoginCounts } from './login-tracker';
import type {
  TelemetryPayload,
  TelemetryFeatures,
  Platform,
  OsFamily,
  CountBucket,
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

const STALWART_VERSION_TTL_MS = 24 * 60 * 60 * 1000;
let stalwartVersionCache: { version: string | null; fetchedAt: number } | null = null;

// Stalwart returns the version in the Server response header
// (e.g. "Stalwart Mail Server v0.16.0"). The /.well-known/jmap endpoint
// requires auth, but the header is on the 401 response too, so an
// unauthenticated GET is enough. Cached for a day to avoid hammering
// the JMAP server on every payload preview.
async function detectStalwartVersion(): Promise<string | null> {
  if (process.env.STALWART_VERSION) return process.env.STALWART_VERSION;
  if (stalwartVersionCache &&
      Date.now() - stalwartVersionCache.fetchedAt < STALWART_VERSION_TTL_MS) {
    return stalwartVersionCache.version;
  }
  await configManager.ensureLoaded();
  const serverUrl = configManager.get<string>('jmapServerUrl', '').trim();
  if (!serverUrl) {
    stalwartVersionCache = { version: null, fetchedAt: Date.now() };
    return null;
  }
  const wellKnown = `${serverUrl.replace(/\/+$/, '')}/.well-known/jmap`;
  // Reuse the SSRF guard so a misconfigured JMAP_SERVER_URL pointing at an
  // internal host doesn't get probed from telemetry context either.
  const guard = await resolveEndpointAllowed(wellKnown);
  if (!guard.ok) {
    stalwartVersionCache = { version: null, fetchedAt: Date.now() };
    return null;
  }
  try {
    const res = await fetch(wellKnown, {
      method: 'GET',
      signal: AbortSignal.timeout(3000),
    });
    const server = res.headers.get('server') ?? '';
    const m = server.match(/(\d+\.\d+\.\d+(?:-[\w.]+)?)/);
    const version = m?.[1] ?? null;
    stalwartVersionCache = { version, fetchedAt: Date.now() };
    return version;
  } catch (err) {
    logger.debug?.('telemetry: stalwart version probe failed', {
      error: err instanceof Error ? err.message : String(err),
    });
    stalwartVersionCache = { version: null, fetchedAt: Date.now() };
    return null;
  }
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

export async function buildPayload(): Promise<TelemetryPayload> {
  const instance_id = await getInstanceId();
  const { version, build } = readPackage();
  const features = await readFeatures();
  const accounts = await getLoginCounts();
  const exts = await countExtensions();
  const stalwart_version = await detectStalwartVersion();
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
