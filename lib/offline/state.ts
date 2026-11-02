/**
 * What offline mode (#523) shows: which accounts keep mail on this device,
 * whether the browser is offline, what waits in the outbox, how much the
 * cache uses. The switch itself ("Keep mail on this device") is per account
 * and per browser, in localStorage, never synced: it is off until the user
 * turns it on here.
 */

import { create } from 'zustand';
import type { OutboxEntry, OutboxError } from './queue';

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
