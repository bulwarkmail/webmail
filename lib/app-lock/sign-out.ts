/**
 * The sign-out's side of the lock, and what a forgotten PIN leaves to do. Apart from
 * controller.ts because lib/sign-out-cleanup.ts is in every page's bundle and is imported
 * by what the controller imports.
 */

import { apiFetch } from '@/lib/browser-navigation';
import { getDesktopBridge } from '@/lib/desktop/bridge';
import { writeAppLockFile } from './state';
import { deleteVault } from './vault';

/** The session cookies are HttpOnly, so only the server can delete them, and it may be out of reach. */
export const COOKIES_TO_CLEAR_KEY = 'bulwark-cookies-to-clear';
/** The next login has to be a real one. See `requireFreshLogin`. */
export const FRESH_LOGIN_KEY = 'bulwark-fresh-login';

const COOKIE_CLEAR_MS = 3_000;

/** What shows main the tab really holds the key, in this tab's memory for as long as it does. */
let heldProof: Uint8Array | null = null;

export function rememberMainProof(proof: Uint8Array | null): void {
  heldProof = proof;
}

/**
 * Nobody is left to lock for. The tab with the key shows main its proof. Any other tab has
 * none, and main asks the user natively: a word from a page can't take a lock away.
 */
export async function forgetAppLockAtSignOut(): Promise<void> {
  const gone = deleteVault();
  writeAppLockFile({ on: false, locked: false });
  const proof = heldProof;
  heldProof = null;
  void getDesktopBridge()?.appLock?.forget(proof ?? undefined).catch(() => false);
  await gone;
}

function mark(key: string, on: boolean): void {
  try {
    if (on) localStorage.setItem(key, '1');
    else localStorage.removeItem(key);
  } catch {
    // Storage blocked: nothing was kept there either.
  }
}

function marked(key: string): boolean {
  try {
    return localStorage.getItem(key) !== null;
  } catch {
    return false;
  }
}

/** Before anything else in a forgotten PIN: from here on a leftover cookie mustn't sign anyone in. */
export function markCookiesToClear(): void {
  mark(COOKIES_TO_CLEAR_KEY, true);
}

/**
 * Tries the DELETE when a mark says it's due. True when nothing is left to clear. While it's
 * false, a cookie may still be there, and nothing may adopt it (stores/auth-store.ts).
 */
export async function clearPendingCookies(): Promise<boolean> {
  if (!marked(COOKIES_TO_CLEAR_KEY)) return true;
  const asked = Promise.all(['/api/auth/session?all=true', '/api/auth/token?all=true'].map((path) => (
    apiFetch(path, { method: 'DELETE', keepalive: true, signal: AbortSignal.timeout(COOKIE_CLEAR_MS) })
  ))).then((answers) => answers.every((answer) => answer.ok)).catch(() => false);
  // A server that hangs mustn't keep a start or a way out waiting.
  const cleared = await Promise.race([asked, new Promise<boolean>((resolve) => setTimeout(() => resolve(false), COOKIE_CLEAR_MS))]);
  if (cleared) mark(COOKIES_TO_CLEAR_KEY, false);
  return cleared;
}

/**
 * A forgotten PIN leaves the identity provider's session open: ending it takes the server
 * and a page of the provider's, and it isn't only this app's to end. So anyone at this
 * device could walk back in through it with no PIN and no password. The next login asks
 * the provider for a real one (`prompt=login`, in the flows that go through it). A provider
 * may ignore that, and the settings text doesn't promise more than asking.
 */
export function requireFreshLogin(): void {
  mark(FRESH_LOGIN_KEY, true);
}

export function freshLoginRequired(): boolean {
  return marked(FRESH_LOGIN_KEY);
}

export function freshLoginDone(): void {
  mark(FRESH_LOGIN_KEY, false);
}
