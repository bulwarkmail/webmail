/**
 * Keeps the settings the mobile app has in the private Inbox metadata of the
 * account they sync with, in the app's format (lib/settings-metadata-sync),
 * so a change in the app shows up here and the other way round.
 *
 * It runs next to /api/settings and only while that is on: the instance has
 * settings sync (settingsSyncEnabled), the user hasn't switched it off, and
 * an account is signed in (settings-store's enableSync). The account is the
 * one /api/settings syncs with, the active one, and only on a server that
 * offers private metadata (Stalwart 1.0 and later). Both carry one stamp per
 * setting, so the newer change wins whichever way it came; a setting taken
 * from the metadata is marked to go up to /api/settings with its stamp.
 *
 * A round reads the entries, takes what is newer there and writes what is
 * newer here. Rounds run when sync starts for an account, 2 s after a change
 * here, when the account's mailboxes change on the server (at most every
 * 30 s: new mail changes them too), when the page is shown again or back
 * online, and ten minutes after one that failed.
 */

import { create } from 'zustand';
import { MetadataPatchError, MetadataRefusedError, MetadataTooLargeError, metadataValueBytes } from '@/lib/jmap/bulwark-metadata';
import type { IJMAPClient } from '@/lib/jmap/client-interface';
import { subscribePushStateChanges } from '@/lib/push-events';
import { isAllowedSettingValue, SETTINGS_SCHEMA } from '@/lib/settings-schema';
import {
  MAX_PLAIN_VALUE_BYTES, METADATA_SETTING_NAMES, hasOwnEntry, planSettingsSync, readRemoteSettings, sameJson,
  settingsWrites, type LocalSetting, type SettingPush,
} from '@/lib/settings-metadata-sync';
import { useAccountStore } from './account-store';
import { useAuthStore } from './auth-store';
import { usePolicyStore } from './policy-store';
import {
  acceptMetadataSettingValue, adoptSettingStamps, builtInSettingDefault, CROSS_ACCOUNT_VIEW_KEYS,
  noteSeenSettingStamps, readLocalSettingStamps, registerMetadataSyncHooks, settingsSyncTarget, useSettingsStore,
} from './settings-store';
import { useThemeStore } from './theme-store';

const CHANGE_DELAY_MS = 2000;
/**
 * The part of the account's 16 KB of private metadata the lists may take
 * up, as in the app: the rest stays for the plain settings.
 */
const LIST_BUDGET_BYTES = 12 * 1024;
const SERVER_CHANGE_GAP_MS = 30_000;
const RETRY_MS = 10 * 60_000;

export type SettingsMetadataSyncStatus = 'off' | 'syncing' | 'synced' | 'unsupported' | 'unreachable' | 'full';

interface SettingsMetadataSyncState {
  status: SettingsMetadataSyncStatus;
  lastSyncedAt: number | null;
  /**
   * Values chosen in this browser before it kept stamps that a round
   * replaced with the account's, by name, until the user takes them back
   * (keepReplaced) or lets them go.
   */
  replaced: Record<string, unknown> | null;
  keepReplaced: () => void;
  dismissReplaced: () => void;
}

export const useSettingsMetadataSyncStore = create<SettingsMetadataSyncState>((set, get) => ({
  status: 'off',
  lastSyncedAt: null,
  replaced: null,
  keepReplaced: () => {
    const replaced = get().replaced ?? {};
    set({ replaced: null });
    // Changes made now: they get a stamp and go to the account and the other devices.
    for (const [name, value] of Object.entries(replaced)) {
      if (name === 'theme') useThemeStore.getState().setTheme(value as 'light' | 'dark' | 'system');
      else useSettingsStore.getState().updateSetting(name as never, value as never);
    }
  },
  dismissReplaced: () => set({ replaced: null }),
}));

/** The account a round works for, and the client it goes through. */
interface Target {
  username: string;
  serverUrl: string;
  client: IJMAPClient;
  accountId: string;
}

/** The active account's client, while it is the account settings sync with. */
function currentTarget(): Target | null {
  const target = settingsSyncTarget();
  if (!target) return null;
  const auth = useAuthStore.getState();
  const client = auth.client;
  if (!client || auth.username !== target.username || auth.serverUrl !== target.serverUrl) return null;
  let accountId: string;
  try {
    accountId = client.getAccountId();
  } catch {
    return null;
  }
  return accountId ? { ...target, client, accountId } : null;
}

const sameTarget = (a: Target, b: Target | null) =>
  !!b && a.client === b.client && a.accountId === b.accountId && a.username === b.username && a.serverUrl === b.serverUrl;

/** A value from the account as this browser would keep it, or undefined when it can't use it. */
function accept(name: string, value: unknown): unknown {
  const schema = SETTINGS_SCHEMA[name];
  // A switch takes either value here: `only` limits what a plugin may set.
  if (schema && schema.kind.type !== 'boolean' && !isAllowedSettingValue(schema, value)) return undefined;
  return acceptMetadataSettingValue(name, value, Boolean(schema));
}

/** This browser's side of every setting the app shares. */
function localSettings(): LocalSetting[] {
  const state = useSettingsStore.getState() as unknown as Record<string, unknown> & { explicitSettings: string[] };
  const theme = useThemeStore.getState();
  const stamps = readLocalSettingStamps();
  const explicit = new Set(state.explicitSettings);
  const policy = usePolicyStore.getState();
  // With several logins here, the views spanning them stay as this browser has them.
  const severalAccounts = useAccountStore.getState().accounts.length > 1;
  return METADATA_SETTING_NAMES.map((name) => {
    const defaultValue = builtInSettingDefault(name);
    const value = name === 'theme' ? theme.theme : state[name];
    const chosen = name === 'theme'
      ? theme.themeChosen
      : explicit.has(name) || (hasOwnEntry(defaultValue) && !sameJson(value, defaultValue));
    return {
      name,
      value,
      defaultValue,
      at: stamps[name] ?? 0,
      reset: !chosen,
      chosen,
      locked: policy.isSettingLocked(name) || (severalAccounts && CROSS_ACCOUNT_VIEW_KEYS.has(name)),
      accept: (incoming: unknown) => accept(name, incoming),
    };
  });
}

let timer: ReturnType<typeof setTimeout> | null = null;
let running: Promise<void> | null = null;
let again = false;
let lastRoundAt = 0;
// Mailbox states our own writes produced: their push is not another device's change.
const ownStates = new Set<string>();
// Lists refused for their size, with the stamp refused: offered again once they change.
const refusedAt = new Map<string, number>();
let refusedFor: string | null = null;
let retriedPatch = false;

/** Ask for a round `delayMs` from now; requests in between fold into it. */
export function requestSettingsMetadataSync(delayMs = 0): void {
  if (timer) clearTimeout(timer);
  timer = setTimeout(() => {
    timer = null;
    void runRound();
  }, delayMs);
}

function runRound(): Promise<void> {
  if (running) {
    again = true;
    return running;
  }
  running = round()
    .catch((error) => {
      console.warn('[SETTINGS_SYNC] Settings in the account could not be synced:', error);
      failed();
    })
    .finally(() => {
      running = null;
      if (again) {
        again = false;
        requestSettingsMetadataSync(0);
      }
    });
  return running;
}

function failed(): void {
  useSettingsMetadataSyncStore.setState({ status: 'unreachable' });
  if (!timer) requestSettingsMetadataSync(RETRY_MS);
}

async function round(): Promise<void> {
  const store = useSettingsMetadataSyncStore;
  const target = currentTarget();
  if (!target) {
    store.setState({ status: 'off' });
    return;
  }
  const { client, accountId } = target;
  if (!client.getBulwarkMetadata || !client.updateBulwarkMetadata
    || !client.advertisesPrivateBulwarkMetadata?.(accountId)) {
    store.setState({ status: 'unsupported' });
    return;
  }
  // The admin policy says which settings are pinned: not before the full one is known.
  const policy = usePolicyStore.getState();
  if (!policy.loaded || policy.partial) return;
  const key = `${target.serverUrl}\u0000${target.username}\u0000${accountId}`;
  if (refusedFor !== key) {
    refusedAt.clear();
    refusedFor = key;
  }
  lastRoundAt = Date.now();
  if (typeof navigator !== 'undefined' && navigator.onLine === false) {
    store.setState({ status: 'unreachable' });
    return;
  }
  store.setState({ status: 'syncing' });

  const entries = await client.getBulwarkMetadata(accountId, { private: true });
  if (!sameTarget(target, currentTarget())) return;
  if (!entries) {
    failed();
    return;
  }
  const remote = readRemoteSettings(entries);
  const plan = planSettingsSync(localSettings(), remote);

  // What the account has newer comes in first.
  const changed = [...Object.keys(plan.take), ...plan.reset];
  if (changed.length > 0) {
    const stamps: Record<string, number> = {};
    for (const name of changed) stamps[name] = plan.stamps[name];
    useSettingsStore.getState().applyMetadataSettings(plan.take, plan.reset, stamps);
  }
  const unchanged = Object.fromEntries(Object.entries(plan.stamps).filter(([name]) => !changed.includes(name)));
  adoptSettingStamps(unchanged);
  noteSeenSettingStamps(plan.seen, plan.stamps);
  if (Object.keys(plan.replaced).length > 0) {
    store.setState({ replaced: { ...(store.getState().replaced ?? {}), ...plan.replaced } });
  }

  const outcome = await send(plan.push, remote.shards, entries, target);
  if (outcome === 'moved') return;
  if (outcome === 'retry') {
    // A shard another device removed meanwhile: read again, once.
    if (retriedPatch) {
      retriedPatch = false;
      failed();
      return;
    }
    retriedPatch = true;
    requestSettingsMetadataSync(CHANGE_DELAY_MS);
    return;
  }
  retriedPatch = false;
  if (outcome === 'unreachable') {
    failed();
    return;
  }
  store.setState({
    status: outcome === 'ok' ? 'synced' : 'full',
    lastSyncedAt: outcome === 'ok' ? Date.now() : store.getState().lastSyncedAt,
  });
}

async function send(
  push: SettingPush[],
  existingShards: ReadonlySet<number>,
  entries: Record<string, unknown>,
  target: Target,
): Promise<'ok' | 'full' | 'unreachable' | 'moved' | 'retry'> {
  for (const name of [...refusedAt.keys()]) {
    const pending = push.find((item) => item.name === name);
    if (!pending || pending.at !== refusedAt.get(name)) refusedAt.delete(name);
  }
  // An overlong text among the plain settings would have the server refuse
  // the update that carries all of them: it stays here, like a list too long.
  for (const item of push) {
    if (!item.ownEntry && !item.reset && metadataValueBytes(item.value) > MAX_PLAIN_VALUE_BYTES) {
      refusedAt.set(item.name, item.at);
    }
  }
  const writes = settingsWrites(push.filter((item) => refusedAt.get(item.name) !== item.at), existingShards);
  const update = target.client.updateBulwarkMetadata!.bind(target.client);
  const write = async (changes: Parameters<typeof update>[1]) => {
    const { newState } = await update(target.accountId, changes, { private: true });
    if (newState) ownStates.add(newState);
  };
  let full = false;
  try {
    if (writes.shards.length > 0) {
      if (!sameTarget(target, currentTarget())) return 'moved';
      try {
        await write(writes.shards);
      } catch (error) {
        if (error instanceof MetadataPatchError) return 'retry';
        if (!(error instanceof MetadataTooLargeError)) throw error;
        full = true;
      }
    }
    // What the account's private entries take now, as the round read them.
    let used = metadataValueBytes(entries);
    for (const value of writes.values) {
      if (!sameTarget(target, currentTarget())) return 'moved';
      const before = value.change.key in entries ? metadataValueBytes(entries[value.change.key]) : 0;
      const after = metadataValueBytes(value.change.value);
      if (after > before && used - before + after > LIST_BUDGET_BYTES) {
        refusedAt.set(value.name, value.at);
        continue;
      }
      try {
        await write([value.change]);
        used += after - before;
      } catch (error) {
        if (!(error instanceof MetadataTooLargeError) && !(error instanceof MetadataRefusedError)) throw error;
        // Over 8 KB on its own, more than the account has left, or refused
        // for another reason: it stays here until it changes.
        refusedAt.set(value.name, value.at);
      }
    }
  } catch (error) {
    console.warn('[SETTINGS_SYNC] Could not save settings in the account:', error);
    return 'unreachable';
  }
  return full ? 'full' : 'ok';
}

let started = false;

/** Starts the rounds; called once from the settings store in the browser. */
export function startSettingsMetadataSync(): void {
  if (started || typeof window === 'undefined') return;
  started = true;
  registerMetadataSyncHooks({
    onLocalChange: (keys) => {
      if (!settingsSyncTarget()) return;
      if (keys.some((key) => METADATA_SETTING_NAMES.includes(key))) requestSettingsMetadataSync(CHANGE_DELAY_MS);
    },
    onTargetChange: () => requestSettingsMetadataSync(0),
  });
  // The policy loads after sign-in: rounds wait for it.
  usePolicyStore.subscribe((state, prev) => {
    if (state.loaded && !state.partial && (!prev.loaded || prev.partial || state.policy !== prev.policy) && settingsSyncTarget()) {
      requestSettingsMetadataSync(0);
    }
  });
  // Another device's write changes the account's mailboxes; so does new mail, hence the gap.
  subscribePushStateChanges((change, client) => {
    const target = currentTarget();
    if (!target || client !== target.client) return;
    const state = change.changed[target.accountId]?.Mailbox;
    if (!state || ownStates.delete(state) || timer) return;
    requestSettingsMetadataSync(Math.max(CHANGE_DELAY_MS, lastRoundAt + SERVER_CHANGE_GAP_MS - Date.now()));
  });
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState !== 'visible' || !settingsSyncTarget() || timer) return;
    if (Date.now() - lastRoundAt >= SERVER_CHANGE_GAP_MS) requestSettingsMetadataSync(0);
  });
  window.addEventListener('online', () => {
    if (settingsSyncTarget()) requestSettingsMetadataSync(0);
  });
  if (settingsSyncTarget()) requestSettingsMetadataSync(0);
}

/** Test hook: forget everything held in memory. */
export function resetSettingsMetadataSyncForTests(): void {
  if (timer) clearTimeout(timer);
  timer = null;
  running = null;
  again = false;
  lastRoundAt = 0;
  ownStates.clear();
  refusedAt.clear();
  refusedFor = null;
  retriedPatch = false;
  registerMetadataSyncHooks(null);
  started = false;
  useSettingsMetadataSyncStore.setState({ status: 'off', lastSyncedAt: null, replaced: null });
}

/** Test hook: run one round now and wait for it. */
export function runSettingsMetadataRoundForTests(): Promise<void> {
  return runRound();
}
