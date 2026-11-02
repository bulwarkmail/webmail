import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { logger } from '@/lib/logger';
import { getStore, type CollectionOptions } from '@/lib/shared-store';
import { isStoreUnavailable, StoredDataUnreadableError } from '@/lib/stored-data-errors';
import type { TelemetryStateFile, ConsentState, ErrorsConsent } from './types';
import { DEFAULT_ENDPOINT } from './types';
import { isNoThirdPartyTrafficOn } from '@/lib/admin/third-party-mode';

export function getDir(): string {
  return process.env.TELEMETRY_DATA_DIR ||
    path.join(process.cwd(), 'data', 'telemetry');
}

/**
 * Telemetry's documents (#1066): `state.json`, `logins.json`, the instance
 * id `.telemetry-id` and the per-day error counts `errors.json`
 * (lib/error-reporting/aggregate.ts). Local mode: today's files in the
 * telemetry dir. Shared mode: one copy for the whole deployment, so every
 * replica reports as the same instance with the same counts.
 */
export const TELEMETRY_COLLECTION: CollectionOptions = {
  local: {
    dir: () => getDir(),
    idOf: (relative) => (['state.json', 'logins.json', '.telemetry-id', 'errors.json'].includes(relative) ? relative : null),
  },
};

export const STATE_DOC = 'state.json';
const ID_DOC = '.telemetry-id';
const UUID = /^[0-9a-f-]{36}$/i;

export function telemetryDocs() {
  return getStore().collection('telemetry', TELEMETRY_COLLECTION);
}

function envOverride(): ConsentState | null {
  const v = (process.env.BULWARK_TELEMETRY ?? '').toLowerCase();
  if (v === 'off' || v === 'false' || v === '0' || v === 'no') return 'off';
  if (v === 'on' || v === 'true' || v === '1' || v === 'yes') return 'on';
  if (process.env.BULWARK_TELEMETRY_DISABLED) {
    const d = process.env.BULWARK_TELEMETRY_DISABLED.toLowerCase();
    if (d === '1' || d === 'true' || d === 'yes') return 'off';
  }
  return null;
}

/**
 * The instance id, created once: of several replicas (or module copies)
 * asking at once, every one gets the id the first one stored.
 */
export async function getInstanceId(): Promise<string> {
  const docs = telemetryDocs();
  for (let attempt = 0; attempt < 3; attempt++) {
    let current;
    try {
      current = await docs.get(ID_DOC);
    } catch (error) {
      if (isStoreUnavailable(error)) throw error;
      current = null; // unreadable: make a fresh one, as before
    }
    const id = current?.data.toString('utf8').trim();
    if (id && UUID.test(id)) return id;
    const fresh = randomUUID();
    const result = await docs.put(ID_DOC, fresh, { ifVersion: current ? current.version : null });
    if (result.ok) return fresh;
    const won = result.current?.data.toString('utf8').trim();
    if (won && UUID.test(won)) return won;
  }
  throw new Error('telemetry: could not store an instance id');
}

// Default consent is 'off' - telemetry is opt-in. Admins can enable it during
// install (BULWARK_TELEMETRY=on in .env.local), via the BULWARK_TELEMETRY env
// var, or with one click in the admin UI. Heartbeats are anonymous: no PII,
// just version/platform/feature toggles. Enabling helps us improve the product.
// See https://bulwarkmail.org/docs/legal/privacy/telemetry.
const DEFAULTS: TelemetryStateFile = {
  consent: 'off',
  endpoint: DEFAULT_ENDPOINT,
  consentedAt: null,
  lastSentAt: null,
  nextScheduledAt: null,
};

function serialize(state: TelemetryStateFile): string {
  return JSON.stringify(state, null, 2);
}

function parse(data: Buffer): TelemetryStateFile {
  return { ...DEFAULTS, ...(JSON.parse(data.toString('utf8')) as Partial<TelemetryStateFile>) };
}

function readFailed(err: unknown): TelemetryStateFile {
  // Unreadable is not missing: answer with the defaults (so nothing is
  // sent on a guess) but leave the file alone, or a passing read error
  // would switch the admin's consent off for good.
  logger.warn('telemetry: state read failed', {
    error: err instanceof Error ? err.message : String(err),
  });
  return { ...DEFAULTS };
}

/**
 * The state with its stored version (null when it couldn't be read), for a
 * compare-and-set. Throws StoreUnavailableError when the shared store is down.
 */
export async function loadStateVersioned(): Promise<{ state: TelemetryStateFile; version: string | null }> {
  const docs = telemetryDocs();
  let current;
  try {
    current = await docs.get(STATE_DOC);
  } catch (err) {
    if (isStoreUnavailable(err)) throw err;
    return { state: readFailed(err), version: null };
  }
  if (current) {
    try {
      return { state: parse(current.data), version: current.version };
    } catch (err) {
      return { state: readFailed(err), version: null };
    }
  }
  // First-ever load on a fresh install: persist the default-off state so the
  // instance id and (lack of) consent are stable across restarts. The admin
  // can opt in later via the UI or the BULWARK_TELEMETRY env var.
  const fresh: TelemetryStateFile = { ...DEFAULTS };
  const written = await docs.put(STATE_DOC, serialize(fresh), { ifVersion: null });
  if (written.ok) return { state: fresh, version: written.version };
  // Another replica created it first.
  return written.current
    ? { state: parse(written.current.data), version: written.current.version }
    : { state: fresh, version: null };
}

export async function loadState(): Promise<TelemetryStateFile> {
  return (await loadStateVersioned()).state;
}

export async function saveState(state: TelemetryStateFile): Promise<void> {
  await telemetryDocs().put(STATE_DOC, serialize(state));
}

/**
 * Change some fields of the stored state without undoing a write that
 * landed meanwhile (another replica scheduling, the admin changing consent).
 * `change` may run more than once. Returns the state written. A state file
 * that doesn't parse throws StoredDataUnreadableError and is left as it is.
 */
export async function updateState(change: (state: TelemetryStateFile) => void): Promise<TelemetryStateFile> {
  let next: TelemetryStateFile = { ...DEFAULTS };
  await telemetryDocs().update(STATE_DOC, (current) => {
    let state: TelemetryStateFile;
    try {
      state = current ? parse(current) : { ...DEFAULTS };
    } catch (err) {
      // Unreadable is not missing, here as on reads: writing the defaults
      // with one change would throw away the admin's consent and endpoint.
      throw new StoredDataUnreadableError('telemetry state', { cause: err });
    }
    change(state);
    next = state;
    return serialize(state);
  });
  return next;
}

/**
 * Write `state` only if the stored state is still at `version` (from
 * loadStateVersioned). False when something else wrote first.
 */
export async function saveStateIfUnchanged(state: TelemetryStateFile, version: string | null): Promise<boolean> {
  if (version === null) return false;
  return (await telemetryDocs().put(STATE_DOC, serialize(state), { ifVersion: version })).ok;
}

function errorsEnvOverride(): ErrorsConsent | null {
  const v = (process.env.BULWARK_TELEMETRY_ERRORS ?? '').toLowerCase();
  if (v === 'off' || v === 'false' || v === '0' || v === 'no') return 'off';
  if (v === 'on' || v === 'true' || v === '1' || v === 'yes' || v === 'daily') return 'on';
  if (v === 'instant') return 'instant';
  return null;
}

/**
 * Effective consent to send error counts (schema v2): off whenever
 * telemetry itself is off (which covers the no-third-party mode), then
 * BULWARK_TELEMETRY_ERRORS, then the stored choice, off by default.
 * 'on' sends them daily with the heartbeat; 'instant' does that too and
 * also sends the current day's counts as they change.
 */
export async function effectiveErrorsConsent(): Promise<{
  consent: ErrorsConsent;
  source: 'telemetry' | 'no-third-party' | 'env' | 'file';
}> {
  const telemetry = await effectiveConsent();
  if (telemetry.source === 'no-third-party') return { consent: 'off', source: 'no-third-party' };
  if (telemetry.consent !== 'on') return { consent: 'off', source: 'telemetry' };
  const env = errorsEnvOverride();
  if (env) return { consent: env, source: 'env' };
  const stored = telemetry.state.errorsConsent;
  return { consent: stored === 'on' || stored === 'instant' ? stored : 'off', source: 'file' };
}

// Effective consent: the no-third-party mode wins over everything (#903),
// then the env var, then the file. UI changes are blocked when either
// override is active so the user knows where it's coming from.
export async function effectiveConsent(): Promise<{
  consent: ConsentState;
  source: 'no-third-party' | 'env' | 'file';
  state: TelemetryStateFile;
}> {
  const envState = envOverride();
  const state = await loadState();
  if (await isNoThirdPartyTrafficOn()) return { consent: 'off', source: 'no-third-party', state };
  if (envState) return { consent: envState, source: 'env', state };
  return { consent: state.consent, source: 'file', state };
}

export function endpointEnabled(endpoint: string | undefined): boolean {
  return !!endpoint && endpoint.trim().length > 0;
}
