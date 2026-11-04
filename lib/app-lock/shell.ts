/**
 * The calls only the page itself may make to the desktop app's main process. A same-origin frame
 * reaches `bulwarkDesktop` through `parent`, and main can't tell its calls from the page's. So the
 * preload hands these out once per document, and the page takes them in its first render, before
 * any frame exists. Imports next to nothing, for lib/app-lock/vault.ts and controller.ts alike.
 */

import { getDesktopBridge } from '@/lib/desktop/bridge';
import type { DesktopAppLockBridge, DesktopAppLockControls } from '@/lib/desktop/types';

let claimedFrom: DesktopAppLockBridge | null = null;
let claimed: DesktopAppLockControls | null = null;

export function shellControls(): DesktopAppLockControls | null {
  const member = getDesktopBridge()?.appLock ?? null;
  if (member !== claimedFrom) {
    claimedFrom = member;
    claimed = member?.claim?.() ?? null;
  }
  return claimed;
}

/** A shell older than the webmail it loads has these on the bridge. */
function olderShell(): Pick<DesktopAppLockControls, 'wrap' | 'unwrap'> {
  return (getDesktopBridge()?.appLock ?? {}) as unknown as Pick<DesktopAppLockControls, 'wrap' | 'unwrap'>;
}

export function shellWrapCall(): DesktopAppLockControls['wrap'] {
  return shellControls()?.wrap ?? olderShell().wrap;
}

export function shellUnwrapCall(): DesktopAppLockControls['unwrap'] {
  return shellControls()?.unwrap ?? olderShell().unwrap;
}

/**
 * Whether this computer has a real key store the app can use. No: a browser, or Linux with no secret
 * service, and settings say so. A shell that doesn't answer isn't a no: this rejects, so nobody
 * writes a key without the layer because of it.
 */
export async function shellHasWrap(): Promise<boolean> {
  const member = getDesktopBridge()?.appLock;
  if (!member || !shellWrapCall()) return false;
  return Boolean((await member.status()).wrap);
}

/** Tests only. */
export function resetShellForTests(): void {
  claimedFrom = null;
  claimed = null;
}
