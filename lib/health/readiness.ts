import { randomBytes } from 'node:crypto';
import { mkdir, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { configManager } from '@/lib/admin/config-manager';
import { getStateDir } from '@/lib/admin/paths';
import { observeUpstream } from '@/lib/metrics/upstream';
import { bootState, getStore, isSharedMode } from '@/lib/shared-store';
import { getSettingsDir } from '@/lib/settings-sync';
import { getDir as getTelemetryDir } from '@/lib/telemetry/state';

/**
 * Whether this replica can serve, for /api/health/ready (and, for the
 * shared store, /api/ready). Each check answers ok, fail or skipped; the
 * answer names checks, never hosts or paths, because anyone may ask.
 */

export type CheckResult = 'ok' | 'fail' | 'skipped';

export interface Readiness {
  ready: boolean;
  checks: {
    config: CheckResult;
    store: CheckResult;
    dataDirs: CheckResult;
    stalwart: CheckResult;
  };
}

const STALWART_TIMEOUT_MS = 2000;
const STORE_TIMEOUT_MS = 1000;
const CACHE_MS = 5000;

const KEY = Symbol.for('bulwark.health.readiness');
interface CacheState { at: number; result: Readiness | null; pending: Promise<Readiness> | null }
function cache(): CacheState {
  const g = globalThis as typeof globalThis & { [KEY]?: CacheState };
  return (g[KEY] ??= { at: 0, result: null, pending: null });
}

async function checkConfig(): Promise<CheckResult> {
  try {
    await configManager.ensureLoaded();
    return 'ok';
  } catch {
    return 'fail';
  }
}

/** Booted, and with a shared store, the store answered a ping. */
export async function checkStore(): Promise<CheckResult> {
  if (bootState() !== 'ready') return 'fail';
  const store = getStore();
  if (store.mode === 'local') return 'ok';
  try {
    await store.ping(STORE_TIMEOUT_MS);
    return 'ok';
  } catch {
    return 'fail';
  }
}

async function writable(dir: string): Promise<boolean> {
  const probe = path.join(dir, `.ready-${process.pid}-${randomBytes(4).toString('hex')}`);
  try {
    await mkdir(dir, { recursive: true });
    await writeFile(probe, '');
    await unlink(probe);
    return true;
  } catch {
    return false;
  }
}

/** The dirs this process writes to in local mode; a shared store holds that data instead. */
async function checkDataDirs(): Promise<CheckResult> {
  if (isSharedMode()) return 'skipped';
  const dirs = [getStateDir(), getTelemetryDir()];
  if (configManager.get<boolean>('settingsSyncEnabled', false)) dirs.push(getSettingsDir());
  const results = await Promise.all(dirs.map(writable));
  return results.every(Boolean) ? 'ok' : 'fail';
}

/** Stalwart's session resource answers, whatever the status below 500 (401 is expected without credentials). */
async function checkStalwart(): Promise<CheckResult> {
  const base = configManager.get<string>('jmapServerUrl', '') || process.env.JMAP_SERVER_URL || '';
  if (!base.trim()) return 'skipped';
  let url: URL;
  try {
    url = new URL('/.well-known/jmap', base.trim());
  } catch {
    return 'fail';
  }
  try {
    const response = await observeUpstream('stalwart', () => fetch(url, {
      method: 'GET',
      redirect: 'manual',
      signal: AbortSignal.timeout(STALWART_TIMEOUT_MS),
    }));
    await response.body?.cancel().catch(() => undefined);
    return response.status < 500 ? 'ok' : 'fail';
  } catch {
    return 'fail';
  }
}

async function evaluate(): Promise<Readiness> {
  const config = await checkConfig();
  const [store, dataDirs, stalwart] = await Promise.all([checkStore(), checkDataDirs(), checkStalwart()]);
  const checks = { config, store, dataDirs, stalwart };
  return { ready: Object.values(checks).every((c) => c !== 'fail'), checks };
}

/** The readiness of this replica, reused for CACHE_MS so probes can't flood Stalwart or the store. */
export async function readiness(now = Date.now()): Promise<Readiness> {
  const c = cache();
  if (c.result && now - c.at < CACHE_MS) return c.result;
  c.pending ??= evaluate()
    .then((result) => {
      c.result = result;
      c.at = Date.now();
      return result;
    })
    .finally(() => { c.pending = null; });
  return c.pending;
}

/** For tests. */
export function resetReadinessCache(): void {
  const g = globalThis as typeof globalThis & { [KEY]?: CacheState };
  delete g[KEY];
}
