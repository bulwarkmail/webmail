/**
 * Plugin choices that follow the account through Settings Sync (#1327):
 * whether an admin's plugin is on, each plugin's user settings, and the
 * api.storage keys a plugin stored with `{ sync: true }`.
 *
 * They ride in the synced settings blob under `pluginSync`, as entries keyed
 * `<pluginId>|on`, `<pluginId>|settings` and `<pluginId>|s:<key>`. Each entry
 * carries the time it last changed; per entry the newer change wins, on the
 * server (mergeStoredPluginSync) and in the browser alike. A removed storage
 * key stays as a tombstone for a while, so another device doesn't bring it
 * back.
 *
 * Nothing secret is in here: user settings and api.storage are documented as
 * no place for secrets, a plugin's own keys are credentials kept on the server
 * (lib/plugin-secrets), and the admin's secret config never reaches a browser.
 * The blob itself is stored encrypted, one per account, readable by that
 * account only (lib/settings-sync.ts).
 *
 * Free of store imports: the settings route uses it too.
 */

export const PLUGIN_SYNC_FIELD = 'pluginSync';

export interface PluginSyncEntry {
  /** When it last changed, ms since the epoch. */
  at: number;
  /** The value: on/off, the settings object, or a storage value. */
  v?: unknown;
  /** A storage key that was removed. */
  gone?: true;
}

export type PluginSyncEntries = Record<string, PluginSyncEntry>;

export type PluginSyncPart =
  | { pluginId: string; part: 'on' }
  | { pluginId: string; part: 'settings' }
  | { pluginId: string; part: 'storage'; key: string };

/** Removed storage keys are forgotten after this long. */
export const PLUGIN_SYNC_TOMBSTONE_TTL_MS = 90 * 24 * 60 * 60 * 1000;
/** What one plugin may keep in synced storage per account (values and keys, UTF-16 units). */
export const MAX_SYNCED_STORAGE_PER_PLUGIN = 16 * 1024;
/** The whole of `pluginSync` in one blob, as JSON. */
export const MAX_PLUGIN_SYNC_BYTES = 512 * 1024;

const PLUGIN_ID = /^[a-z0-9][a-z0-9-]*[a-z0-9]$/;
const MAX_STORAGE_KEY = 256;

export const pluginSyncKey = {
  on: (pluginId: string) => `${pluginId}|on`,
  settings: (pluginId: string) => `${pluginId}|settings`,
  storage: (pluginId: string, key: string) => `${pluginId}|s:${key}`,
};

export function parsePluginSyncKey(key: string): PluginSyncPart | null {
  const bar = key.indexOf('|');
  if (bar <= 0) return null;
  const pluginId = key.slice(0, bar);
  if (!PLUGIN_ID.test(pluginId)) return null;
  const rest = key.slice(bar + 1);
  if (rest === 'on') return { pluginId, part: 'on' };
  if (rest === 'settings') return { pluginId, part: 'settings' };
  if (rest.startsWith('s:') && rest.length > 2 && rest.length - 2 <= MAX_STORAGE_KEY) {
    return { pluginId, part: 'storage', key: rest.slice(2) };
  }
  return null;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** One entry as kept, or null when it isn't one. */
function parseEntry(key: string, value: unknown): PluginSyncEntry | null {
  const part = parsePluginSyncKey(key);
  if (!part || !isPlainObject(value)) return null;
  const at = value.at;
  if (typeof at !== 'number' || !Number.isFinite(at) || at <= 0) return null;
  if (part.part === 'storage' && value.gone === true) return { at, gone: true };
  if (part.part === 'on') return typeof value.v === 'boolean' ? { at, v: value.v } : null;
  if (part.part === 'settings') return isPlainObject(value.v) ? { at, v: value.v } : null;
  return value.v === undefined ? null : { at, v: value.v };
}

/**
 * The entries of a `pluginSync` value from a blob or a push; malformed ones
 * are dropped. Null when it isn't an object at all (a blob from before
 * plugin sync), so callers can tell "nothing synced yet" from "empty".
 */
export function parsePluginSync(value: unknown): PluginSyncEntries | null {
  if (!isPlainObject(value)) return null;
  const out: PluginSyncEntries = {};
  for (const [key, entry] of Object.entries(value)) {
    const parsed = parseEntry(key, entry);
    if (parsed) out[key] = parsed;
  }
  return out;
}

/**
 * Both sides together: per entry the newer change wins, a tie keeps `base`.
 * Tombstones past the TTL are dropped.
 */
export function mergePluginSync(base: PluginSyncEntries, incoming: PluginSyncEntries, now = Date.now()): PluginSyncEntries {
  const out: PluginSyncEntries = { ...base };
  for (const [key, entry] of Object.entries(incoming)) {
    const current = out[key];
    if (!current || entry.at > current.at) out[key] = entry;
  }
  const cutoff = now - PLUGIN_SYNC_TOMBSTONE_TTL_MS;
  for (const [key, entry] of Object.entries(out)) {
    if (entry.gone && entry.at < cutoff) delete out[key];
  }
  return out;
}

/** Synced storage one plugin takes up in these entries, in UTF-16 units. */
export function syncedStorageSize(entries: PluginSyncEntries, pluginId: string, except?: string): number {
  const prefix = pluginSyncKey.storage(pluginId, '');
  let used = 0;
  for (const [key, entry] of Object.entries(entries)) {
    if (!key.startsWith(prefix) || key === except || entry.gone) continue;
    used += key.length - prefix.length + (JSON.stringify(entry.v)?.length ?? 0);
  }
  return used;
}

/**
 * Server side of the merge, when a blob is saved: a push carries what one
 * browser knows, so without this a browser that hasn't loaded since another
 * changed a plugin's settings would put the old ones back. A push without
 * `pluginSync` (an older build) keeps what is stored. A merged value past
 * MAX_PLUGIN_SYNC_BYTES keeps what was stored.
 */
export function mergeStoredPluginSync(
  stored: Record<string, unknown> | null,
  incoming: Record<string, unknown>,
  now = Date.now(),
): Record<string, unknown> {
  const before = stored ? parsePluginSync(stored[PLUGIN_SYNC_FIELD]) : null;
  const pushed = parsePluginSync(incoming[PLUGIN_SYNC_FIELD]);
  const keep = (entries: PluginSyncEntries | null): Record<string, unknown> => {
    const rest = { ...incoming };
    delete rest[PLUGIN_SYNC_FIELD];
    return entries ? { ...rest, [PLUGIN_SYNC_FIELD]: entries } : rest;
  };
  if (!pushed) return keep(before);
  const merged = mergePluginSync(before ?? {}, pushed, now);
  return keep(JSON.stringify(merged).length > MAX_PLUGIN_SYNC_BYTES ? before : merged);
}
