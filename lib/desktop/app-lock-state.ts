/**
 * Whether the app is locked, for everything that would show mail outside the app.
 *
 * App lock isn't built yet. When it is, its code calls setAppLockCheck once with a
 * function that answers from its own state, and calls bridge.os.setLocked on every
 * change: main then clears the tray, the jump list and delivered toasts, and strips
 * anything that still comes through. Nothing else needs to change. Until then it
 * answers false.
 */

let check: (() => boolean) | null = null;

export function setAppLockCheck(next: (() => boolean) | null): void {
  check = next;
}

export function isAppLocked(): boolean {
  return check?.() === true;
}
