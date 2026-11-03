/**
 * Finds the desktop app's bridge. Everything here is feature detected: in a
 * browser there's no bridge, and a newer bridge version than this code knows
 * is treated as absent rather than guessed at.
 */

import { DESKTOP_BRIDGE_VERSION, type BulwarkDesktopBridge } from './types';

export function getDesktopBridge(): BulwarkDesktopBridge | null {
  if (typeof window === 'undefined') return null;
  const bridge = window.bulwarkDesktop;
  if (!bridge || typeof bridge !== 'object') return null;
  if (typeof bridge.version !== 'number' || bridge.version > DESKTOP_BRIDGE_VERSION) return null;
  return bridge;
}

/** Nothing added for this server stays: see DesktopServersBridge. */
export function forgetDesktopServer(serverUrl: string, reason: 'failed' | 'signed-out'): void {
  getDesktopBridge()?.servers?.forget?.(serverUrl, reason);
}

/** True in any window of the desktop app, standalone or on an instance. */
export function isDesktopApp(): boolean {
  return getDesktopBridge() !== null;
}
