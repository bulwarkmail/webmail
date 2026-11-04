import { getDesktopBridge } from './bridge';

/**
 * The desktop app's connections were closed under the page: at the last sign-out with a client
 * certificate in use, when a policy changed, or when Chromium's network process crashed. A
 * request under way then never settles, as Electron's request proxy doesn't pass the loss on. So
 * main says so, and whoever holds a request gives up on it. Nothing happens in a browser.
 */

let wiredTo: unknown = null;
const listeners = new Set<() => void>();

/** Null where there's nothing to listen to: in a browser, or on an older shell. */
export function onConnectionsReset(listener: () => void): (() => void) | null {
  const bridge = getDesktopBridge();
  const subscribe = bridge?.certificates?.onConnectionsReset;
  if (!subscribe) return null;
  if (wiredTo !== bridge) {
    wiredTo = bridge;
    subscribe(() => {
      for (const each of [...listeners]) each();
    });
  }
  listeners.add(listener);
  return () => listeners.delete(listener);
}
