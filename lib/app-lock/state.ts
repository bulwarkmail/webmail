/**
 * App lock's plain facts, and how tabs tell each other. No secrets and no mail:
 * whether the lock is on, whether it is locked now, and the timeout. This stays
 * in localStorage because the first frame has to know, before anything async can
 * run. Someone who can edit it can't unlock anything: the keys need the PIN.
 *
 * Imports nothing, so anything may import it: lib/popout/channel.ts, the store's
 * flush and the auth store all ask here.
 */

export const APP_LOCK_KEY = 'bulwark-app-lock';
/** When someone last used a window or tab. Shared by all of them. */
export const APP_LOCK_ACTIVITY_KEY = 'bulwark-app-lock-activity';
export const APP_LOCK_CHANNEL = 'bulwark:app-lock';
/** Web Lock held by the tab that has the lock key, for as long as it lives. */
export const APP_LOCK_HOLDER = 'bulwark-app-lock-holder';

export const DEFAULT_TIMEOUT_MINUTES = 10;
export const TIMEOUT_CHOICES = [1, 5, 10, 15, 30, 60, 240] as const;

export interface AppLockFile {
  on: boolean;
  locked: boolean;
  /** The user's choice. Absent until they make one. */
  timeoutMinutes?: number;
}

const OFF: AppLockFile = { on: false, locked: false };

export function readAppLockFile(): AppLockFile {
  try {
    const parsed = JSON.parse(localStorage.getItem(APP_LOCK_KEY) ?? 'null') as Partial<AppLockFile> | null;
    if (!parsed || typeof parsed !== 'object' || parsed.on !== true) return OFF;
    return {
      on: true,
      // Anything but a clear "no" counts as locked.
      locked: parsed.locked !== false,
      ...(typeof parsed.timeoutMinutes === 'number' ? { timeoutMinutes: parsed.timeoutMinutes } : {}),
    };
  } catch {
    return OFF;
  }
}

export function writeAppLockFile(next: AppLockFile): void {
  try {
    if (next.on) localStorage.setItem(APP_LOCK_KEY, JSON.stringify(next));
    else localStorage.removeItem(APP_LOCK_KEY);
  } catch {
    // Storage blocked: this tab's memory below still says what it knows.
  }
}

/** Set while this tab is on its way to locked, or shows the lock screen. */
let lockedHere = false;

export function setLockedHere(locked: boolean): void {
  lockedHere = locked;
}

/** Nothing with mail in it may show, go out or be read now. */
export function isAppLockedNow(): boolean {
  if (lockedHere) return true;
  if (typeof window === 'undefined') return false;
  const file = readAppLockFile();
  return file.on && file.locked;
}

export function isAppLockOn(): boolean {
  return typeof window !== 'undefined' && readAppLockFile().on;
}

export type AppLockMessage =
  | { type: 'lock' }
  | { type: 'unlocked' }
  /** The lock was switched on in another tab. */
  | { type: 'enabled' }
  | { type: 'off' }
  /** Asks whether a main window is there: a pop-out sends people to it to unlock. */
  | { type: 'main-ping' }
  | { type: 'main-pong' }
  | { type: 'focus-main' }
  /** A draft a locking pop-out couldn't save, unsealed: a main window keeps it. */
  | { type: 'unsealed-draft'; state: unknown };

export function postAppLockMessage(message: AppLockMessage): void {
  if (typeof BroadcastChannel === 'undefined') return;
  try {
    const channel = new BroadcastChannel(APP_LOCK_CHANNEL);
    channel.postMessage(message);
    channel.close();
  } catch {
    // The `storage` event on the file still reaches the other tabs.
  }
}

/** Runs in the head script, before the first paint. Self-contained: it is stringified. */
export function appLockBootScript(): string {
  return `try {
    var appLock = JSON.parse(localStorage.getItem(${JSON.stringify(APP_LOCK_KEY)}) || 'null');
    if (appLock && appLock.on === true) document.documentElement.setAttribute('data-app-locked', '');
  } catch (e) {}`;
}
