/**
 * The sign-out's side of the lock. Apart from controller.ts because lib/sign-out-cleanup.ts
 * is in every page's bundle and is imported by what the controller imports.
 */

import { getDesktopBridge } from '@/lib/desktop/bridge';
import { writeAppLockFile } from './state';
import { deleteVault } from './vault';

/** Nobody is left to lock for. Main only lets go without asking while it's unlocked. */
export function forgetAppLockAtSignOut(): void {
  void deleteVault();
  writeAppLockFile({ on: false, locked: false });
  void getDesktopBridge()?.appLock?.forget().catch(() => false);
}
