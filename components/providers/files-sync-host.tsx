"use client";

import { useEffect, useMemo, useRef } from "react";
import { useFormatter, useTranslations } from "next-intl";
import { activityMessage, massDeleteText, statusLineText, trayLineText } from "@/components/files-sync/files-sync-text";
import { getDesktopBridge } from "@/lib/desktop/bridge";
import { getDesktopPolicy, onDesktopPolicyChange } from "@/lib/desktop/policy";
import { canDownload } from "@/lib/device-policy";
import { claimFilesControls } from "@/lib/files-sync/controls";
import type { DriveStatusText } from "@/lib/files-sync/drive-status";
import { FilesSyncHost as Host, type HostAccount } from "@/lib/files-sync/host";
import type { FilesNotifyText } from "@/lib/files-sync/notify";
import { localActivityStore } from "@/lib/files-sync/activity-store";
import { registerFilesSyncLifecycle, setRunningFilesSyncHost } from "@/lib/files-sync/lifecycle";
import { scopeDecided } from "@/lib/offline/offline-mode";
import { subscribePushStateChanges } from "@/lib/push-events";
import { addSignOutGate } from "@/lib/sign-out-cleanup";
import { formatFileSize } from "@/lib/utils";
import { useAccountStore } from "@/stores/account-store";
import { useAuthStore } from "@/stores/auth-store";
import { useFilesSyncStore } from "@/stores/files-sync-store";
import { useSettingsStore } from "@/stores/settings-store";

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
  const tSync = useTranslations("files_sync");
  const tStorage = useTranslations("files_storage");
  const tExtra = useTranslations("files_sync_extra");
  const format = useFormatter();
  const timeFormat = useSettingsStore((s) => s.timeFormat);
  // Explorer's status for the drive, in the page's language (lib/files-sync/drive-status.ts).
  const driveText = useMemo<DriveStatusText>(() => ({
    state: (state) => tStorage(`state_${state}`),
    detail: (status, state) => statusLineText(tSync, (date, options) => format.dateTime(date, { ...options, hour12: timeFormat === "12h" }), status, state),
    quota: (used, total) => total === null
      ? tStorage("used", { used: formatFileSize(used) })
      : tStorage("used_of", { used: formatFileSize(used), total: formatFileSize(total) }),
    notice: (level) => tStorage(level === "full" ? "full" : "almost_full"),
    tray: (status, state) => trayLineText(tExtra, status, state),
  }), [tSync, tStorage, tExtra, format, timeFormat]);
  const driveTextRef = useRef(driveText);
  driveTextRef.current = driveText;
  // The OS notifications' words (files-p3-5).
  const notifyText = useMemo<FilesNotifyText>(() => ({
    massDelete: (root, massDelete) => ({
      title: tSync("mass_delete.title", { count: massDelete.count }),
      body: massDeleteText(tSync, root, massDelete),
      allow: tSync("mass_delete.allow", { count: massDelete.count }),
      restore: tSync("mass_delete.restore", { count: massDelete.count }),
    }),
    conflict: (_root, entry) => ({ title: tExtra("notify.conflict_title"), body: activityMessage(tSync, entry, formatFileSize, tExtra) }),
    problem: (_root, entry) => ({ title: tExtra("notify.problem_title"), body: activityMessage(tSync, entry, formatFileSize, tExtra) }),
  }), [tSync, tExtra]);
  const notifyTextRef = useRef(notifyText);
  notifyTextRef.current = notifyText;

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
      driveStatusText: () => driveTextRef.current,
      notify: (notification) => {
        void bridge.os?.notify(notification).catch(() => null);
      },
      notifyText: () => notifyTextRef.current,
      activityStore: localActivityStore(),
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
    // Signing out on purpose: what waits in the drive goes up first, or the user stays signed in.
    // Synced folders keep their files, so they don't ask.
    const stopGate = addSignOutGate((accountId) => host.signOutGate(accountId));
    const online = () => host.online();
    window.addEventListener("online", online);
    return () => {
      stopPush();
      stopPolicy();
      stopGate();
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

  // Another language: Explorer's words change with it.
  useEffect(() => {
    hostRef.current?.publishNow();
  }, [driveText]);

  return null;
}
