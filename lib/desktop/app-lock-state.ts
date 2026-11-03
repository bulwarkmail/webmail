/**
 * Whether the app is locked, for everything that would show mail outside the app.
 *
 * lib/app-lock/controller.ts calls setAppLockCheck once, at the start of each page, with
 * a function that answers from its own state, and calls bridge.os.setLocked(true) when it
 * locks. components/desktop/desktop-os-host.tsx says it's open again when the app starts
 * behind the lock. Main then clears the tray, the jump list and delivered toasts, and strips
 * anything that still comes through. Main keeps its own answer too (the shell's
 * app-lock-gate.ts), which stands over what any page says.
 */

let check: (() => boolean) | null = null;

export function setAppLockCheck(next: (() => boolean) | null): void {
  check = next;
}

export function isAppLocked(): boolean {
  return check?.() === true;
}
