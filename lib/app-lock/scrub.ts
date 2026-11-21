/**
 * What the app keeps in plain browser storage that names mail. A lock must not leave
 * it readable, so it goes before the lock screen comes up. Text that could not be saved
 * anywhere else is sealed first (see lib/app-lock/vault.ts).
 */

import { openSealedLocal, sealDraft, sealLocal } from './vault';

/**
 * Subjects and senders: a list snapshot for a fast start, and the Pro tabs' names. And which
 * opened messages passed the sender check (lib/receipt-answers.ts), by login, account and blob id.
 */
const LOCAL_KEYS = ['email-snapshot', 'pro-tabs', 'bulwark-receipt-checked'];
/** People's names, and what notices said. Nothing fetches these back, so they wait sealed for the unlock. */
const SEALED_LOCAL_KEYS = ['contact-storage', 'notification-center'];
const SESSION_KEYS = ['bulwark-offline-lost'];
const SESSION_PREFIXES = ['bulwark-popout-compose:'];
const RESCUED_KEY = 'bulwark-rescued-drafts';

function removeSessionKeys(): void {
  for (const key of SESSION_KEYS) sessionStorage.removeItem(key);
  for (let index = sessionStorage.length - 1; index >= 0; index -= 1) {
    const key = sessionStorage.key(index);
    if (key && SESSION_PREFIXES.some((prefix) => key.startsWith(prefix))) sessionStorage.removeItem(key);
  }
}

export async function scrubBrowserStorage(): Promise<void> {
  try {
    const raw = sessionStorage.getItem(RESCUED_KEY);
    const rescued: unknown = raw ? JSON.parse(raw) : [];
    if (Array.isArray(rescued)) for (const draft of rescued) await sealDraft(draft);
    sessionStorage.removeItem(RESCUED_KEY);
  } catch {
    // Nothing readable to keep.
  }
  try {
    removeSessionKeys();
  } catch {
    // Storage blocked: nothing was kept there either.
  }
  for (const key of SEALED_LOCAL_KEYS) {
    try {
      const value = localStorage.getItem(key);
      if (value === null) continue;
      await sealLocal(key, value).catch(() => false);
      localStorage.removeItem(key);
    } catch {
      // As above.
    }
  }
  for (const key of LOCAL_KEYS) {
    try {
      localStorage.removeItem(key);
    } catch {
      // As above.
    }
  }
}

/** Puts back what a lock sealed. Only the tab with the lock key can. */
export async function restoreSealedStorage(lockKey: CryptoKey): Promise<void> {
  try {
    for (const [key, value] of await openSealedLocal(lockKey)) localStorage.setItem(key, value);
  } catch {
    // They stay sealed for the next unlock.
  }
}

/** The stores read storage once, at import: before anyone unlocked. They read it again now. */
export async function reloadSealedStores(): Promise<void> {
  try {
    const { reloadNotificationCenter } = await import('@/stores/notification-center-store');
    reloadNotificationCenter();
    const { useContactStore } = await import('@/stores/contact-store');
    await useContactStore.persist?.rehydrate();
  } catch {
    // What's on disk is there at the next load.
  }
}
