import { evictAll } from '@/lib/account-state-manager';

// localStorage keys holding server-derived, re-fetchable caches. The "Refresh
// cached data" action clears these so a stale or wrong-account view can be
// fixed WITHOUT signing out (which would drop the whole account list).
//
// Deliberately excluded:
//  - 'account-registry' / 'auth-storage'  → keep accounts + sessions
//  - 'settings-storage' / 'theme-storage' / 'locale-storage' → user prefs
//  - 'template-storage' / 'smime-preferences' → user-created content
const CACHE_STORAGE_KEYS = [
  'identity-storage',
  'contact-storage',
  'calendar-storage',
  'calendar-notification-storage',
];

/**
 * Clear cached, server-derived data (contacts, calendars, identities, and the
 * in-memory per-account snapshots), then reload so everything is re-fetched
 * fresh for the active account. Accounts and sessions are preserved — this is
 * the non-destructive alternative to the browser's "clear site data", which
 * also wipes the account list.
 */
export function clearCachedData(): void {
  // Drop the in-memory per-account store snapshots so a reload can't restore
  // stale cached state for any account.
  try {
    evictAll();
  } catch {
    /* snapshots are best-effort */
  }

  if (typeof window === 'undefined') return;

  for (const key of CACHE_STORAGE_KEYS) {
    try {
      window.localStorage.removeItem(key);
    } catch {
      /* ignore storage access errors */
    }
  }

  window.location.reload();
}
