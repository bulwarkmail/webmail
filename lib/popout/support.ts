/**
 * Whether "Open in new window" is on offer: an installed app or the desktop
 * app, on a device with windows. In a browser tab, a tab does the same job
 * for a message, and the app behaves as it always has. A composer is the
 * exception: it moves to a window of its own from a tab too, as in Gmail.
 */

import { IS_LITE } from '@/lib/lite';
import { isStandaloneDisplayMode } from '@/lib/standalone-display';
import '@/lib/desktop/types';
import { canSealSessions } from './sealed';

export function hasDesktopWindows(): boolean {
  return typeof window !== 'undefined' && !!window.bulwarkDesktop?.windows;
}

/** A second window can share this one's session, safely. */
function windowsCanShareSessions(): boolean {
  // Lite has no such route: a static export can't list every message id.
  if (IS_LITE || typeof window === 'undefined') return false;
  // Sharing the session and renewing tokens safely across windows need these.
  return typeof BroadcastChannel !== 'undefined' && !!navigator.locks && canSealSessions();
}

/** A device with a mouse or trackpad: a phone or tablet has no second window. */
function hasFinePointer(): boolean {
  return typeof window.matchMedia === 'function' && window.matchMedia('(pointer: fine)').matches;
}

/** Display mode is `browser` in Electron popups too, hence the bridge check. */
export function popoutsAvailable(): boolean {
  if (!windowsCanShareSessions()) return false;
  if (hasDesktopWindows()) return true;
  if (!isStandaloneDisplayMode()) return false;
  // A home-screen app on a phone or tablet has no second window: window.open
  // leaves for the browser there.
  if ((window.navigator as Navigator & { standalone?: boolean }).standalone === true) return false;
  return hasFinePointer();
}

/**
 * A composer can move to a window of its own: wherever a message can, and in
 * a browser tab on a computer too, where it opens as a popup window.
 */
export function composerPopoutsAvailable(): boolean {
  if (popoutsAvailable()) return true;
  if (!windowsCanShareSessions() || isStandaloneDisplayMode()) return false;
  return hasFinePointer();
}
