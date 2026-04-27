import { readFile, writeFile, mkdir, rename } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { logger } from '@/lib/logger';
import type { TelemetryStateFile, ConsentState } from './types';
import { DEFAULT_ENDPOINT } from './types';

function getDir(): string {
  return process.env.TELEMETRY_DATA_DIR ||
    path.join(process.cwd(), 'data', 'telemetry');
}

function statePath(): string { return path.join(getDir(), 'state.json'); }
function idPath(): string { return path.join(getDir(), '.telemetry-id'); }

function envOverride(): ConsentState | null {
  const v = (process.env.BULWARK_TELEMETRY ?? '').toLowerCase();
  if (v === 'off' || v === 'false' || v === '0' || v === 'no') return 'off';
  if (process.env.BULWARK_TELEMETRY_DISABLED) {
    const d = process.env.BULWARK_TELEMETRY_DISABLED.toLowerCase();
    if (d === '1' || d === 'true' || d === 'yes') return 'off';
  }
  return null;
}

export async function ensureDir(): Promise<void> {
  if (!existsSync(getDir())) await mkdir(getDir(), { recursive: true });
}

export async function getInstanceId(): Promise<string> {
  await ensureDir();
  try {
    const id = (await readFile(idPath(), 'utf8')).trim();
    if (/^[0-9a-f-]{36}$/i.test(id)) return id;
  } catch { /* generate fresh */ }
  const fresh = randomUUID();
  const tmp = idPath() + '.tmp';
  await writeFile(tmp, fresh, 'utf8');
  await rename(tmp, idPath());
  return fresh;
}

// Default consent is 'on' — telemetry is anonymous and enabled by default.
// Admins can disable via the UI, the BULWARK_TELEMETRY env var, or by clearing
// the endpoint. See https://bulwarkmail.org/docs/legal/privacy/telemetry.
const DEFAULTS: TelemetryStateFile = {
  consent: 'on',
  endpoint: DEFAULT_ENDPOINT,
  consentedAt: null,
  lastSentAt: null,
  nextScheduledAt: null,
};

export async function loadState(): Promise<TelemetryStateFile> {
  await ensureDir();
  try {
    const raw = await readFile(statePath(), 'utf8');
    const parsed = JSON.parse(raw) as Partial<TelemetryStateFile>;
    return { ...DEFAULTS, ...parsed };
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
      logger.warn('telemetry: state read failed', {
        error: err instanceof Error ? err.message : String(err),
      });
    }
    // First-ever load on a fresh install: persist the default-on state with
    // an autoEnabledAt stamp so the admin UI can show "telemetry was
    // auto-enabled at <time>; disable here" without re-arming on restart.
    const fresh: TelemetryStateFile = {
      ...DEFAULTS,
      consentedAt: new Date().toISOString(),
    };
    await saveState(fresh);
    return fresh;
  }
}

export async function saveState(state: TelemetryStateFile): Promise<void> {
  await ensureDir();
  const tmp = statePath() + '.tmp';
  await writeFile(tmp, JSON.stringify(state, null, 2), 'utf8');
  await rename(tmp, statePath());
}

// Effective consent: env var wins over file. UI changes are blocked
// when env override is active so the user knows where it's coming from.
export async function effectiveConsent(): Promise<{
  consent: ConsentState;
  source: 'env' | 'file';
  state: TelemetryStateFile;
}> {
  const envState = envOverride();
  const state = await loadState();
  if (envState) return { consent: envState, source: 'env', state };
  return { consent: state.consent, source: 'file', state };
}

export function endpointEnabled(endpoint: string | undefined): boolean {
  return !!endpoint && endpoint.trim().length > 0;
}
