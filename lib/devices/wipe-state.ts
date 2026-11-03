/**
 * What a wipe has to remember in localStorage, in a store-free module the auth
 * store can import. Nothing here names a subject, and what stays after a wipe
 * is a count, a row id and the secret for that one row.
 */

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

/**
 * How long a refused login's data waits for a sign-in with the new password.
 * Nothing but this 401 says the login is over, since a password login has no
 * `invalid_grant`. A server being restored from a backup says the same for hours,
 * and someone who changed their password elsewhere is about to type the new one.
 */
export const REFUSED_KEEP_MS = 24 * 60 * 60 * 1000;

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
  unsent: number;
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

export function addWipeNote(unsent: number): void {
  const before = readJson<{ unsent?: number }>(NOTE_KEY, {});
  writeJson(NOTE_KEY, { unsent: (before.unsent ?? 0) + unsent }, false);
}

/** Once: whoever shows it takes it. Null when no wipe left a word. */
export function consumeWipeNote(): { unsent: number } | null {
  const note = readJson<{ unsent?: number } | null>(NOTE_KEY, null);
  writeJson(NOTE_KEY, null, true);
  return note && typeof note.unsent === 'number' ? { unsent: note.unsent } : null;
}

// ---- A refused password: when the wait started ----

export function readRefusedLogins(): Record<string, number> {
  return readJson<Record<string, number>>(REFUSED_KEY, {});
}

export function markLoginRefused(account: string, now = Date.now()): void {
  writeJson(REFUSED_KEY, { ...readRefusedLogins(), [account]: now }, false);
}

export function dropRefusedLogin(account: string): void {
  const refused = readRefusedLogins();
  delete refused[account];
  writeJson(REFUSED_KEY, refused, Object.keys(refused).length === 0);
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
    || Object.keys(readRefusedLogins()).length > 0
    || Object.keys(readBlockedDatabases()).length > 0;
}
