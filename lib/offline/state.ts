/**
 * What offline mode (#523) shows: which accounts keep mail on this device,
 * whether the browser is offline, what waits in the outbox, how much the
 * local store uses. The switch itself ("Keep mail on this device") is per account
 * and per browser, in localStorage, never synced: it is off until the user
 * turns it on here.
 */

import { create } from 'zustand';
import type { StoreUsage } from '@/lib/store/area';
import type { ConflictEntry, OutboxEntry, OutboxError } from './queue';
import type { PersistState } from './storage-health';
import type { SyncProgress } from './sync-progress';

/** localStorage: the local account ids that keep mail on this device. */
export const OFFLINE_ACCOUNTS_KEY = 'bulwark-offline-accounts';
/** localStorage: what the user picked per account. Numbers and switches only. */
export const OFFLINE_CHOICES_KEY = 'bulwark-offline-choices';
/** localStorage: what's known about each account's store with the store gone. Numbers only, never content. */
export const OFFLINE_HEALTH_KEY = 'bulwark-offline-health';

export interface UserChoice {
  /** Off here means the user turned it off: the desktop app's default doesn't turn it back on. */
  on?: boolean;
  /** Days of mail to keep. Null keeps everything. */
  days?: number | null;
  attachments?: boolean;
  maxAttachmentMb?: number;
}

export interface AccountHealth {
  /** The store was opened for this account once. */
  opened?: boolean;
  /** Unsent messages and changes last counted: what an eviction loses. */
  pending?: number;
  /** When the last sync finished. Survives a reload, unlike the running state. */
  lastSync?: number;
  /** The browser deleted what was kept. Stays until the user has read it. */
  evicted?: { at: number; lost: number };
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
  outbox: OutboxRow[];
  pendingChanges: number;
  /** Changes the server refused, or that met a message changed on another device. */
  conflicts: ConflictEntry[];
  /** The same for calendar events and contacts. */
  areaConflicts: AreaConflict[];
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
  outbox: [],
  pendingChanges: 0,
  conflicts: [],
  areaConflicts: [],
  usageBytes: 0,
  usage: {},
  choices: readRecord<UserChoice>(OFFLINE_CHOICES_KEY),
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
  writeRecord(OFFLINE_CHOICES_KEY, choices);
}

export function forgetAccountState(account: string): void {
  const { choices, health, usage, storageFull, progress } = useOfflineStore.getState();
  const without = <T,>(record: Record<string, T>) => Object.fromEntries(Object.entries(record).filter(([id]) => id !== account));
  const next = { choices: without(choices), health: without(health), usage: without(usage), storageFull: without(storageFull), progress: without(progress) };
  useOfflineStore.setState(next);
  writeRecord(OFFLINE_CHOICES_KEY, next.choices);
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
  return readRecord<UserChoice>(OFFLINE_CHOICES_KEY);
}

export function readStoredHealth(): Record<string, AccountHealth> {
  return readRecord<AccountHealth>(OFFLINE_HEALTH_KEY);
}

/** Nothing is kept for anyone any more. */
export function forgetAllAccountState(): void {
  useOfflineStore.setState({ choices: {}, health: {}, usage: {}, storageFull: {}, progress: {}, areaConflicts: [] });
  writeRecord(OFFLINE_CHOICES_KEY, {});
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
