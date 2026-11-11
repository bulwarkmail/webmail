import { logger } from '@/lib/logger';
import { isSharedMode } from '@/lib/shared-store';
import { isSealed, seal, secretFields, type SettingDeclaration } from '@/lib/plugin-secrets/sealed';
import { assertWritable } from './paths';
import { isStoreUnavailable } from './admin-store';
import { pluginConfigDocs } from './extension-store';

/**
 * Admin config of each plugin (C/plugin-config/<id>.json, or the shared
 * store in shared mode, #1066). Changes go through update(), so two admins
 * setting different keys at once both keep theirs, on one instance or
 * several.
 *
 * A value entered into a `secret` field is stored with a mark: the document's
 * `$secret` entry lists the keys whose values are secrets. The mark belongs
 * to the value, not to the plugin version, so it stays when a later version
 * declares the key differently. Readers get a marked value sealed
 * (lib/plugin-secrets/sealed.ts). `$` is in no setting key, so the entry
 * never collides with one.
 */

const fileOf = (pluginId: string) => `${pluginId}.json`;

/** The entry of a stored config that lists the keys holding secrets. */
const SECRET_KEYS_ENTRY = '$secret';

/** Shared mode: the last config document read per plugin, served while the store is down. */
const LAST_GOOD_KEY = Symbol.for('bulwark.admin.pluginConfig.lastGood');
function lastGood(): Map<string, string> {
  const g = globalThis as typeof globalThis & { [LAST_GOOD_KEY]?: Map<string, string> };
  return (g[LAST_GOOD_KEY] ??= new Map());
}

/** A stored document: every entry, the list of secret keys included. */
type StoredConfig = Record<string, unknown>;

function parseConfig(pluginId: string, data: Buffer | null): StoredConfig {
  if (!data) return {};
  try {
    const parsed: unknown = JSON.parse(data.toString('utf-8'));
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as StoredConfig) : {};
  } catch (error) {
    logger.warn(`Failed to read plugin config for ${pluginId}`, {
      error: error instanceof Error ? error.message : 'Unknown error',
    });
    return {};
  }
}

function secretKeysOf(stored: StoredConfig): string[] {
  const list = stored[SECRET_KEYS_ENTRY];
  return Array.isArray(list) ? list.filter((key): key is string => typeof key === 'string') : [];
}

/** Write the list of secret keys back: only keys that still hold a value, and no entry when none does. */
function setSecretKeys(stored: StoredConfig, keys: Iterable<string>): void {
  const kept = [...new Set(keys)].filter((key) => key !== SECRET_KEYS_ENTRY && Object.hasOwn(stored, key)).sort();
  if (kept.length > 0) stored[SECRET_KEYS_ENTRY] = kept;
  else delete stored[SECRET_KEYS_ENTRY];
}

/** A stored document as readers get it: the settings by key, the secrets among them sealed. */
function settingsOf(stored: StoredConfig): Record<string, unknown> {
  const secret = new Set(secretKeysOf(stored));
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(stored)) {
    if (key === SECRET_KEYS_ENTRY) continue;
    out[key] = secret.has(key) ? seal(value) : value;
  }
  return out;
}

/**
 * Get all config for a plugin. A value that was stored as a secret comes
 * back sealed: see lib/plugin-secrets/sealed.ts for who may open it.
 */
export async function getPluginConfig(pluginId: string): Promise<Record<string, unknown>> {
  let data: Buffer | null;
  try {
    data = (await pluginConfigDocs().get(fileOf(pluginId)))?.data ?? null;
  } catch (error) {
    if (isStoreUnavailable(error)) {
      const last = lastGood().get(pluginId);
      if (last !== undefined) return settingsOf(JSON.parse(last));
      throw error;
    }
    logger.warn(`Failed to read plugin config for ${pluginId}`, {
      error: error instanceof Error ? error.message : 'Unknown error',
    });
    return {};
  }
  const stored = parseConfig(pluginId, data);
  if (isSharedMode()) lastGood().set(pluginId, JSON.stringify(stored));
  return settingsOf(stored);
}

/**
 * Change the stored document. `change` returns false to leave it as it is,
 * so nothing is written.
 */
async function changeConfig(pluginId: string, change: (stored: StoredConfig) => void | false): Promise<void> {
  const result = await pluginConfigDocs().update(fileOf(pluginId), (current) => {
    const stored = parseConfig(pluginId, current);
    if (change(stored) === false) return undefined;
    // The last key gone: the file goes too.
    return Object.keys(stored).length === 0 ? null : JSON.stringify(stored, null, 2);
  });
  if (result.data === undefined) return;
  if (isSharedMode()) lastGood().set(pluginId, result.data ? result.data.toString('utf-8') : '{}');
}

/**
 * Set a single config key for a plugin. `kind` is how the installed version
 * declares the key when the value is entered: a value entered into a `secret`
 * field is marked as a secret, and one entered into any other field replaces
 * a secret that was stored under the key before.
 */
export async function setPluginConfig(
  pluginId: string,
  key: string,
  value: unknown,
  kind: 'plain' | 'secret' = 'plain',
): Promise<void> {
  assertWritable('update plugin config');
  if (key === SECRET_KEYS_ENTRY) throw new Error('Invalid plugin config key');
  await changeConfig(pluginId, (stored) => {
    stored[key] = value;
    const secret = new Set(secretKeysOf(stored));
    if (kind === 'secret') secret.add(key);
    else secret.delete(key);
    setSecretKeys(stored, secret);
  });
}

/**
 * Mark what is stored under the `secret` fields of a schema as secrets. Run
 * with the installed version's schema before another version replaces it, so
 * a value entered before marks existed, or entered while the field was
 * declared otherwise, is a secret from then on too. Writes nothing when
 * every such value is marked already.
 */
export async function sealPluginSecrets(
  pluginId: string,
  schema: Record<string, SettingDeclaration> | null | undefined,
): Promise<void> {
  const fields = secretFields(schema);
  if (fields.length === 0) return;
  const settings = await getPluginConfig(pluginId);
  if (!fields.some((key) => Object.hasOwn(settings, key) && !isSealed(settings[key]))) return;
  assertWritable('update plugin config');
  await changeConfig(pluginId, (stored) => {
    const secret = new Set(secretKeysOf(stored));
    const before = secret.size;
    for (const key of fields) if (Object.hasOwn(stored, key)) secret.add(key);
    if (secret.size === before) return false;
    setSecretKeys(stored, secret);
  });
}

/** Remove all stored config, secrets included, when a plugin is deleted. */
export async function deletePluginConfig(pluginId: string): Promise<void> {
  assertWritable('delete plugin config');
  try {
    await pluginConfigDocs().delete(fileOf(pluginId));
  } catch (error) {
    // None stored is fine; a store outage is not.
    if (isStoreUnavailable(error)) throw error;
  }
  lastGood().delete(pluginId);
}

/**
 * Delete a single config key for a plugin, with its mark.
 */
export async function deletePluginConfigKey(pluginId: string, key: string): Promise<void> {
  assertWritable('delete plugin config key');
  if (key === SECRET_KEYS_ENTRY) return;
  await changeConfig(pluginId, (stored) => {
    delete stored[key];
    setSecretKeys(stored, secretKeysOf(stored));
  });
}
