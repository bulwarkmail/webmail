/**
 * What the desktop app's windows do. These belong to this computer, not the account
 * (one user can have a laptop and a desktop that differ), so they stay out of the
 * synced settings. The shell gets its copy of "restore" from the host.
 */

import { useSyncExternalStore } from 'react';

const STORAGE_KEY = 'bulwark-desktop-window-prefs';

export interface DesktopWindowPrefs {
  /** Double-clicking a message opens it in its own window. */
  openOnDoubleClick: boolean;
  /** The windows open at quit come back at the next start. */
  restoreWindows: boolean;
  /** Spellcheck dictionaries from Google, for a language the OS has no checker for. Asked once. */
  dictionaryDownload: 'ask' | 'yes' | 'no';
}

const DEFAULTS: DesktopWindowPrefs = { openOnDoubleClick: true, restoreWindows: true, dictionaryDownload: 'ask' };

let cached: DesktopWindowPrefs | null = null;
const listeners = new Set<() => void>();

export function readDesktopPrefs(): DesktopWindowPrefs {
  if (cached) return cached;
  let stored: Partial<DesktopWindowPrefs> = {};
  try {
    const raw = typeof localStorage === 'undefined' ? null : localStorage.getItem(STORAGE_KEY);
    if (raw) stored = JSON.parse(raw) as Partial<DesktopWindowPrefs>;
  } catch {
    // Damaged: the defaults.
  }
  cached = {
    openOnDoubleClick: typeof stored.openOnDoubleClick === 'boolean' ? stored.openOnDoubleClick : DEFAULTS.openOnDoubleClick,
    restoreWindows: typeof stored.restoreWindows === 'boolean' ? stored.restoreWindows : DEFAULTS.restoreWindows,
    dictionaryDownload: stored.dictionaryDownload === 'yes' || stored.dictionaryDownload === 'no' ? stored.dictionaryDownload : DEFAULTS.dictionaryDownload,
  };
  return cached;
}

export function setDesktopPref<K extends keyof DesktopWindowPrefs>(key: K, value: DesktopWindowPrefs[K]): void {
  cached = { ...readDesktopPrefs(), [key]: value };
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(cached));
  } catch {
    // Full or unavailable: it holds until the window closes.
  }
  for (const listener of [...listeners]) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  // Another window changed it.
  const onStorage = (event: StorageEvent) => {
    if (event.key !== STORAGE_KEY) return;
    cached = null;
    listener();
  };
  window.addEventListener('storage', onStorage);
  return () => {
    listeners.delete(listener);
    window.removeEventListener('storage', onStorage);
  };
}

export function useDesktopPrefs(): DesktopWindowPrefs {
  return useSyncExternalStore(subscribe, readDesktopPrefs, () => DEFAULTS);
}

/** Test helper. */
export function resetDesktopPrefsCache(): void {
  cached = null;
}
