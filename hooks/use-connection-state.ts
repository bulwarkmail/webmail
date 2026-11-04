"use client";

import { useSyncExternalStore } from "react";
import { serverKey, useOfflineStore } from "@/lib/offline/state";
import { offlineAllowed } from "@/lib/offline/offline-mode";
import { useAuthStore } from "@/stores/auth-store";

function subscribeOnline(callback: () => void): () => void {
  window.addEventListener("online", callback);
  window.addEventListener("offline", callback);
  return () => {
    window.removeEventListener("online", callback);
    window.removeEventListener("offline", callback);
  };
}

export interface ConnectionState {
  /** No network, or the open account's mail server can't be reached. */
  offline: boolean;
  /**
   * Changes to messages still work: online, or the account keeps its mail on this
   * device and the change waits for the connection. Folders, rules and sharing
   * always need the server.
   */
  canChangeMail: boolean;
}

/** What the menus go by to grey out what can't work without a connection. */
export function useConnectionState(): ConnectionState {
  const account = useAuthStore((s) => s.activeAccountId);
  const server = useAuthStore((s) => s.serverUrl);
  const navigatorOffline = useSyncExternalStore(
    subscribeOnline,
    () => navigator.onLine === false,
    () => false,
  );
  const storeOffline = useOfflineStore((s) => s.browserOffline || (!!server && s.downServers.includes(serverKey(server))));
  const keepsMail = useOfflineStore((s) => !!account && s.enabled.includes(account));
  const offline = navigatorOffline || storeOffline;
  return { offline, canChangeMail: !offline || (keepsMail && offlineAllowed(account)) };
}
