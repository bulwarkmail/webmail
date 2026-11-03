/**
 * Whether the app is locked, for everything that would show mail outside the app.
 *
 * lib/app-lock/controller.ts calls setAppLockCheck once, at the start of each page, with
 * a function that answers from its own state. Main keeps its own answer for the tray, the
 * jump list and toasts (the shell's app-lock-gate.ts).
 */

let check: (() => boolean) | null = null;

export function setAppLockCheck(next: (() => boolean) | null): void {
  check = next;
}

export function isAppLocked(): boolean {
  return check?.() === true;
}
