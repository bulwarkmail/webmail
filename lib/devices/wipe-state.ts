/**
 * What a wipe has to remember in localStorage, in a store-free module the auth
 * store can import. Nothing here names a subject, and what stays after a wipe
 * is a count, a row id and the secret for that one row.
 */

import { EVICTED_KEEP_MS, readEvicted } from '@/lib/offline/state';
import type { WipeReason } from './types';

const PENDING_KEY = 'bulwark-wipe-pending';
const CONFIRM_KEY = 'bulwark-wipe-confirm';
const NOTE_KEY = 'bulwark-wipe-note';
const REFUSED_KEY = 'bulwark-credentials-refused';
const DATABASES_KEY = 'bulwark-wipe-databases';

/** The pending entry for a wipe of everything on this device. */
export const WHOLE_DEVICE = '*';

/**
 * A 401 after re-auth has to last this long before the login counts as refused.
 * Two answers a moment apart can be one bad moment on the server.
 */
export const CREDENTIALS_REFUSED_CONFIRM_MS = 60_000;

function readJson<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : fallback;
  } catch {
    return fallback;
  }
}

function writeJson(key: string, value: unknown, empty: boolean): void {
  try {
    if (empty) localStorage.removeItem(key);
    else localStorage.setItem(key, JSON.stringify(value));
  } catch {
    /* storage unavailable */
  }
}

// ---- A wipe under way: finished at the next page load if this one dies ----

export function readPendingWipes(): Record<string, WipeReason> {
  return readJson<Record<string, WipeReason>>(PENDING_KEY, {});
}

export function markWipePending(account: string, reason: WipeReason): void {
  writeJson(PENDING_KEY, { ...readPendingWipes(), [account]: reason }, false);
}

export function clearWipePending(account: string): void {
  const pending = readPendingWipes();
  delete pending[account];
  writeJson(PENDING_KEY, pending, Object.keys(pending).length === 0);
}

// ---- Telling the instance: sent until it gets through ----

export interface WipeConfirmation {
  id: string;
  secret: string;
  reason: WipeReason;
  /** Null: it couldn't be counted. Not the same as none. */
  unsent: number | null;
  /** Whose wipe this says is done: not sent until it is. Stays on this device. */
  account?: string;
  /** Not a wipe but a sign-out, whose row goes too. */
  drop?: boolean;
}

export function readWipeConfirmations(): WipeConfirmation[] {
  const list = readJson<WipeConfirmation[]>(CONFIRM_KEY, []);
  return Array.isArray(list) ? list : [];
}

export function queueWipeConfirmation(entry: WipeConfirmation): void {
  writeJson(CONFIRM_KEY, [...readWipeConfirmations().filter((other) => other.id !== entry.id), entry], false);
}

export function dropWipeConfirmation(id: string): void {
  const rest = readWipeConfirmations().filter((entry) => entry.id !== id);
  writeJson(CONFIRM_KEY, rest, rest.length === 0);
}

// ---- The note at the next sign-in: a count, never subjects ----

export interface WipeNote {
  unsent: number;
  /** Some of it couldn't be counted, so there may have been more than `unsent`. */
  unknown?: true;
}

export function addWipeNote(unsent: number | null): void {
  const before = readJson<WipeNote | null>(NOTE_KEY, null);
  const note: WipeNote = { unsent: (before?.unsent ?? 0) + (unsent ?? 0) };
  if (before?.unknown || unsent === null) note.unknown = true;
  writeJson(NOTE_KEY, note, false);
}

/** Once: whoever shows it takes it. Null when no wipe left a word. */
export function consumeWipeNote(): WipeNote | null {
  const note = readJson<WipeNote | null>(NOTE_KEY, null);
  writeJson(NOTE_KEY, null, true);
  if (!note || typeof note.unsent !== 'number') return null;
  return note.unknown ? { unsent: note.unsent, unknown: true } : { unsent: note.unsent };
}

// ---- A refused login: what waits for the new password. A count, never subjects ----

export interface RefusedLogin {
  at: number;
  /** Unsent messages waiting. Null: not counted yet, or the store couldn't say. */
  unsent: number | null;
  /** Not one bad answer at a start: what a deletion the organisation asked for needs. */
  certain: boolean;
}

export function readRefusedLogins(): Record<string, RefusedLogin> {
  return readJson<Record<string, RefusedLogin>>(REFUSED_KEY, {});
}

const refusedListeners = new Set<() => void>();

/** For the sign-in page: the count comes after the page does. */
export function onRefusedLoginsChanged(listener: () => void): () => void {
  refusedListeners.add(listener);
  return () => refusedListeners.delete(listener);
}

function writeRefused(refused: Record<string, RefusedLogin>): void {
  writeJson(REFUSED_KEY, refused, Object.keys(refused).length === 0);
  for (const listener of [...refusedListeners]) listener();
}

export function markLoginRefused(account: string, certain = true, now = Date.now()): void {
  const before = readRefusedLogins();
  writeRefused({ ...before, [account]: { at: before[account]?.at ?? now, unsent: null, certain: certain || before[account]?.certain === true } });
}

export function setRefusedCount(account: string, unsent: number | null): void {
  const before = readRefusedLogins();
  if (before[account]) writeRefused({ ...before, [account]: { ...before[account], unsent } });
}

export function dropRefusedLogin(account: string): void {
  const refused = readRefusedLogins();
  if (!(account in refused)) return;
  delete refused[account];
  writeRefused(refused);
}

export interface RefusedWait {
  unsent: number | null;
  /** When the data goes if nobody signs in. */
  until: number;
}

/** What the sign-in page says. Numbers only: whoever reads it may not be the person it's about. */
export function refusedWaits(): RefusedWait[] {
  const evicted = readEvicted();
  return Object.entries(readRefusedLogins())
    .filter(([account, wait]) => account in evicted && wait.unsent !== 0)
    .map(([account, wait]) => ({ unsent: wait.unsent, until: evicted[account] + EVICTED_KEEP_MS }));
}

// ---- Plugin databases a running frame kept open: tried again at the next load ----

export function readBlockedDatabases(): Record<string, number> {
  return readJson<Record<string, number>>(DATABASES_KEY, {});
}

export function writeBlockedDatabases(blocked: Record<string, number>): void {
  writeJson(DATABASES_KEY, blocked, Object.keys(blocked).length === 0);
}

/** Whether anything is left over from an earlier wipe, so a start must look. */
export function wipeWorkWaiting(): boolean {
  return Object.keys(readPendingWipes()).length > 0
    || readWipeConfirmations().length > 0
    || Object.keys(readBlockedDatabases()).length > 0;
}
