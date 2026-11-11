/**
 * What offline mode (#523) shows: which accounts keep mail on this device,
 * whether the browser is offline, what waits in the outbox, how much the
 * local store uses. The switch itself ("Keep mail on this device") is per account
 * and per browser, in localStorage, never synced: it is off until the user
 * turns it on here.
 */

import { create } from 'zustand';
import { DEFAULT_SCOPE, NO_TOTAL_LIMIT, type StoreScope, type StoreUsage } from '@/lib/store/area';
import type { ConflictEntry, LocalDraftRow, OutboxEntry, OutboxError } from './queue';
import type { PersistState } from './storage-health';
import type { SyncProgress } from './sync-progress';

/** localStorage: the local account ids that keep mail on this device. */
export const OFFLINE_ACCOUNTS_KEY = 'bulwark-offline-accounts';
/** localStorage: what each account chose to keep offline, on top of the defaults. Numbers and switches only. */
export const OFFLINE_SCOPE_KEY = 'bulwark-offline-scope';
/** localStorage: what's known about each account's store with the store gone. Numbers only, never content. */
export const OFFLINE_HEALTH_KEY = 'bulwark-offline-health';

export interface UserChoice extends Partial<Pick<StoreScope, 'days' | 'attachments' | 'maxAttachmentBytes'>> {
  /** Bytes for all attachments and kept files together. Null is no limit, which only the desktop app offers. */
  maxTotalBytes?: number | null;
  /** Off here means the user turned it off: the desktop app's default doesn't turn it back on. */
  on?: boolean;
}

export interface AccountHealth {
  /** Unsent messages and changes last counted: what an eviction loses. */
  pending?: number;
  /** When the last sync finished. Survives a reload, unlike the running state. */
  lastSync?: number;
  /** The store came back empty (see `storeLost`). Unlike that, this stays across a reload until the user has read it. */
  reset?: { at: number; lost: number };
  /** The user cleared the account: another tab that owns the store opens the new one. */
  clearedAt?: number;
}

/** A calendar or contact edit that didn't go through. Lives in its own area's store. */
export interface AreaConflict {
  area: 'calendar' | 'contacts';
  account: string;
  id: number;
  createdAt: number;
  title: string;
  reason: 'refused' | 'changed' | 'gone';
  /** A delete can't be taken back, so it reads differently. */
  destroy: boolean;
  detail: string | null;
}

export interface OutboxRow {
  id: number;
  account: string;
  createdAt: number;
  subject: string;
  to: string[];
  status: OutboxEntry['status'];
  error?: OutboxError;
}

interface OfflineState {
  /** Accounts with "Keep mail on this device" on. */
  enabled: string[];
  /** The browser says it has no network. */
  browserOffline: boolean;
  /** Mail servers (their URLs) that couldn't be reached at the last request. */
  downServers: string[];
  /** The app started without the server, from the mail on this device. */
  startedOffline: boolean;
  /** The browser won't hand out the private file system here: a private window, say. */
  storageBlocked: boolean;
  /** This computer's key store is there and wouldn't take a store key. Settings say so. */
  keyUnprotected: boolean;
  /** Re-encryptions: how far each got, or that it didn't finish. */
  rekey: Record<string, number | 'failed'>;
  /**
   * Accounts whose store came back empty since this page loaded: the browser
   * cleared their key or file. Whatever warns about eviction can go by this.
   */
  storeLost: string[];
  outbox: OutboxRow[];
  pendingChanges: number;
  /** Changes the server refused, or that met a message changed on another device. */
  conflicts: ConflictEntry[];
  /** The same for calendar events and contacts. */
  areaConflicts: AreaConflict[];
  /** Changes waiting, per account: mail's, the calendar's and the contacts'. */
  changesBy: Record<string, number>;
  /** Drafts that are only on this device: on their way up, or refused by the server. */
  localDrafts: LocalDraftRow[];
  /** A local draft the user asked to open, for the mail page to pick up. */
  draftToOpen: { account: string; jmap: string; id: string } | null;
  usageBytes: number;
  usage: Record<string, StoreUsage>;
  choices: Record<string, UserChoice>;
  health: Record<string, AccountHealth>;
  /** What the browser said about keeping this site's data. */
  persist: PersistState;
  /** Accounts that couldn't write, and since when. Gone after the next good sync. */
  storageFull: Record<string, number>;
  /** How far the sync running for an account got. */
  progress: Record<string, SyncProgress>;
  /** Accounts whose mail is being brought onto the device right now. */
  syncing: string[];
  lastSyncedAt: Record<string, number>;
}

function readEnabled(): string[] {
  try {
    const raw = typeof localStorage === 'undefined' ? null : localStorage.getItem(OFFLINE_ACCOUNTS_KEY);
    const parsed = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed) ? parsed.filter((id): id is string => typeof id === 'string') : [];
  } catch {
    return [];
  }
}

function readRecord<T>(key: string): Record<string, T> {
  try {
    const raw = typeof localStorage === 'undefined' ? null : localStorage.getItem(key);
    const parsed = raw ? JSON.parse(raw) : null;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Record<string, T> : {};
  } catch {
    return {};
  }
}

function writeRecord(key: string, value: Record<string, unknown>): void {
  try {
    if (Object.keys(value).length > 0) localStorage.setItem(key, JSON.stringify(value));
    else localStorage.removeItem(key);
  } catch {
    /* storage unavailable */
  }
}

export const useOfflineStore = create<OfflineState>()(() => ({
  enabled: readEnabled(),
  browserOffline: typeof navigator !== 'undefined' && navigator.onLine === false,
  downServers: [],
  startedOffline: false,
  storeLost: [],
  storageBlocked: false,
  keyUnprotected: false,
  rekey: {},
  outbox: [],
  pendingChanges: 0,
  conflicts: [],
  areaConflicts: [],
  changesBy: {},
  localDrafts: [],
  draftToOpen: null,
  usageBytes: 0,
  usage: {},
  choices: readRecord<UserChoice>(OFFLINE_SCOPE_KEY),
  health: readRecord<AccountHealth>(OFFLINE_HEALTH_KEY),
  persist: 'unknown',
  storageFull: {},
  progress: {},
  syncing: [],
  lastSyncedAt: {},
}));

export function writeChoice(account: string, patch: UserChoice): void {
  const choices = { ...useOfflineStore.getState().choices, [account]: { ...useOfflineStore.getState().choices[account], ...patch } };
  useOfflineStore.setState({ choices });
  writeRecord(OFFLINE_SCOPE_KEY, choices);
}

export function forgetAccountState(account: string): void {
  const { choices, health, usage, storageFull, progress } = useOfflineStore.getState();
  const without = <T,>(record: Record<string, T>) => Object.fromEntries(Object.entries(record).filter(([id]) => id !== account));
  const next = { choices: without(choices), health: without(health), usage: without(usage), storageFull: without(storageFull), progress: without(progress) };
  useOfflineStore.setState(next);
  writeRecord(OFFLINE_SCOPE_KEY, next.choices);
  writeRecord(OFFLINE_HEALTH_KEY, next.health);
}

export function writeHealth(account: string, patch: AccountHealth): void {
  const { health } = useOfflineStore.getState();
  const current = health[account];
  if (current && Object.entries(patch).every(([key, value]) => current[key as keyof AccountHealth] === value)) return;
  const next = { ...health, [account]: { ...current, ...patch } };
  useOfflineStore.setState({ health: next });
  writeRecord(OFFLINE_HEALTH_KEY, next);
}

/** The state of other tabs, after a storage event. */
export function readStoredChoices(): Record<string, UserChoice> {
  return readRecord<UserChoice>(OFFLINE_SCOPE_KEY);
}

export function readStoredHealth(): Record<string, AccountHealth> {
  return readRecord<AccountHealth>(OFFLINE_HEALTH_KEY);
}

/** Nothing is kept for anyone any more. Those still signed in stay off if they turned it off. */
export function forgetAllAccountState(signedIn: readonly string[] = []): void {
  const off: Record<string, UserChoice> = {};
  for (const [account, choice] of Object.entries(useOfflineStore.getState().choices)) {
    if (choice.on === false && signedIn.includes(account)) off[account] = { on: false };
  }
  useOfflineStore.setState({ choices: off, health: {}, usage: {}, storageFull: {}, progress: {}, areaConflicts: [], changesBy: {} });
  writeRecord(OFFLINE_SCOPE_KEY, off);
  writeRecord(OFFLINE_HEALTH_KEY, {});
}

export function writeEnabled(enabled: string[]): void {
  useOfflineStore.setState({ enabled });
  try {
    if (enabled.length) localStorage.setItem(OFFLINE_ACCOUNTS_KEY, JSON.stringify(enabled));
    else localStorage.removeItem(OFFLINE_ACCOUNTS_KEY);
  } catch {
    /* storage unavailable */
  }
}

/** What the user chose, over the defaults. The organisation's caps come on top: scopeForAccount in offline-mode.ts. */
export function offlineScopeFor(account: string): StoreScope {
  try {
    const { on: _on, ...chosen } = (JSON.parse(localStorage.getItem(OFFLINE_SCOPE_KEY) ?? '{}') as Record<string, UserChoice>)[account] ?? {};
    const { maxTotalBytes, ...rest } = chosen;
    return { ...DEFAULT_SCOPE, ...rest, ...(maxTotalBytes !== undefined && { maxTotalBytes: maxTotalBytes ?? NO_TOTAL_LIMIT }) };
  } catch {
    return DEFAULT_SCOPE;
  }
}

/** localStorage: accounts the app dropped by itself, and when. Their data waits for a new sign-in. */
export const OFFLINE_EVICTED_KEY = 'bulwark-offline-evicted';
/** How long that data waits. */
export const EVICTED_KEEP_MS = 30 * 24 * 60 * 60 * 1000;

export function readEvicted(): Record<string, number> {
  try {
    const parsed = JSON.parse(localStorage.getItem(OFFLINE_EVICTED_KEY) ?? '{}') as unknown;
    return parsed && typeof parsed === 'object' ? parsed as Record<string, number> : {};
  } catch {
    return {};
  }
}

function writeEvicted(evicted: Record<string, number>): void {
  try {
    if (Object.keys(evicted).length > 0) localStorage.setItem(OFFLINE_EVICTED_KEY, JSON.stringify(evicted));
    else localStorage.removeItem(OFFLINE_EVICTED_KEY);
  } catch {
    /* storage unavailable */
  }
}

/** Only an account that keeps mail here has anything to wait for. */
export function markEvicted(account: string, now = Date.now()): void {
  if (useOfflineStore.getState().enabled.includes(account)) writeEvicted({ ...readEvicted(), [account]: now });
}

export function clearEvicted(account: string): void {
  const evicted = readEvicted();
  if (!(account in evicted)) return;
  delete evicted[account];
  writeEvicted(evicted);
}

/**
 * localStorage: the JMAP account and the server each store belongs to. The app's account id is only
 * `username@host`, and an address can move to another person, so that alone doesn't vouch for a
 * store that waits for a sign-in.
 */
export const OFFLINE_OWNERS_KEY = 'bulwark-offline-owners';

export interface StoreOwner {
  jmap: string;
  server: string;
}

export function readStoreOwners(): Record<string, StoreOwner> {
  return readRecord<StoreOwner>(OFFLINE_OWNERS_KEY);
}

let storeOwnerChanged: ((account: string) => Promise<void>) | null = null;

/** Lib/offline/offline-mode.ts takes the data away. No Lite, no store: nothing does. */
export function onStoreOwnerChanged(listener: (account: string) => Promise<void>): () => void {
  storeOwnerChanged = listener;
  return () => {
    if (storeOwnerChanged === listener) storeOwnerChanged = null;
  };
}

/**
 * A sign-in, once the server has said who this is and before the account is added. A store waiting
 * for this address that belongs to another JMAP account or another server isn't theirs: an address
 * can be given to someone new, and a host can run a second server on another port. Its data goes
 * first, and they start with nothing. The id itself doesn't include the port, because every store,
 * setting and server-side record of an existing account is keyed by it.
 */
export async function checkStoreOwner(account: string, jmap: string, serverUrl: string): Promise<void> {
  const known = readStoreOwners()[account];
  const server = originOf(serverUrl);
  if (known && isEvicted(account) && (known.jmap !== jmap || known.server !== server)) await storeOwnerChanged?.(account);
  if (known?.jmap !== jmap || known?.server !== server) {
    writeRecord(OFFLINE_OWNERS_KEY, { ...readStoreOwners(), [account]: { jmap, server } });
  }
}

export function forgetStoreOwner(account: string): void {
  const owners = readStoreOwners();
  if (!(account in owners)) return;
  delete owners[account];
  writeRecord(OFFLINE_OWNERS_KEY, owners);
}

function originOf(url: string): string {
  try {
    return new URL(url).origin;
  } catch {
    return url.replace(/\/+$/, '').toLowerCase();
  }
}

/** localStorage: who a dropped account was, only in the desktop app: its plugin secrets are on this device's server, under this. */
export const OFFLINE_EVICTED_OWNERS_KEY = 'bulwark-offline-evicted-owners';

export interface EvictedOwner {
  username: string;
  serverUrl: string;
}

export function readEvictedOwners(): Record<string, EvictedOwner> {
  return readRecord<EvictedOwner>(OFFLINE_EVICTED_OWNERS_KEY);
}

export function rememberEvictedOwner(account: string, owner: EvictedOwner): void {
  writeRecord(OFFLINE_EVICTED_OWNERS_KEY, { ...readEvictedOwners(), [account]: { username: owner.username, serverUrl: owner.serverUrl } });
}

export function dropEvictedOwner(account: string): void {
  const owners = readEvictedOwners();
  if (!(account in owners)) return;
  delete owners[account];
  writeRecord(OFFLINE_EVICTED_OWNERS_KEY, owners);
}

export function isEvicted(account: string): boolean {
  return account in readEvicted();
}

/** The accounts whose data may show here: not those waiting for a sign-in, which may be someone else's. */
export function visibleAccounts(): string[] {
  const evicted = readEvicted();
  return useOfflineStore.getState().enabled.filter((account) => !(account in evicted));
}

/**
 * Drops the plain-text list kept in localStorage for a quick start (email-store)
 * once the store can do that job. Until an account's first sync finishes it's
 * what stays on screen, so turning the store on alone doesn't remove it.
 */
export function forgetMailSnapshot(account: string): void {
  try {
    const raw = localStorage.getItem('email-snapshot');
    if (raw && (JSON.parse(raw) as { account?: unknown } | null)?.account !== account) return;
    localStorage.removeItem('email-snapshot');
  } catch {
    localStorage.removeItem('email-snapshot');
  }
}

export function serverKey(url: string): string {
  return url.replace(/\/+$/, '').toLowerCase();
}

/** The browser is offline, or this mail server (any, without one) couldn't be reached. */
export function isOfflineNow(serverUrl?: string): boolean {
  const { browserOffline, downServers } = useOfflineStore.getState();
  if (browserOffline) return true;
  return serverUrl ? downServers.includes(serverKey(serverUrl)) : downServers.length > 0;
}

export function setServerDown(serverUrl: string, down: boolean): boolean {
  const key = serverKey(serverUrl);
  const { downServers } = useOfflineStore.getState();
  const was = downServers.includes(key);
  if (was !== down) useOfflineStore.setState({ downServers: down ? [...downServers, key] : downServers.filter((s) => s !== key) });
  return was;
}

/** The switch as another tab left it (it changed in localStorage there). */
export function readEnabledFrom(raw: string | null): string[] {
  try {
    const parsed = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed) ? parsed.filter((id): id is string => typeof id === 'string') : [];
  } catch {
    return [];
  }
}
