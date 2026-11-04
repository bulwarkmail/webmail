/**
 * The desktop app's Files on this computer calls, taken once per document in its first render
 * (WindowControlsHost), as auth.claim and appLock.claim are: a same-origin plugin frame
 * reaches `bulwarkDesktop` through `parent`, and main can't tell its calls from the page's.
 * Whoever comes after the page gets nothing from the preload. Main also answers only the main
 * window, so a pop-out's own claim is just its share of nothing.
 */

import { getDesktopBridge } from '@/lib/desktop/bridge';
import type { FilesBridge, FilesControls } from '@/lib/desktop/types';

let claimedFrom: FilesBridge | null | undefined;
let claimed: FilesControls | null = null;

export function claimFilesControls(): FilesControls | null {
  const member = getDesktopBridge()?.files ?? null;
  if (member !== claimedFrom) {
    claimedFrom = member;
    claimed = member?.claim?.() ?? null;
  }
  return claimed;
}

/** Tests only. */
export function resetFilesControlsForTests(): void {
  claimedFrom = undefined;
  claimed = null;
}
