/**
 * The browser's side of keeping mail: whether it promised not to clear it, and
 * whether it did anyway. Nothing here holds account content.
 */

import { isStandaloneDisplayMode } from '@/lib/standalone-display';
import { useOfflineStore } from './state';

export type PersistState = 'unknown' | 'granted' | 'refused' | 'unsupported';

/**
 * Asks the browser not to clear this site's data when space runs low, and
 * remembers the answer for the settings page. Chromium decides by itself and
 * may say no until the app is installed; Firefox asks the user.
 */
export async function requestPersistence(): Promise<PersistState> {
  let state: PersistState = 'unsupported';
  try {
    if (typeof navigator.storage?.persist === 'function') state = (await navigator.storage.persist()) ? 'granted' : 'refused';
  } catch {
    state = 'refused';
  }
  useOfflineStore.setState({ persist: state });
  return state;
}

/** What the browser last said, without asking. */
export async function readPersistence(): Promise<PersistState> {
  let state: PersistState = 'unsupported';
  try {
    if (typeof navigator.storage?.persisted === 'function') state = (await navigator.storage.persisted()) ? 'granted' : 'refused';
  } catch {
    state = 'unknown';
  }
  useOfflineStore.setState({ persist: state });
  return state;
}

/**
 * Safari deletes a site's data after 7 days without a visit, unless the site is
 * on the home screen or in the Dock. On iPhone and iPad every browser runs on
 * the same engine, so Chrome and Firefox there count too. Chromium on a Mac or
 * Windows, and the desktop app, say "Chrome" in the user agent.
 */
export function safariMayDelete(userAgent: string = typeof navigator === 'undefined' ? '' : navigator.userAgent, installed: boolean = isStandaloneDisplayMode()): boolean {
  if (installed) return false;
  if (!/AppleWebKit/.test(userAgent) || !/Version\/|CriOS|FxiOS|EdgiOS|OPiOS/.test(userAgent)) return false;
  if (/iPhone|iPad|iPod/.test(userAgent)) return true;
  return /Macintosh/.test(userAgent) && /Safari\//.test(userAgent) && !/Chrome|Chromium|Edg\/|OPR\//.test(userAgent);
}
