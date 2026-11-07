/**
 * Settings someone changed on the sign-in page, before any account was
 * signed in: the language, and the options in its Accessibility panel.
 *
 * Signing in on a device that another account used last starts from the
 * defaults (stores/settings-store.ts, resetSyncedState), so the settings of
 * the account before don't carry over. These are the visitor's own, though:
 * the larger text they needed to read the form must still be there on the
 * other side of it. The reset keeps them and the first load from the server
 * forgets the list.
 */

const KEY = 'signed-out-choices';

function read(): string[] {
  try {
    if (typeof window === 'undefined') return [];
    const raw = JSON.parse(window.localStorage.getItem(KEY) ?? '[]');
    return Array.isArray(raw) ? raw.filter((key): key is string => typeof key === 'string') : [];
  } catch {
    return [];
  }
}

/** Remember that these settings were chosen while signed out. */
export function noteSignedOutChoice(...keys: string[]): void {
  try {
    if (typeof window === 'undefined' || keys.length === 0) return;
    window.localStorage.setItem(KEY, JSON.stringify([...new Set([...read(), ...keys])]));
  } catch {
    /* storage unavailable */
  }
}

/** The settings chosen while signed out, since the last sign-in. */
export function signedOutChoices(): string[] {
  return read();
}

/** A sign-in has taken them over. */
export function forgetSignedOutChoices(): void {
  try {
    if (typeof window !== 'undefined') window.localStorage.removeItem(KEY);
  } catch {
    /* storage unavailable */
  }
}
