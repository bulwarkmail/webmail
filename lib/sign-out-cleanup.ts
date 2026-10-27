import { fileStorage } from '@/lib/plugin-storage';

/**
 * What a full sign-out removes from this browser beyond the stores that
 * clearAllStores() empties: once nobody is signed in, nothing the accounts
 * produced may be left for the next person at this computer.
 *
 * Kept on purpose: device preferences (`settings-storage`, `theme-storage`,
 * `locale-storage`, the Files view settings) and `template-storage`. With
 * settings sync off they exist only here, so deleting them would destroy
 * the user's own work rather than a cache. With sync on, the settings store
 * resets settings and templates itself (forgetSyncedSettings).
 */
const SIGNED_OUT_STORAGE_KEYS = [
  'email-snapshot',
  'identity-storage',
  'contact-storage',
  'calendar-storage',
  'calendar-notification-storage',
  // Open tabs name messages and their subjects.
  'pro-tabs',
  'search-history-storage',
  'files-favorites',
  'files-recent-files',
  'files-last-parent-id',
  'files-path-stack',
];

const SIGNED_OUT_SIGNAL = 'bulwark:signed-out';

// Stores the auth store can't import (they import it) clear themselves here.
const signedOutCleanups = new Set<() => void>();

/** Run `cleanup` when everyone signs out in this tab. */
export function onFullSignOut(cleanup: () => void): void {
  signedOutCleanups.add(cleanup);
}

/** Remove the accounts' leftovers from browser storage. */
export function purgeSignedOutData(): void {
  if (typeof window === 'undefined') return;
  for (const key of SIGNED_OUT_STORAGE_KEYS) {
    try {
      window.localStorage.removeItem(key);
    } catch {
      /* storage unavailable */
    }
  }
  // Attachment bytes a plugin staged for an upload that never started.
  void fileStorage.clearFiles().catch(() => {});
  for (const cleanup of signedOutCleanups) {
    try {
      cleanup();
    } catch {
      /* one store failing must not keep the others' data */
    }
  }
}

/** Tell the other tabs of this browser that everyone signed out. */
export function broadcastSignOut(): void {
  if (typeof window === 'undefined') return;
  try {
    // Other tabs see the write as a `storage` event; the key need not stay.
    window.localStorage.setItem(SIGNED_OUT_SIGNAL, String(Date.now()));
    window.localStorage.removeItem(SIGNED_OUT_SIGNAL);
  } catch {
    /* storage unavailable */
  }
}

/** Run `onSignedOut` when another tab signs everyone out. */
export function onSignedOutElsewhere(onSignedOut: () => void): () => void {
  const listener = (event: StorageEvent) => {
    if (event.key === SIGNED_OUT_SIGNAL && event.newValue !== null) onSignedOut();
  };
  window.addEventListener('storage', listener);
  return () => window.removeEventListener('storage', listener);
}
