import { logger } from '@/lib/logger';
import { isSharedMode } from '@/lib/shared-store';
import { declarationOf, isOrdinarySetting, seal, secretFields, type SettingDeclaration } from '@/lib/plugin-secrets/sealed';
import { assertWritable, isConfigReadOnly } from './paths';
import { isStoreUnavailable } from './admin-store';
import { pluginConfigDocs } from './extension-store';
import { getPlugin } from './plugin-registry';

/**
 * Admin config of each plugin (C/plugin-config/<id>.json, or the shared
 * store in shared mode, #1066). Changes go through update(), so two admins
 * setting different keys at once both keep theirs, on one instance or
 * several.
 *
 * A stored value is a secret unless it is known to be plain. The document's
 * `$secret` entry lists the keys whose values are secrets; a key that is not
 * on it holds a value that was entered into a field declared with an
 * ordinary kind. The list belongs to the values, not to the plugin version,
 * so it stays when a later version declares a key differently. Readers get
 * a listed value sealed (lib/plugin-secrets/sealed.ts). `$` is in no setting
 * key, so the entry never collides with one.
 *
 * A document without the entry was written before the list existed. The
 * first time it is read or changed it is sorted by the version installed at
 * that moment, and the result is written back: a key that version declares
 * with an ordinary kind is plain, every other key (declared `secret`, not
 * declared, or nothing installed) is a secret.
 */

const fileOf = (pluginId: string) => `${pluginId}.json`;

/** The entry of a stored config that lists the keys holding secrets. */
const SECRET_KEYS_ENTRY = '$secret';

type Declarations = Record<string, SettingDeclaration>;

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

const settingKeys = (stored: StoredConfig): string[] => Object.keys(stored).filter((key) => key !== SECRET_KEYS_ENTRY);

/** Whether the document carries its list, so every value in it is known to be a secret or plain. */
const isSorted = (stored: StoredConfig): boolean => Array.isArray(stored[SECRET_KEYS_ENTRY]);

function secretKeysOf(stored: StoredConfig): string[] {
  const list = stored[SECRET_KEYS_ENTRY];
  return Array.isArray(list) ? list.filter((key): key is string => typeof key === 'string') : [];
}

/** Write the list of secret keys: only keys that hold a value. An empty list still says the document is sorted. */
function setSecretKeys(stored: StoredConfig, keys: Iterable<string>): void {
  stored[SECRET_KEYS_ENTRY] = [...new Set(keys)].filter((key) => key !== SECRET_KEYS_ENTRY && Object.hasOwn(stored, key)).sort();
}

/**
 * Give a document from before the list its list: plain is what `declared`
 * (the version installed now) declares with an ordinary kind, everything
 * else is a secret. `declared` is null when nothing is installed.
 */
function sortByDeclarations(stored: StoredConfig, declared: Declarations | null): void {
  setSecretKeys(stored, settingKeys(stored).filter((key) => !isOrdinarySetting(declarationOf(declared, key))));
}

/** The document as it is stored: null once no setting is left in it. */
const serialise = (stored: StoredConfig): string | null => (settingKeys(stored).length === 0 ? null : JSON.stringify(stored, null, 2));

/** A stored document as readers get it: the settings by key, the secrets among them sealed. Unsorted, all of them are. */
function settingsOf(stored: StoredConfig): Record<string, unknown> {
  const sorted = isSorted(stored);
  const secret = new Set(secretKeysOf(stored));
  const out: Record<string, unknown> = {};
  for (const key of settingKeys(stored)) {
    out[key] = !sorted || secret.has(key) ? seal(stored[key]) : stored[key];
  }
  return out;
}

/**
 * How the version installed under an id declares its settings: the
 * registry's entry, else a plugin from PLUGIN_DEV_DIR. Null when nothing is
 * installed under the id.
 */
async function installedDeclarations(pluginId: string): Promise<Declarations | null> {
  const registered = await getPlugin(pluginId);
  if (registered) return registered.configSchema ?? {};
  const { getDevPlugin } = await import('./plugin-dev');
  const dev = await getDevPlugin(pluginId);
  return dev ? (dev.plugin.configSchema ?? {}) : null;
}

/** Sort the stored document if it still has no list, without losing a change made meanwhile. */
async function writeSorted(pluginId: string, declared: Declarations): Promise<void> {
  const result = await pluginConfigDocs().update(fileOf(pluginId), (current) => {
    const stored = parseConfig(pluginId, current);
    if (isSorted(stored) || settingKeys(stored).length === 0) return undefined;
    sortByDeclarations(stored, declared);
    return JSON.stringify(stored, null, 2);
  });
  if (result.data && isSharedMode()) lastGood().set(pluginId, result.data.toString('utf-8'));
}

/**
 * Get all config for a plugin. A value that is stored as a secret comes back
 * sealed: see lib/plugin-secrets/sealed.ts for who may open it.
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
  if (!isSorted(stored) && settingKeys(stored).length > 0) {
    // From before the list: sorted by what is installed now, and kept that
    // way. With nothing installed nobody reads it and the next install
    // decides (sealPluginSecrets), so that answer is not written.
    const declared = await installedDeclarations(pluginId);
    sortByDeclarations(stored, declared);
    if (declared && !isConfigReadOnly()) {
      try {
        await writeSorted(pluginId, declared);
      } catch (error) {
        logger.warn(`Could not record which settings of ${pluginId} are secrets`, {
          error: error instanceof Error ? error.message : 'Unknown error',
        });
      }
    }
  }
  if (isSharedMode()) lastGood().set(pluginId, JSON.stringify(stored));
  return settingsOf(stored);
}

/**
 * Change the stored document. `change` returns false to leave it as it is.
 * A document from before the list is sorted first, by the version installed
 * now (`declared` when the caller knows it).
 */
async function changeConfig(
  pluginId: string,
  change: (stored: StoredConfig) => void | false,
  declared?: Declarations,
): Promise<void> {
  const before = parseConfig(pluginId, (await pluginConfigDocs().get(fileOf(pluginId)))?.data ?? null);
  const unsorted = !isSorted(before) && settingKeys(before).length > 0;
  const sortBy = declared ?? (unsorted ? await installedDeclarations(pluginId) : null);
  const result = await pluginConfigDocs().update(fileOf(pluginId), (current) => {
    const stored = parseConfig(pluginId, current);
    const wasSorted = isSorted(stored);
    if (!wasSorted) sortByDeclarations(stored, sortBy);
    const changed = change(stored) !== false;
    // Nothing to write: nothing changed, and the document had its list or holds nothing.
    if (!changed && (wasSorted || settingKeys(stored).length === 0)) return undefined;
    return serialise(stored);
  });
  if (result.data === undefined) return;
  if (isSharedMode()) lastGood().set(pluginId, result.data ? result.data.toString('utf-8') : '{}');
}

/**
 * Set a single config key for a plugin. `kind` says how the value was
 * entered: 'plain' into a field declared with an ordinary kind at that
 * moment, 'secret' in every other case. A plain value replaces a secret that
 * was stored under the key before.
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
 * Run before a version of a plugin is saved, with the version installed
 * until now (null when there is none), so nothing stored changes its
 * standing through the save.
 *
 * With a version installed: a document from before the list is sorted by
 * that version, and what is stored under its `secret` fields is listed as
 * a secret, also a value that was entered while the field was declared
 * otherwise. With nothing installed: whatever an earlier plugin left under
 * the id is removed, so the one being installed starts clean. Writes nothing
 * when there is nothing to do, and fails when the document can't be read.
 */
export async function sealPluginSecrets(
  pluginId: string,
  installed: { configSchema?: Declarations | null } | null | undefined,
): Promise<void> {
  const stored = parseConfig(pluginId, (await pluginConfigDocs().get(fileOf(pluginId)))?.data ?? null);
  if (settingKeys(stored).length === 0) return;
  if (!installed) {
    await deletePluginConfig(pluginId);
    return;
  }
  const declared = installed.configSchema ?? {};
  const fields = secretFields(declared);
  const listed = secretKeysOf(stored);
  if (isSorted(stored) && !fields.some((key) => Object.hasOwn(stored, key) && !listed.includes(key))) return;
  assertWritable('update plugin config');
  await changeConfig(pluginId, (current) => {
    const secret = new Set(secretKeysOf(current));
    const before = secret.size;
    for (const key of fields) if (Object.hasOwn(current, key)) secret.add(key);
    if (secret.size === before) return false;
    setSecretKeys(current, secret);
  }, declared);
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
