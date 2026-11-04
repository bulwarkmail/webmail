"use client";

import { useEffect, useRef } from "react";
import { getDesktopBridge } from "@/lib/desktop/bridge";
import { getDesktopPolicy, onDesktopPolicyChange } from "@/lib/desktop/policy";
import { canDownload } from "@/lib/device-policy";
import { claimFilesControls } from "@/lib/files-sync/controls";
import { FilesSyncHost as Host, type HostAccount } from "@/lib/files-sync/host";
import { registerFilesSyncLifecycle, setRunningFilesSyncHost } from "@/lib/files-sync/lifecycle";
import { scopeDecided } from "@/lib/offline/offline-mode";
import { subscribePushStateChanges } from "@/lib/push-events";
import { useAccountStore } from "@/stores/account-store";
import { useAuthStore } from "@/stores/auth-store";
import { useFilesSyncStore } from "@/stores/files-sync-store";

registerFilesSyncLifecycle();

/** `FilesFolderSyncEnabled` forced off. Main removes the folders itself; this keeps the engine off them meanwhile. */
function folderSyncForcedOff(): boolean {
  const entry = getDesktopPolicy().FilesFolderSyncEnabled;
  return entry.locked && entry.value === false;
}

/** A definite no from the organisation. An unknown policy isn't one. */
function downloadsForbidden(account: string): boolean {
  return scopeDecided(account) && !canDownload(account);
}

/**
 * Files on this computer, in the desktop app's main window (it's under MainWindowOnly): starts
 * the sync engine for the signed-in accounts and keeps it fed with push, the network and the
 * policies. Renders nothing. In a browser, or a shell without the files bridge, it does nothing.
 */
export function FilesSyncHost() {
  const hostRef = useRef<Host | null>(null);
  const accounts = useAccountStore((s) => s.accounts);
  const activeAccountId = useAuthStore((s) => s.activeAccountId);
  const isAuthenticated = useAuthStore((s) => s.isAuthenticated);
  const revision = useAuthStore((s) => s.connectedAccountsRevision);
  const client = useAuthStore((s) => s.client);

  useEffect(() => {
    const bridge = getDesktopBridge();
    const controls = bridge?.files ? claimFilesControls() : null;
    if (!bridge || !controls) return;
    const store = useFilesSyncStore.getState();
    const host = new Host({
      controls,
      platform: bridge.platform,
      publish: (patch) => useFilesSyncStore.getState().publish(patch),
      setController: (controller) => useFilesSyncStore.getState().setController(controller),
      folderSyncForcedOff,
      downloadsForbidden,
    });
    hostRef.current = host;
    setRunningFilesSyncHost(host);
    host.start();
    const stopPush = subscribePushStateChanges((change, changedClient) => {
      for (const [account, entry] of useAuthStore.getState().getAllConnectedClients()) {
        if (entry !== changedClient) continue;
        if (Object.values(change.changed).some((types) => !!types && "FileNode" in types)) host.remoteChanged(account);
      }
    });
    const stopPolicy = onDesktopPolicyChange(() => host.policyChanged());
    const online = () => host.online();
    window.addEventListener("online", online);
    return () => {
      stopPush();
      stopPolicy();
      window.removeEventListener("online", online);
      setRunningFilesSyncHost(null);
      host.stop();
      hostRef.current = null;
      store.reset();
    };
  }, []);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const clients = isAuthenticated ? useAuthStore.getState().getAllConnectedClients() : new Map();
    const list: HostAccount[] = [];
    for (const [id, entry] of clients) {
      const account = accounts.find((a) => a.id === id);
      if (account && !account.isConnected) continue;
      list.push({ id, label: account?.email || account?.username || account?.label || id, client: entry });
    }
    host.setAccounts(list, isAuthenticated ? activeAccountId : null);
  }, [accounts, activeAccountId, isAuthenticated, revision, client]);

  return null;
}
