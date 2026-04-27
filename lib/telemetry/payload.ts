import { readFileSync } from 'node:fs';
import path from 'node:path';
import { configManager } from '@/lib/admin/config-manager';
import { logger } from '@/lib/logger';
import { getInstanceId } from './state';
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
  const policy = configManager.getPolicy();
  const gates = policy.features ?? {};
  const cfg = configManager.getAll();
  return {
    // Booleans only. We read whether a feature is enabled - never any
    // config value beyond a presence check.
    calendar:       gates.calendarTasksEnabled !== false,
    contacts:       true,
    files:          gates.filesEnabled === true,
    extensions:     gates.pluginsEnabled !== false,
    push_relay:     !!cfg['pushRelayUrl'],
    oauth_enabled:  !!cfg['oauthClientId'],
    smime_enabled:  gates.smimeEnabled === true,
    webdav_enabled: gates.filesEnabled === true,
  };
}

async function countAccounts(): Promise<{ total: number; active7d: number }> {
  // Best-effort. If Stalwart's admin endpoint isn't reachable from here we
  // return 0 / 0 - the heartbeat still fires.
  try {
    const adminUrl = process.env.STALWART_MGMT_URL || process.env.STALWART_ADMIN_URL;
    const adminUser = process.env.STALWART_ADMIN_USER;
    const adminPass = process.env.STALWART_ADMIN_PASSWORD;
    if (!adminUrl || !adminUser || !adminPass) return { total: 0, active7d: 0 };
    const auth = Buffer.from(`${adminUser}:${adminPass}`).toString('base64');
    const res = await fetch(`${adminUrl.replace(/\/$/, '')}/api/principal?type=individual`, {
      headers: { authorization: `Basic ${auth}` },
      signal: AbortSignal.timeout(2000),
    });
    if (!res.ok) return { total: 0, active7d: 0 };
    const body = await res.json() as { data?: { total?: number } };
    const total = Number(body?.data?.total ?? 0);
    return { total, active7d: total };
  } catch (err) {
    logger.debug?.('telemetry: account count probe failed', {
      error: err instanceof Error ? err.message : String(err),
    });
    return { total: 0, active7d: 0 };
  }
}

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
  const accounts = await countAccounts();
  const exts = await countExtensions();
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
    stalwart_version: process.env.STALWART_VERSION ?? null,
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
