import { scrypt, randomBytes, timingSafeEqual } from 'node:crypto';
import { logger } from '@/lib/logger';
import { isSharedMode, type DocCollection, type PutOptions, type PutResult, type StoredDoc } from '@/lib/shared-store';
import { announceChange, onSharedChange } from '@/lib/shared-store/changes';
import { assertWritable, isConfigReadOnly } from './paths';
import { adminConfigDocs, adminStateDocs, isStoreUnavailable } from './admin-store';
import type { AdminConfigData, AdminStateData } from './types';
import { readFileEnv } from '../read-file-env';

const SCRYPT_KEYLEN = 64;
const SCRYPT_COST = 16384; // 2^14
const SCRYPT_BLOCK_SIZE = 8;
const SCRYPT_PARALLELIZATION = 1;
const SALT_LENGTH = 32;

const ADMIN_CONFIG_FILE = 'admin.json';
const ADMIN_STATE_FILE = 'admin-state.json';

function hashPassword(password: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const salt = randomBytes(SALT_LENGTH);
    scrypt(password, salt, SCRYPT_KEYLEN, { N: SCRYPT_COST, r: SCRYPT_BLOCK_SIZE, p: SCRYPT_PARALLELIZATION }, (err, derivedKey) => {
      if (err) return reject(err);
      // Format: $scrypt$N=16384,r=8,p=1$<salt_base64>$<hash_base64>
      const params = `N=${SCRYPT_COST},r=${SCRYPT_BLOCK_SIZE},p=${SCRYPT_PARALLELIZATION}`;
      resolve(`$scrypt$${params}$${salt.toString('base64')}$${derivedKey.toString('base64')}`);
    });
  });
}

function verifyPassword(password: string, stored: string): Promise<boolean> {
  return new Promise((resolve, reject) => {
    if (stored.startsWith('$scrypt$')) {
      const parts = stored.split('$');
      if (parts.length !== 5) return resolve(false);
      const paramStr = parts[2];
      const salt = Buffer.from(parts[3], 'base64');
      const storedHash = Buffer.from(parts[4], 'base64');

      const params: Record<string, number> = {};
      for (const p of paramStr.split(',')) {
        const [k, v] = p.split('=');
        params[k] = parseInt(v, 10);
      }

      scrypt(password, salt, storedHash.length, { N: params.N, r: params.r, p: params.p }, (err, derivedKey) => {
        if (err) return reject(err);
        resolve(timingSafeEqual(derivedKey, storedHash));
      });
    } else {
      resolve(false);
    }
  });
}

function isHashed(value: string): boolean {
  return value.startsWith('$scrypt$') || value.startsWith('$2a$') || value.startsWith('$2b$');
}

// ─── Storage ────────────────────────────────────────────────────────────────
//
// admin.json lives in the admin config collection, admin-state.json in the
// admin state collection (lib/admin/admin-store.ts): today's files in local
// mode, the shared store with several replicas (#1066).

function parseJson<T>(data: Buffer, what: string): T | null {
  try {
    return JSON.parse(data.toString('utf-8')) as T;
  } catch (error) {
    logger.warn('Failed to read admin file', {
      file: what,
      error: error instanceof Error ? error.message : 'Unknown error',
    });
    return null;
  }
}

/**
 * A stored admin document, or null when it's missing or unreadable (logged).
 * With a shared store, an unreachable store throws instead: "no admin
 * password" would be the wrong answer.
 */
async function readDoc<T>(docs: DocCollection, id: string): Promise<{ data: T; version: string } | null> {
  let doc: StoredDoc | null;
  try {
    doc = await docs.get(id);
  } catch (error) {
    if (isStoreUnavailable(error)) throw error;
    logger.warn('Failed to read admin file', { file: id, error: error instanceof Error ? error.message : 'Unknown error' });
    return null;
  }
  if (!doc) return null;
  const data = parseJson<T>(doc.data, id);
  return data ? { data, version: doc.version } : null;
}

function readConfigDoc() {
  return readDoc<AdminConfigData>(adminConfigDocs(), ADMIN_CONFIG_FILE);
}

async function readStateData(): Promise<AdminStateData | null> {
  return (await readDoc<AdminStateData>(adminStateDocs(), ADMIN_STATE_FILE))?.data ?? null;
}

/** Owner-only, like the other files that hold secrets (see admin-store.ts). */
async function writeConfigData(data: AdminConfigData, options: PutOptions = {}): Promise<PutResult> {
  assertWritable('save admin password');
  return adminConfigDocs().put(ADMIN_CONFIG_FILE, JSON.stringify(data, null, 2), options);
}

async function writeStateData(data: AdminStateData, options: PutOptions = {}): Promise<PutResult> {
  return adminStateDocs().put(ADMIN_STATE_FILE, JSON.stringify(data, null, 2), options);
}

// ─── Cache & init ───────────────────────────────────────────────────────────

/**
 * What this process knows of admin.json and admin-state.json. On globalThis:
 * Next bundles this module once per entry (each route bundle, the
 * instrumentation), and a copy with its own cache kept accepting the old
 * password after a password change made through another one, until a
 * restart.
 *
 * With a shared store it only answers the synchronous isAdminEnabled() and
 * getAdminMeta(): passwords and sessions are checked against the store, and
 * epoch `admin` refreshes the copy when another replica changes the password.
 */
interface AdminCache {
  config: AdminConfigData | null;
  state: AdminStateData | null;
  initialized: boolean;
  /** Shared mode: one read of the state for checks that run together. */
  stateRead?: Promise<AdminStateData | null>;
  /**
   * The password came from ADMIN_PASSWORD into a read-only config without an
   * admin.json: it lives in this process only, and every replica makes it
   * from the same variable on start.
   */
  fromEnvOnly?: boolean;
  unlisten?: () => void;
}

const CACHE_KEY = Symbol.for('bulwark.admin.password');
const cache: AdminCache = ((globalThis as typeof globalThis & { [CACHE_KEY]?: AdminCache })[CACHE_KEY] ??= {
  config: null,
  state: null,
  initialized: false,
});

/** Forget what this process read, as a restart would (tests). */
export function resetAdminCacheForTests(): void {
  cache.unlisten?.();
  cache.config = null;
  cache.state = null;
  cache.initialized = false;
  cache.stateRead = undefined;
  cache.unlisten = undefined;
  cache.fromEnvOnly = undefined;
}

function freshState(): AdminStateData {
  const now = new Date().toISOString();
  return { createdAt: now, lastLogin: null, passwordChangedAt: now };
}

/**
 * The admin state. Local mode: read once, then from memory, as before.
 * Shared mode: from the store on every call (a sign-out on another replica
 * counts at once); calls that overlap share one read.
 */
async function loadState(): Promise<AdminStateData | null> {
  if (!isSharedMode()) {
    if (!cache.state) cache.state = await readStateData();
    return cache.state;
  }
  cache.stateRead ??= readStateData()
    .then((state) => {
      cache.state = state;
      return state;
    })
    .finally(() => {
      cache.stateRead = undefined;
    });
  return cache.stateRead;
}

/**
 * Change the admin state with `change`. Local mode: from the copy in memory
 * (kept even when the write fails), as before. Shared mode: against the
 * stored state, retried on a concurrent write, so a sign-out on one replica
 * and a sign-in on another both stay. `change` may run more than once.
 */
async function updateState(change: (previous: AdminStateData | null) => AdminStateData): Promise<AdminStateData> {
  if (!isSharedMode()) {
    const next = change(await loadState());
    cache.state = next;
    await writeStateData(next);
    return next;
  }
  const result = await adminStateDocs().update(ADMIN_STATE_FILE, (current) =>
    JSON.stringify(change(current ? parseJson<AdminStateData>(current, ADMIN_STATE_FILE) : null), null, 2),
  );
  const next = result.data ? parseJson<AdminStateData>(result.data, ADMIN_STATE_FILE) : null;
  if (next) cache.state = next;
  return next ?? change(null);
}

/** One session generation on: every admin session of the old password is signed out (a stolen cookie with it). */
function nextGeneration(previous: AdminStateData | null): AdminStateData {
  return { ...freshState(), sessionGeneration: (previous?.sessionGeneration ?? 0) + 1 };
}

/**
 * Fresh state for a new admin password, one session generation on: every
 * admin session of the old password is signed out (a stolen cookie with it).
 */
async function stateForNewPassword(): Promise<AdminStateData> {
  return nextGeneration(await loadState());
}

/** Shared mode: reload the copy when another replica changed the admin password. */
function listenForAdminChanges(): void {
  cache.unlisten?.();
  cache.unlisten = onSharedChange('admin', async (origin) => {
    if (origin === 'local') return;
    cache.config = (await readConfigDoc())?.data ?? null;
    cache.state = await readStateData();
  });
}

/**
 * Initialize admin password on startup.
 * - If admin.json exists, use it (state file may or may not exist; created on first need).
 * - Otherwise, if ADMIN_PASSWORD env var is set, hash and persist it.
 * - Otherwise, admin dashboard stays disabled.
 *
 * With a shared store, a replica that found no admin password looks again
 * on the next call: another replica's setup wizard may have set one.
 */
export async function initAdminPassword(): Promise<boolean> {
  const shared = isSharedMode();
  if (cache.initialized && (!shared || cache.config)) return cache.config !== null;
  if (shared && !cache.initialized) listenForAdminChanges();

  const existing = await readConfigDoc();
  if (existing) {
    cache.config = existing.data;
    if (shared) {
      let state = await readStateData();
      if (!state) {
        // No state yet (fresh install or import); whoever comes first writes it.
        const fresh = freshState();
        state = (await writeStateData(fresh, { ifVersion: null })).ok ? fresh : (await readStateData()) ?? fresh;
      }
      cache.state = state;
    } else {
      cache.state = (await readStateData()) ?? freshState();
      if (!(await readStateData())) {
        // No state file yet (fresh install or migration); create it.
        try {
          await writeStateData(cache.state);
        } catch {
          /* state dir may not be writable yet during early boot probes */
        }
      }
    }
    if (!cache.initialized) logger.info('Admin dashboard enabled (password loaded from admin.json)');
    cache.initialized = true;
    return true;
  }

  const envPassword = process.env.ADMIN_PASSWORD;
  if (!envPassword) {
    if (!cache.initialized) logger.info('Admin dashboard disabled (no ADMIN_PASSWORD set)');
    cache.initialized = true;
    return false;
  }

  const hash = isHashed(envPassword) ? envPassword : await hashPassword(envPassword);
  const config: AdminConfigData = { passwordHash: hash, passwordHashFile: undefined };
  if (isConfigReadOnly()) {
    // Nowhere to save admin.json (a ConfigMap, a :ro volume). Keep the
    // password in memory instead of failing the start; each replica does the
    // same from the same variable. Changing it in the admin console is
    // refused, as every other write to read-only config is.
    cache.config = config;
    cache.fromEnvOnly = true;
    cache.state = shared ? await readStateData() : (await readStateData()) ?? freshState();
    if (shared && !cache.state) {
      const fresh = freshState();
      cache.state = (await writeStateData(fresh, { ifVersion: null })).ok ? fresh : (await readStateData()) ?? fresh;
    }
    if (!cache.initialized) {
      logger.info('Admin dashboard enabled with ADMIN_PASSWORD (config is read-only, so it is not saved to admin.json)');
    }
    cache.initialized = true;
    return true;
  }
  if (shared) {
    // Replicas booting together with ADMIN_PASSWORD: the first one writes
    // admin.json and moves the session generation on, the others use it.
    const written = await writeConfigData(config, { ifVersion: null });
    if (written.ok) {
      cache.config = config;
      await updateState(nextGeneration);
      await announceChange('admin');
    } else {
      cache.config = written.current ? parseJson<AdminConfigData>(written.current.data, ADMIN_CONFIG_FILE) : null;
      cache.state = await readStateData();
      cache.initialized = true;
      return cache.config !== null;
    }
  } else {
    cache.config = config;
    cache.state = await stateForNewPassword();
    await writeConfigData(cache.config);
    await writeStateData(cache.state);
  }
  cache.initialized = true;
  if (isHashed(envPassword)) {
    logger.info('Admin password hash saved to admin.json from environment variable');
  } else {
    logger.warn('Admin password hashed and saved to admin.json. You may now remove ADMIN_PASSWORD from .env');
  }
  return true;
}

function verifyAgainst(config: AdminConfigData, password: string): Promise<boolean> {
  if (config.passwordHash) {
    return verifyPassword(password, config.passwordHash);
  } else if (config.passwordHashFile) {
    let passwordHash = readFileEnv(config.passwordHashFile);
    if (passwordHash) {
      return verifyPassword(password, passwordHash);
    }
  }
  logger.error('The admin password hash could neither be retrieved from passwordHash nor from passwordHashFile in admin.json');
  return Promise.resolve(false);
}

/**
 * Verify a password against the stored admin hash. With a shared store
 * admin.json is read on every call, so a password changed on another
 * replica counts at once.
 */
export async function verifyAdminPassword(password: string): Promise<boolean> {
  if (cache.fromEnvOnly && cache.config) {
    // A mounted admin.json that appeared later still wins.
    const mounted = (await readConfigDoc())?.data ?? null;
    return verifyAgainst(mounted ?? cache.config, password);
  }
  if (isSharedMode()) {
    cache.config = (await readConfigDoc())?.data ?? null;
  } else if (!cache.config) {
    cache.config = (await readConfigDoc())?.data ?? null;
  }
  const config = cache.config;
  if (!config) return false;
  return verifyAgainst(config, password);
}

/**
 * Two password changes at once (on two replicas): the one that came second
 * was checked against a password that no longer applies.
 */
export class AdminPasswordConflictError extends Error {
  constructor() {
    super('The admin password was changed somewhere else a moment ago. Sign in with the new password and try again.');
    this.name = 'AdminPasswordConflictError';
  }
}

/** By name, as the class may come from another bundle's copy of this module. */
export function isAdminPasswordConflict(error: unknown): error is AdminPasswordConflictError {
  return error instanceof Error && error.name === 'AdminPasswordConflictError';
}

/**
 * Change the admin password. Returns true on success, false when the
 * current password is wrong. Throws AdminPasswordConflictError when another
 * change landed between the check and the write (shared store).
 */
export async function changeAdminPassword(currentPassword: string, newPassword: string): Promise<boolean> {
  const shared = isSharedMode();
  // Shared mode: the version checked is the one replaced, so of two changes
  // at once with the same current password only one goes through.
  const stored = shared ? await readConfigDoc() : null;
  const valid = shared
    ? !!stored && (await verifyAgainst(stored.data, currentPassword))
    : await verifyAdminPassword(currentPassword);
  if (!valid) return false;

  // Write first, then swap the cache: a refused write (read-only config)
  // must not leave the new password active until the next restart.
  const hash = await hashPassword(newPassword);
  const next: AdminConfigData = { passwordHash: hash, passwordHashFile: undefined };
  if (shared) {
    if (!(await writeConfigData(next, { ifVersion: stored!.version })).ok) throw new AdminPasswordConflictError();
  } else {
    await writeConfigData(next);
  }
  cache.config = next;

  const changedAt = new Date().toISOString();
  await updateState((previous) => ({
    ...(previous ?? freshState()),
    passwordChangedAt: changedAt,
    sessionGeneration: (previous?.sessionGeneration ?? 0) + 1,
  }));
  if (shared) await announceChange('admin');
  return true;
}

/**
 * Set the admin password without verifying a current one. Used by the setup
 * wizard during initial bootstrap.
 *
 * Refuses to overwrite an existing password unless `allowOverwrite` is true.
 * The wizard's finish route passes `allowOverwrite: true` so a half-completed
 * setup (admin.json left behind by an ADMIN_PASSWORD env var or an aborted
 * earlier wizard run, while setupComplete is still false) can be recovered
 * by simply running the wizard again. Safe because the finish route is
 * already gated by the one-time setup token.
 */
export async function setInitialAdminPassword(
  newPassword: string,
  options: { allowOverwrite?: boolean } = {},
): Promise<boolean> {
  const existing = await readConfigDoc();
  if (existing && !options.allowOverwrite) return false;
  const hash = await hashPassword(newPassword);
  const config: AdminConfigData = { passwordHash: hash, passwordHashFile: undefined };
  if (isSharedMode()) {
    const written = await writeConfigData(config, options.allowOverwrite ? {} : { ifVersion: null });
    if (!written.ok) return false;
    cache.config = config;
    await updateState(nextGeneration);
    await announceChange('admin');
  } else {
    cache.config = config;
    cache.state = await stateForNewPassword();
    await writeConfigData(cache.config);
    await writeStateData(cache.state);
  }
  cache.initialized = true;
  return true;
}

/**
 * Update the last login timestamp.
 */
export async function updateLastLogin(): Promise<void> {
  if (!cache.config) return;
  const lastLogin = new Date().toISOString();
  try {
    if (isSharedMode()) {
      await updateState((previous) => ({ ...(previous ?? freshState()), lastLogin }));
    } else {
      cache.state = { ...(cache.state ?? freshState()), lastLogin };
      await writeStateData(cache.state);
    }
  } catch (error) {
    logger.warn('Failed to update admin last-login state', {
      error: error instanceof Error ? error.message : 'Unknown error',
    });
  }
}

/**
 * Check if admin dashboard is enabled (has a password configured).
 */
export function isAdminEnabled(): boolean {
  return cache.config !== null;
}

/**
 * Get admin metadata (without the hash).
 */
export function getAdminMeta(): AdminStateData | null {
  if (!cache.config) return null;
  return cache.state ?? freshState();
}

// ─── Admin session sign-out ─────────────────────────────────────────────────

/** The session generation new admin tokens are issued in, and the only one accepted. */
export async function getAdminSessionGeneration(): Promise<number> {
  return (await loadState())?.sessionGeneration ?? 0;
}

export async function isAdminSessionRevoked(sid: string): Promise<boolean> {
  const revoked = (await loadState())?.revokedSessions;
  return !!revoked && Object.prototype.hasOwnProperty.call(revoked, sid);
}

/**
 * Sign one admin token out (logout) until its exp, after which it is refused
 * as expired anyway; expired entries are dropped on the way.
 */
export async function revokeAdminSession(sid: string, exp: number): Promise<void> {
  const now = Math.floor(Date.now() / 1000);
  await updateState((previous) => {
    const revoked = Object.fromEntries(Object.entries(previous?.revokedSessions ?? {}).filter(([, until]) => until >= now));
    revoked[sid] = exp;
    return { ...(previous ?? freshState()), revokedSessions: revoked };
  });
}
