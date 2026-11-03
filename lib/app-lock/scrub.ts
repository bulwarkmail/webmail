/**
 * What the app keeps in plain browser storage that names mail. A lock must not leave
 * it readable, so it goes before the lock screen comes up. Text that could not be saved
 * anywhere else is sealed first (see lib/app-lock/vault.ts).
 */

import { sealDraft } from './vault';

/** Subjects and senders: a list snapshot for a fast start, and the Pro tabs' names. */
const LOCAL_KEYS = ['email-snapshot', 'pro-tabs'];
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
  for (const key of LOCAL_KEYS) {
    try {
      localStorage.removeItem(key);
    } catch {
      // As above.
    }
  }
}
