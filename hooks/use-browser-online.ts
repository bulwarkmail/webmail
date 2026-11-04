"use client";

import { useSyncExternalStore } from "react";

function subscribe(onChange: () => void): () => void {
  window.addEventListener("online", onChange);
  window.addEventListener("offline", onChange);
  return () => {
    window.removeEventListener("online", onChange);
    window.removeEventListener("offline", onChange);
  };
}

/**
 * Whether the browser says it has a network, kept up to date. Also without
 * offline mode, whose store only follows it while that runs. True on the
 * server and while the page hydrates.
 */
export function useBrowserOnline(): boolean {
  return useSyncExternalStore(subscribe, () => navigator.onLine !== false, () => true);
}
