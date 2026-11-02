import { randomBytes } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import { configManager } from '@/lib/admin/config-manager';
import { ensureStateDir, getStatePath } from '@/lib/admin/paths';
import { readFileEnv } from '@/lib/read-file-env';
import { getStore, isSharedMode } from '@/lib/shared-store';

/** Written on first start when no secret is configured (see ensureSessionSecret). */
export const GENERATED_SECRET_FILE = '.session-secret';

/** Where the generated secret lives in the shared store. */
export const SHARED_SECRET_KEY = 'session-secret';

/**
 * The generated secret as read from the shared store at boot. It never
 * changes once created, so every module copy (proxy, routes) reads it from
 * here without waiting on the store.
 */
const SHARED_CACHE = Symbol.for('bulwark.sessionSecret.shared');
type SecretGlobals = typeof globalThis & { [SHARED_CACHE]?: string };

function sharedSecret(): string {
  return (globalThis as SecretGlobals)[SHARED_CACHE] ?? '';
}

/** A secret the operator set: env, file, or the setup wizard's config. */
function configuredSessionSecret(): string {
  const fromEnv = process.env.SESSION_SECRET;
  if (fromEnv) return fromEnv;

  const fromFile = readFileEnv(process.env.SESSION_SECRET_FILE);
  if (fromFile) return fromFile;

  const fromAdmin = configManager.get<string>('sessionSecret', '');
  if (fromAdmin) return fromAdmin;

  return readFileEnv(configManager.get<string>('sessionSecretFile', '')) || '';
}

/**
 * Resolve the session secret from any of the supported sources, in priority
 * order:
 *   1. SESSION_SECRET env var
 *   2. SESSION_SECRET_FILE-pointed file
 *   3. Admin override in config.json (set by the setup wizard)
 *   4. The secret generated on first start: in the admin state dir, or with
 *      a shared store in the store, one for every replica (#1066)
 *
 * Returns an empty string when nothing is configured. Callers must treat
 * empty as "feature disabled" rather than crashing.
 *
 * The configManager fallback exists so the web installer can persist the
 * secret without touching .env files. It only takes effect if the env vars
 * aren't set, so existing deployments aren't affected.
 */
export function getSessionSecret(): string {
  const configured = configuredSessionSecret();
  if (configured) return configured;
  if (isSharedMode()) return sharedSecret();
  return readFileEnv(getStatePath(GENERATED_SECRET_FILE)) || "";
}

export function hasSessionSecret(): boolean {
  return getSessionSecret().length > 0;
}

/**
 * Generate a session secret when none is configured, so remember me and
 * settings sync work on installs that skip the setup wizard (JMAP_SERVER_URL
 * set in the environment). It lives in the state dir, which is always
 * writable and a volume in docker-compose.yml; without a persistent volume a
 * restart issues a new one and signs everyone out.
 *
 * With a shared store it lives in the store: the first replica creates it
 * and every replica caches the stored value, so replicas starting at the
 * same moment end up with one secret.
 *
 * Returns true when this call wrote a new secret.
 */
export async function ensureSessionSecret(): Promise<boolean> {
  if (isSharedMode()) return ensureSharedSessionSecret();
  if (hasSessionSecret()) return false;
  await ensureStateDir();
  try {
    // 'wx' so two processes starting at once can't overwrite each other's.
    await writeFile(getStatePath(GENERATED_SECRET_FILE), randomBytes(32).toString('base64'), {
      flag: 'wx',
      mode: 0o600,
    });
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') return false;
    throw error;
  }
}

/**
 * Shared mode: create the stored secret if there is none (`value`, or a new
 * random one), then load whatever the store holds into this process. Also
 * called when a configured secret exists, so the stored one (used once the
 * configured one is removed) is loaded either way.
 */
export async function ensureSharedSessionSecret(value?: string): Promise<boolean> {
  const store = getStore();
  const created = await store.kv.set(SHARED_SECRET_KEY, value ?? randomBytes(32).toString('base64'), { ifAbsent: true });
  const stored = await store.kv.get(SHARED_SECRET_KEY);
  if (!stored) throw new Error('The shared store lost the session secret right after writing it');
  (globalThis as SecretGlobals)[SHARED_CACHE] = stored;
  return created;
}

/** The generated secret of this install's state dir, if there is one (the import). */
export function localGeneratedSessionSecret(): string {
  return readFileEnv(getStatePath(GENERATED_SECRET_FILE)) || '';
}

/** Whether the operator configured a secret (env, file or config). */
export function hasConfiguredSessionSecret(): boolean {
  return configuredSessionSecret().length > 0;
}

/** Forget the cached shared secret (tests). */
export function resetSharedSessionSecretForTests(): void {
  delete (globalThis as SecretGlobals)[SHARED_CACHE];
}
