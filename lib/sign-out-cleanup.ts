import { forgetAppLockAtSignOut } from '@/lib/app-lock/sign-out';
import { fileStorage } from '@/lib/plugin-storage';
import { clearHandoffs } from '@/lib/launch-handoff';
import { clearAllCheckpoints } from '@/lib/mail-import/checkpoints';
import { clearDesktopSurfaces, getDesktopBridge } from '@/lib/desktop/bridge';
import { sweepPrivateExports } from '@/lib/mail-export/sinks';
import { purgeStoreFiles } from '@/lib/store/client/purge';

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
  'calendar-alert-claims',
  // Open tabs name messages and their subjects.
  'pro-tabs',
  'search-history-storage',
  'files-favorites',
  'files-recent-files',
  'files-last-parent-id',
  'files-path-stack',
  // Names of the people the user gave access to (Settings > Sharing).
  'bulwark-delegate-names',
  // The last organisation policy (stores/policy-store.ts POLICY_CACHE_KEY):
  // its scopes, labels and notices are the signed-in user's.
  'bulwark-policy-last',
  // Offline mode's "Keep mail on this device" (lib/offline/state.ts): the
  // next person signing in here starts with it off.
  'bulwark-offline-accounts',
  // Which accounts' data waits for a new sign-in, and until when.
  'bulwark-offline-evicted',
  'bulwark-offline-evicted-owners',
  'bulwark-offline-owners',
  'bulwark-store-opened',
  // What each account chose to keep, and what's known about its store.
  'bulwark-offline-scope',
  'bulwark-offline-health',
];

const LOCAL_STORE_KEYS = new Set(['bulwark-offline-accounts', 'bulwark-offline-evicted', 'bulwark-offline-evicted-owners', 'bulwark-store-opened', 'bulwark-offline-scope', 'bulwark-offline-health']);

/** What's the accounts' but isn't the local store's: a wipe of one account that leaves others signed in takes these too. */
export const ACCOUNT_STORAGE_KEYS = SIGNED_OUT_STORAGE_KEYS.filter((key) => !LOCAL_STORE_KEYS.has(key));

const SIGNED_OUT_SIGNAL = 'bulwark:signed-out';
export { SIGNED_OUT_SIGNAL as SIGNED_OUT_KEY };

// Stores the auth store can't import (they import it) clear themselves here.
const signedOutCleanups = new Set<(options: SignOutCleanupOptions) => void>();

export interface SignOutCleanupOptions {
  /**
   * Keep the local store and its keys. For a sign-out the app decided on
   * because it couldn't confirm the login (an outage, an unknown refusal), or
   * when an account that was dropped that way still has data here.
   */
  keepLocalStore?: boolean;
  /** A forgotten PIN goes through this with the lock still up: it lifts the lock itself, last. */
  keepAppLock?: boolean;
}

/** Run `cleanup` when everyone signs out in this tab. */
export function onFullSignOut(cleanup: (options: SignOutCleanupOptions) => void): void {
  signedOutCleanups.add(cleanup);
}

// Work that has to reach the server before an account signs out (changes
// still queued for it). The auth store waits for it within its sign-out
// budget, next to the plugins' onBeforeLogout.
const beforeSignOutTasks = new Set<(accountId: string, options: SignOutCleanupOptions) => Promise<void>>();

/** Run `task` before an account signs out; `accountId` is 'all' when every account does. */
export function onBeforeSignOut(task: (accountId: string, options: SignOutCleanupOptions) => Promise<void>): () => void {
  beforeSignOutTasks.add(task);
  return () => beforeSignOutTasks.delete(task);
}

// Questions a sign-out the user asked for has to pass first, such as "2
// messages haven't been sent" (offline mode). An automatic sign-out (the
// session limits) doesn't ask.
const signOutGates = new Set<(accountId: string) => Promise<boolean>>();

/** Ask before a sign-out the user started; false from `gate` keeps everyone signed in. */
export function addSignOutGate(gate: (accountId: string) => Promise<boolean>): () => void {
  signOutGates.add(gate);
  return () => signOutGates.delete(gate);
}

export async function passSignOutGates(accountId: string): Promise<boolean> {
  for (const gate of [...signOutGates]) {
    try {
      if (!(await gate(accountId))) return false;
    } catch {
      // A broken question doesn't keep anyone signed in.
    }
  }
  return true;
}

export async function runBeforeSignOut(accountId: string, options: SignOutCleanupOptions = {}): Promise<void> {
  await Promise.all([...beforeSignOutTasks].map((task) => task(accountId, options).catch(() => {})));
}

/** Remove the accounts' leftovers from browser storage. */
export function purgeSignedOutData(options: SignOutCleanupOptions = {}): void {
  if (typeof window === 'undefined') return;
  for (const key of SIGNED_OUT_STORAGE_KEYS) {
    if (options.keepLocalStore && LOCAL_STORE_KEYS.has(key)) continue;
    try {
      window.localStorage.removeItem(key);
    } catch {
      /* storage unavailable */
    }
  }
  // Attachment bytes a plugin staged for an upload that never started.
  void fileStorage.clearFiles().catch(() => {});
  // Company calendar events (lib/company-calendars.ts), also when the
  // calendar was never opened in this tab.
  try {
    window.indexedDB?.deleteDatabase('bulwark-company-calendars');
  } catch {
    /* storage unavailable */
  }
  // Where mail imports stopped: file names and folders of the accounts.
  void clearAllCheckpoints().catch(() => {});
  // Mail exports written to the browser's private files and not deleted yet.
  void sweepPrivateExports({ force: true }).catch(() => {});
  // Offline mode (#523): the local store with the mail and the outbox, the keys
  // it was encrypted with, and the app shell the service worker kept. Also the
  // database of older versions, in case it wasn't moved yet.
  if (!options.keepLocalStore) {
    void purgeStoreFiles().catch(() => {});
    try {
      window.indexedDB?.deleteDatabase('bulwark-offline');
    } catch {
      /* storage unavailable */
    }
    forgetOfflineShell();
  }
  // With no store left, the app lock has nothing to guard, and a next person shouldn't meet it.
  if (!options.keepLocalStore && !options.keepAppLock) void forgetAppLockAtSignOut();
  // Files and links on their way into a draft or an import.
  clearHandoffs();
  clearDesktopSurfaces();
  // Nothing new goes in the HTTP cache, but a profile from an older version has mail in it.
  // A browser gives a page no way to empty it.
  void getDesktopBridge()?.httpCache?.clear().catch(() => {});
  for (const cleanup of signedOutCleanups) {
    try {
      cleanup(options);
    } catch {
      /* one store failing must not keep the others' data */
    }
  }
}

/** The service worker stops keeping the app shell and its copies go. */
function forgetOfflineShell(): void {
  try {
    navigator.serviceWorker?.controller?.postMessage({ type: 'offline-shell', on: false });
  } catch {
    /* no service worker */
  }
  try {
    if (typeof caches === 'undefined') return;
    void caches.keys()
      // The shell, and the push notifications' state (which messages were
      // shown, the quiet hours), which belongs to the accounts too.
      .then((keys) => Promise.all(keys.filter((key) => key.startsWith('bulwark-shell-') || key === 'bulwark-push-state-v1').map((key) => caches.delete(key))))
      .then(() => caches.open('bulwark-sw-state-v1'))
      .then((cache) => cache.put('/__bulwark/offline-shell', new Response(JSON.stringify({ on: false }), { headers: { 'Content-Type': 'application/json' } })))
      .catch(() => {});
  } catch {
    /* no Cache API */
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
