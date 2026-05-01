import { readFile, writeFile, mkdir, rename } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { logger } from '@/lib/logger';
import type { VersionCheckStateFile } from './types';
import { DEFAULT_VERSION_ENDPOINT } from './types';

function getDir(): string {
  return process.env.VERSION_CHECK_DATA_DIR ||
    path.join(process.cwd(), 'data', 'version-check');
}

function statePath(): string { return path.join(getDir(), 'state.json'); }

const DEFAULTS: VersionCheckStateFile = {
  endpoint: DEFAULT_VERSION_ENDPOINT,
  lastCheckedAt: null,
  lastSuccessAt: null,
  nextScheduledAt: null,
  status: null,
};

export async function ensureDir(): Promise<void> {
  if (!existsSync(getDir())) await mkdir(getDir(), { recursive: true });
}

export async function loadState(): Promise<VersionCheckStateFile> {
  await ensureDir();
  try {
    const raw = await readFile(statePath(), 'utf8');
    const parsed = JSON.parse(raw) as Partial<VersionCheckStateFile>;
    return { ...DEFAULTS, ...parsed };
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
      logger.warn('version-check: state read failed', {
        error: err instanceof Error ? err.message : String(err),
      });
    }
    return { ...DEFAULTS };
  }
}

export async function saveState(state: VersionCheckStateFile): Promise<void> {
  await ensureDir();
  const tmp = statePath() + '.tmp';
  await writeFile(tmp, JSON.stringify(state, null, 2), 'utf8');
  await rename(tmp, statePath());
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
