import path from 'node:path';
import { logger } from '@/lib/logger';
import { getStore, type CollectionOptions } from '@/lib/shared-store';
import { isStoreUnavailable } from '@/lib/stored-data-errors';
import type { UpdateStatus, VersionCheckStateFile } from './types';
import { DEFAULT_VERSION_ENDPOINT } from './types';

function getDir(): string {
  return process.env.VERSION_CHECK_DATA_DIR ||
    path.join(process.cwd(), 'data', 'version-check');
}

/**
 * `state.json` (#1066). Local mode: today's file in the version-check dir.
 * Shared mode: one state for the deployment, written by the replica that
 * runs the scheduled check and read by all.
 */
export const VERSION_CHECK_COLLECTION: CollectionOptions = {
  local: {
    dir: () => getDir(),
    idOf: (relative) => (relative === 'state.json' ? relative : null),
  },
};

export const STATE_DOC = 'state.json';

function docs() {
  return getStore().collection('version-check', VERSION_CHECK_COLLECTION);
}

const DEFAULTS: VersionCheckStateFile = {
  endpoint: DEFAULT_VERSION_ENDPOINT,
  lastCheckedAt: null,
  lastSuccessAt: null,
  nextScheduledAt: null,
  status: null,
};

function parse(data: Buffer): VersionCheckStateFile {
  return { ...DEFAULTS, ...(JSON.parse(data.toString('utf8')) as Partial<VersionCheckStateFile>) };
}

function serialize(state: VersionCheckStateFile): string {
  return JSON.stringify(state, null, 2);
}

/** The stored state, or the defaults. Throws StoreUnavailableError when the shared store is down. */
export async function loadState(): Promise<VersionCheckStateFile> {
  try {
    const current = await docs().get(STATE_DOC);
    return current ? parse(current.data) : { ...DEFAULTS };
  } catch (err) {
    if (isStoreUnavailable(err)) throw err;
    logger.warn('version-check: state read failed', {
      error: err instanceof Error ? err.message : String(err),
    });
    return { ...DEFAULTS };
  }
}

export async function saveState(state: VersionCheckStateFile): Promise<void> {
  await docs().put(STATE_DOC, serialize(state));
}

/** Change some fields against what is stored now. `change` may run more than once. */
export async function updateState(change: (state: VersionCheckStateFile) => void): Promise<void> {
  await docs().update(STATE_DOC, (current) => {
    let state: VersionCheckStateFile;
    try {
      state = current ? parse(current) : { ...DEFAULTS };
    } catch {
      state = { ...DEFAULTS };
    }
    change(state);
    return serialize(state);
  });
}

export function disabledByEnv(): boolean {
  const v = (process.env.BULWARK_UPDATE_CHECK ?? '').toLowerCase();
  if (v === 'off' || v === 'false' || v === '0' || v === 'no') return true;
  return false;
}

export function effectiveEndpoint(state: VersionCheckStateFile): string {
  // Env var wins over state file so an operator can override at runtime
  // without editing on-disk state. An explicit empty value disables the check.
  const envUrl = process.env.BULWARK_UPDATE_CHECK_URL;
  if (envUrl !== undefined) return envUrl.trim();
  return state.endpoint || DEFAULT_VERSION_ENDPOINT;
}

export function getCurrentVersion(): string {
  return (process.env.NEXT_PUBLIC_APP_VERSION || '').trim();
}

// A persisted status describes the build that was running when it was written.
// After an upgrade it is stale by definition - it can keep claiming "update
// available" for a version we no longer run - so nothing may surface it until
// the next check refreshes it (#913). If the running version is unknown we
// can't tell, so we leave the status alone rather than blanking the banner.
export function isStatusStale(
  status: UpdateStatus | null,
  current: string = getCurrentVersion(),
): boolean {
  if (!status || !current) return false;
  return status.current !== current;
}

/** How many running versions keep their own status (a rolling update runs two). */
const KEPT_VERSIONS = 4;

/**
 * The status for the version this replica runs. With a shared store,
 * replicas on two versions during a rolling update share one state; each
 * reads the status checked for its own version from `statuses`, so the
 * banner doesn't come and go as the other version's checks land.
 */
export function freshStatus(state: VersionCheckStateFile): UpdateStatus | null {
  if (!isStatusStale(state.status)) return state.status;
  const own = state.statuses?.[getCurrentVersion()];
  return own && !isStatusStale(own) ? own : null;
}

/** `statuses` with `status` added for its version, keeping the newest few. */
export function withVersionStatus(
  statuses: Record<string, UpdateStatus> | undefined,
  status: UpdateStatus,
): Record<string, UpdateStatus> {
  const next = { ...(statuses ?? {}), [status.current]: status };
  const newest = Object.entries(next)
    .sort(([, a], [, b]) => b.checkedAt.localeCompare(a.checkedAt))
    .slice(0, KEPT_VERSIONS);
  return Object.fromEntries(newest);
}
