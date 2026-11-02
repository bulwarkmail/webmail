import { getStore, isStoreUnavailableError, type CollectionOptions, type DocCollection } from '@/lib/shared-store';
import { getConfigDir, getStateDir } from './paths';

/**
 * Where the admin dashboard's own documents live (#1066). Local mode: the
 * admin config dir and state dir, with today's file names and temp names
 * (`<file>.tmp`). Shared mode: the shared store, except that read-only
 * config (ADMIN_CONFIG_READONLY) is read from the mounted files.
 */

const fixedTmpName = (target: string) => `${target}.tmp`;

/** config.json, policy.json, admin.json, .config-locked. */
export const ADMIN_CONFIG_COLLECTION = 'admin-config';
export const adminConfigOptions: CollectionOptions = {
  // Owner-only: config.json carries the session secret, admin.json the password hash.
  local: { dir: () => getConfigDir(), mode: 0o600, tmpName: fixedTmpName },
  configDir: true,
};

/** admin-state.json, and other runtime state of the admin dashboard. */
export const ADMIN_STATE_COLLECTION = 'admin-state';
export const adminStateOptions: CollectionOptions = {
  local: { dir: () => getStateDir(), tmpName: fixedTmpName },
};

export function adminConfigDocs(): DocCollection {
  return getStore().collection(ADMIN_CONFIG_COLLECTION, adminConfigOptions);
}

export function adminStateDocs(): DocCollection {
  return getStore().collection(ADMIN_STATE_COLLECTION, adminStateOptions);
}

/** Whether `error` is the shared store's StoreUnavailableError, from any bundle's module copy. */
export function isStoreUnavailable(error: unknown): boolean {
  return isStoreUnavailableError(error);
}
