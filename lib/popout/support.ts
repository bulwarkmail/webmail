/**
 * Whether "Open in new window" is on offer: an installed app or the desktop
 * app, on a device with windows. In a browser tab, a tab does the same job
 * and the app behaves as it always has.
 */

import { IS_LITE } from '@/lib/lite';
import { isStandaloneDisplayMode } from '@/lib/standalone-display';
import '@/lib/desktop/types';

export function hasDesktopWindows(): boolean {
  return typeof window !== 'undefined' && !!window.bulwarkDesktop?.windows;
}

/** Display mode is `browser` in Electron popups too, hence the bridge check. */
export function popoutsAvailable(): boolean {
  // Lite has no such route: a static export can't list every message id.
  if (IS_LITE || typeof window === 'undefined') return false;
  // Sharing the session and renewing tokens safely across windows need both.
  if (typeof BroadcastChannel === 'undefined' || !navigator.locks) return false;
  if (hasDesktopWindows()) return true;
  if (!isStandaloneDisplayMode()) return false;
  // A home-screen app on a phone or tablet has no second window: window.open
  // leaves for the browser there.
  if ((window.navigator as Navigator & { standalone?: boolean }).standalone === true) return false;
  return typeof window.matchMedia === 'function' && window.matchMedia('(pointer: fine)').matches;
}
