/**
 * What offline mode (#523) shows: which accounts keep mail on this device,
 * whether the browser is offline, what waits in the outbox, how much the
 * local store uses. The switch itself ("Keep mail on this device") is per account
 * and per browser, in localStorage, never synced: it is off until the user
 * turns it on here.
 */

import { create } from 'zustand';
import { DEFAULT_SCOPE, type StoreScope } from '@/lib/store/area';
import type { ConflictEntry, OutboxEntry, OutboxError } from './queue';

/** localStorage: the local account ids that keep mail on this device. */
export const OFFLINE_ACCOUNTS_KEY = 'bulwark-offline-accounts';

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
  outbox: OutboxRow[];
  pendingChanges: number;
  /** Changes the server refused, or that met a message changed on another device. */
  conflicts: ConflictEntry[];
  usageBytes: number;
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

export const useOfflineStore = create<OfflineState>()(() => ({
  enabled: readEnabled(),
  browserOffline: typeof navigator !== 'undefined' && navigator.onLine === false,
  downServers: [],
  startedOffline: false,
  outbox: [],
  pendingChanges: 0,
  conflicts: [],
  usageBytes: 0,
  syncing: [],
  lastSyncedAt: {},
}));

export function writeEnabled(enabled: string[]): void {
  useOfflineStore.setState({ enabled });
  try {
    if (enabled.length) localStorage.setItem(OFFLINE_ACCOUNTS_KEY, JSON.stringify(enabled));
    else localStorage.removeItem(OFFLINE_ACCOUNTS_KEY);
  } catch {
    /* storage unavailable */
  }
}

/** localStorage: what each account chose to keep offline, on top of the defaults. */
export const OFFLINE_SCOPE_KEY = 'bulwark-offline-scope';

export function offlineScopeFor(account: string): StoreScope {
  try {
    const chosen = (JSON.parse(localStorage.getItem(OFFLINE_SCOPE_KEY) ?? '{}') as Record<string, Partial<StoreScope>>)[account];
    return { ...DEFAULT_SCOPE, ...chosen };
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
