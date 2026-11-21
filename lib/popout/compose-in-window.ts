/**
 * "Always write messages in a new window" in the desktop app (Settings > Desktop app, or the
 * ComposeInNewWindow policy): a composer about to open in the main window, inline or as a
 * Pro tab, opens in a window of its own instead.
 */

import { composeInWindowNow } from '@/lib/desktop/preferences';
import { useAuthStore } from '@/stores/auth-store';
import type { ComposePopoutPayload } from './compose-payload';
import { openComposerWindow } from './open';
import { hasDesktopWindows, popoutsAvailable } from './support';
import { isPopoutWindow } from './window-role';

/** The setting is on, and this window can hand a composer to another. */
export function composeInWindowHere(): boolean {
  if (!hasDesktopWindows() || !popoutsAvailable() || isPopoutWindow()) return false;
  // The demo's client has no session a window could share.
  if (useAuthStore.getState().isDemoMode) return false;
  return composeInWindowNow();
}

/**
 * Opens the composer in its own window. False when it should open here: the setting is
 * off, or no window opened. True means a window took it; should the window not show it
 * after all, `notShown` runs, and the caller opens it here then.
 */
export function openComposerInWindow(
  payload: ComposePopoutPayload,
  { localAccountId, notShown }: { localAccountId?: string | null; notShown: () => void },
): boolean {
  if (!composeInWindowHere()) return false;
  const target = openComposerWindow(localAccountId ?? useAuthStore.getState().activeAccountId);
  if (!target) return false;
  void target.handOver(payload).then((shown) => {
    if (shown) return;
    target.cancel();
    notShown();
  });
  return true;
}
