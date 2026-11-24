/**
 * This browser's side of plugin sync (#1327, lib/plugin-sync.ts): per
 * account, the synced entries with the time each last changed. The values of
 * on/off and settings live in the plugin store; storage values live under
 * the plugin's api.storage keys. The record only says when each changed, and
 * holds the value as it was last synced.
 *
 * Deliberately free of store imports: the settings store says which account
 * syncs and listens for changes (setPluginSyncAccount, onPluginSyncChange),
 * the plugin store says how to read and apply plugins (connectSyncedPrefs).
 */

import {
  MAX_SYNCED_STORAGE_PER_PLUGIN, mergePluginSync, parsePluginSync, parsePluginSyncKey, pluginSyncKey, syncedStorageSize,
  type PluginSyncEntries, type PluginSyncEntry,
} from '../plugin-sync';
import { PLUGIN_SYNC_RECORD_PREFIX as RECORD_PREFIX, pluginStoragePrefix } from './storage-scope';

/** The oldest a change can be: it loses to anything the account has. */
const OLDEST = 1;

export const SYNCED_STORAGE_FULL = 'Synced plugin storage is full';

interface Connection {
  /** The plugin's on/off and settings here, for an export; null when it isn't installed. */
  pluginState: (pluginId: string) => { managed: boolean; enabled: boolean; chosen: boolean; settings: Record<string, unknown> } | null;
  /** Every installed plugin's id. */
  pluginIds: () => string[];
  /** Apply what another device chose. Must not stamp a change. */
  applyOn: (pluginId: string, on: boolean) => void;
  applySettings: (pluginId: string, settings: Record<string, unknown>) => void;
}

let connection: Connection | null = null;
// What arrived from the account before the plugin store was there to take it.
let pending: { pluginId: string; on?: boolean; settings?: Record<string, unknown> }[] = [];
let targetAccount: () => string | null = () => null;
const changeListeners = new Set<() => void>();

export function connectSyncedPrefs(next: Connection | null): void {
  connection = next;
  if (!next) return;
  const waiting = pending;
  pending = [];
  for (const item of waiting) {
    if (item.on !== undefined) next.applyOn(item.pluginId, item.on);
    if (item.settings) next.applySettings(item.pluginId, item.settings);
  }
}

/** The account settings sync with now, or null when sync is off. */
export function setPluginSyncAccount(source: () => string | null): void {
  targetAccount = source;
}

/** Called after each change here that should go up. */
export function onPluginSyncChange(listener: () => void): () => void {
  changeListeners.add(listener);
  return () => { changeListeners.delete(listener); };
}

function recordKey(accountId: string): string {
  return `${RECORD_PREFIX}${encodeURIComponent(accountId)}`;
}

function readRecord(accountId: string): PluginSyncEntries {
  try {
    const raw = localStorage.getItem(recordKey(accountId));
    return (raw && parsePluginSync(JSON.parse(raw))) || {};
  } catch {
    return {};
  }
}

function writeRecord(accountId: string, entries: PluginSyncEntries): void {
  try {
    localStorage.setItem(recordKey(accountId), JSON.stringify(entries));
  } catch {
    // Storage full or blocked: this page still has it.
  }
}

/** A change time later than `previous`, so two changes in one millisecond still order. */
function nextAt(previous: number | undefined): number {
  return Math.max(Date.now(), (previous ?? 0) + 1);
}

function stamp(accountId: string, key: string, entry: Omit<PluginSyncEntry, 'at'>, at?: number): void {
  const record = readRecord(accountId);
  record[key] = { ...entry, at: at ?? nextAt(record[key]?.at) };
  writeRecord(accountId, record);
  for (const listener of changeListeners) listener();
}

/** The user turned an admin's plugin on or off here. */
export function stampPluginOn(pluginId: string, on: boolean): void {
  const accountId = targetAccount();
  if (accountId) stamp(accountId, pluginSyncKey.on(pluginId), { v: on });
}

/** The user changed a plugin's settings here. */
export function stampPluginSettings(pluginId: string, settings: Record<string, unknown>): void {
  const accountId = targetAccount();
  if (accountId) stamp(accountId, pluginSyncKey.settings(pluginId), { v: settings });
}

/** What the account chose for a plugin, for a plugin that arrives in this browser after the choice did. */
export function syncedPluginOn(pluginId: string): boolean | undefined {
  const accountId = targetAccount();
  const v = accountId ? readRecord(accountId)[pluginSyncKey.on(pluginId)]?.v : undefined;
  return typeof v === 'boolean' ? v : undefined;
}

export function syncedPluginSettings(pluginId: string): Record<string, unknown> | undefined {
  const accountId = targetAccount();
  const v = accountId ? readRecord(accountId)[pluginSyncKey.settings(pluginId)]?.v : undefined;
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : undefined;
}

/** Whether this storage key of the plugin syncs for the account. */
export function isSyncedStorageKey(pluginId: string, accountId: string, key: string): boolean {
  const entry = readRecord(accountId)[pluginSyncKey.storage(pluginId, key)];
  return !!entry && !entry.gone;
}

/**
 * api.storage.set with `{ sync: true }`, or of a key that already syncs:
 * checks the plugin's synced quota, before the caller writes the value.
 * `previous` is the value stored here until now (its JSON), for the first
 * sync of a key the browser already had: that counts as the oldest change,
 * so the account's copy wins over it and it only goes up when the account
 * has none.
 */
export function stampSyncedStorage(pluginId: string, accountId: string, key: string, serialized: string, previous: string | null): void {
  const record = readRecord(accountId);
  const entryKey = pluginSyncKey.storage(pluginId, key);
  const value = JSON.parse(serialized) as unknown;
  const used = syncedStorageSize(record, pluginId, entryKey);
  if (used + key.length + serialized.length > MAX_SYNCED_STORAGE_PER_PLUGIN) {
    throw new Error(`${SYNCED_STORAGE_FULL} (${Math.round(MAX_SYNCED_STORAGE_PER_PLUGIN / 1024)} KB per account)`);
  }
  const existing = record[entryKey];
  const firstSyncOfOwnValue = (!existing || existing.gone) && previous === serialized;
  stamp(accountId, entryKey, { v: value }, firstSyncOfOwnValue ? Math.max(OLDEST, existing?.at ?? 0) : undefined);
}

/** api.storage.remove of a synced key: removed on every device. */
export function stampSyncedStorageRemoved(pluginId: string, accountId: string, key: string): void {
  if (!isSyncedStorageKey(pluginId, accountId, key)) return;
  stamp(accountId, pluginSyncKey.storage(pluginId, key), { gone: true });
}

/**
 * What goes up for the account: the record, with on/off and settings as
 * they are now. On/off of an admin's plugin and settings chosen before this
 * browser kept a record go up as the oldest change, so another browser's
 * newer choice isn't overwritten.
 */
export function exportPluginSync(accountId: string): PluginSyncEntries {
  const record = readRecord(accountId);
  let added = false;
  for (const pluginId of connection?.pluginIds() ?? []) {
    const state = connection?.pluginState(pluginId);
    if (!state) continue;
    const onKey = pluginSyncKey.on(pluginId);
    if (state.managed && state.chosen && !record[onKey]) {
      record[onKey] = { at: OLDEST, v: state.enabled };
      added = true;
    }
    const settingsKey = pluginSyncKey.settings(pluginId);
    if (!record[settingsKey] && Object.keys(state.settings).length > 0) {
      record[settingsKey] = { at: OLDEST, v: state.settings };
      added = true;
    }
  }
  if (added) writeRecord(accountId, record);
  return record;
}

/**
 * Take what the account has: per entry the newer change wins. What came from
 * the account goes into the plugin store and the plugin's storage here.
 */
export function importPluginSync(accountId: string, value: unknown): void {
  const incoming = parsePluginSync(value);
  if (!incoming) return;
  const record = readRecord(accountId);
  const merged = mergePluginSync(record, incoming);
  writeRecord(accountId, merged);
  for (const [key, entry] of Object.entries(merged)) {
    if (record[key] && record[key].at >= entry.at) continue;
    const part = parsePluginSyncKey(key);
    if (!part) continue;
    if (part.part === 'on' && typeof entry.v === 'boolean') {
      if (connection) connection.applyOn(part.pluginId, entry.v);
      else pending.push({ pluginId: part.pluginId, on: entry.v });
    } else if (part.part === 'settings' && entry.v && typeof entry.v === 'object') {
      const settings = entry.v as Record<string, unknown>;
      if (connection) connection.applySettings(part.pluginId, settings);
      else pending.push({ pluginId: part.pluginId, settings });
    } else if (part.part === 'storage') {
      const storageKey = pluginStoragePrefix(part.pluginId, accountId) + part.key;
      try {
        if (entry.gone) localStorage.removeItem(storageKey);
        else localStorage.setItem(storageKey, JSON.stringify(entry.v));
      } catch {
        // Storage full or blocked.
      }
    }
  }
}
