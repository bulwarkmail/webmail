"use client";

import type { ReactNode } from "react";
import { useTranslations } from "next-intl";
import { AlertCircle, CheckCircle2, Clock, Cloud, CloudOff, FolderOpen, Pin, RefreshCw, type AppIcon } from "@/components/icons";
import { Button } from "@/components/ui/button";
import { ContextMenuItem } from "@/components/ui/context-menu";
import { getDesktopBridge } from "@/lib/desktop/bridge";
import { cn } from "@/lib/utils";
import type { FilesSyncItemStatus } from "@/lib/files-sync/types";
import { useFilesSyncStore } from "@/stores/files-sync-store";
import { toast } from "@/stores/toast-store";
import { showInKey } from "./files-sync-text";

/*
 * Files on this computer, on the Files screen: "Show in Explorer" (Finder, file
 * manager) on a file or folder a synced folder or the drive covers, and its sync
 * status on rows and in the details panel. All of it reads stores/files-sync-store.ts
 * and calls the engine's controller; nothing shows outside the desktop app.
 */

const ITEM_ICONS: Record<FilesSyncItemStatus, { icon: AppIcon; className: string }> = {
  synced: { icon: CheckCircle2, className: "text-green-600 dark:text-green-400" },
  syncing: { icon: RefreshCw, className: "text-primary animate-spin motion-reduce:animate-none" },
  pending: { icon: Clock, className: "text-muted-foreground" },
  error: { icon: AlertCircle, className: "text-destructive" },
  "online-only": { icon: Cloud, className: "text-muted-foreground" },
};

/** The node's sync status, when the engine has one for it. */
function useItemStatus(nodeId: string): FilesSyncItemStatus | null {
  return useFilesSyncStore((s) => (s.available ? s.items[nodeId] ?? null : null));
}

/** "Show in Explorer" for a node a root covers, or null. */
export function useShowInFolder(nodeId: string | null | undefined): { label: string; run: () => void } | null {
  const t = useTranslations("files_sync");
  const available = useFilesSyncStore((s) => s.available);
  const controller = useFilesSyncStore((s) => s.controller);
  // Coverage changes with the roots and what the engine knows of the tree.
  useFilesSyncStore((s) => s.roots);
  useFilesSyncStore((s) => s.items);
  if (!available || !controller || !nodeId) return null;
  if (!controller.coverage(nodeId)) return null;
  return {
    label: t(showInKey(getDesktopBridge()?.platform)),
    run: () => {
      void controller.showInFolder(nodeId).then(
        (shown) => { if (!shown) toast.error(t("show_in.failed")); },
        () => toast.error(t("show_in.failed")),
      );
    },
  };
}

/**
 * The Files screen's header: the folder on screen in Explorer (Finder, file manager), when a
 * root covers it; at the top of Files with the drive on, the drive itself (files-p3-9).
 */
export function useShowFolderOnScreen(folderId: string | null): { label: string; run: () => void } | null {
  const t = useTranslations("files_sync");
  const available = useFilesSyncStore((s) => s.available);
  const controller = useFilesSyncStore((s) => s.controller);
  const account = useFilesSyncStore((s) => s.account);
  const roots = useFilesSyncStore((s) => s.roots);
  useFilesSyncStore((s) => s.items);
  if (!available || !controller) return null;
  const label = t(showInKey(getDesktopBridge()?.platform));
  const fail = () => toast.error(t("show_in.failed"));
  if (folderId && controller.coverage(folderId)) {
    return { label, run: () => { void controller.showInFolder(folderId).then((shown) => { if (!shown) fail(); }, fail); } };
  }
  const drive = folderId === null ? roots.find((root) => root.kind === "drive" && root.account === account) : undefined;
  if (!drive) return null;
  return { label, run: () => { void controller.openRoot(drive.id).then((shown) => { if (!shown) fail(); }, fail); } };
}

/**
 * "Keep offline" on a row: in the drive it's Explorer's "Always keep on this device" / "Free up
 * space", the same state both ways (files-p3-8); anywhere else the app's own offline copy
 * (`fallback`) as before.
 */
export function KeepOnDeviceMenuItem({ nodeId, onRan, fallback }: { nodeId: string; onRan: () => void; fallback: ReactNode }) {
  const t = useTranslations("files_sync_extra.pin");
  const controller = useFilesSyncStore((s) => s.controller);
  const available = useFilesSyncStore((s) => s.available);
  const kept = useFilesSyncStore((s) => !!s.keptOnDevice[nodeId]);
  useFilesSyncStore((s) => s.items);
  const setKept = controller?.setKeptOnDevice;
  const inDrive = available && !!setKept && controller?.coverage(nodeId)?.kind === "drive";
  if (!inDrive || !setKept) return <>{fallback}</>;
  return (
    <ContextMenuItem
      icon={kept ? CloudOff : Pin}
      label={kept ? t("free") : t("keep")}
      testId="files-sync-keep-on-device"
      onClick={() => {
        onRan();
        void setKept(nodeId, !kept).then((done) => { if (!done) toast.error(t("failed")); }, () => toast.error(t("failed")));
      }}
    />
  );
}

/** The menu entry of a row on the Files screen. */
export function ShowInFolderMenuItem({ nodeId, onRan }: { nodeId: string; onRan: () => void }) {
  const showIn = useShowInFolder(nodeId);
  if (!showIn) return null;
  return <ContextMenuItem icon={FolderOpen} label={showIn.label} testId="files-sync-show-in" onClick={() => { onRan(); showIn.run(); }} />;
}

/** The same in the details panel's buttons. */
export function ShowInFolderButton({ nodeId }: { nodeId: string }) {
  const showIn = useShowInFolder(nodeId);
  if (!showIn) return null;
  return (
    <Button size="sm" variant="outline" className="h-8 gap-1.5" onClick={showIn.run} data-testid="files-sync-show-in">
      <FolderOpen className="w-4 h-4" />{showIn.label}
    </Button>
  );
}

/** A small icon on a row, named for screen readers and on hover. */
export function FilesSyncBadge({ nodeId, className }: { nodeId: string; className?: string }) {
  const t = useTranslations("files_sync");
  const status = useItemStatus(nodeId);
  if (!status) return null;
  const { icon: Icon, className: iconClass } = ITEM_ICONS[status];
  const label = t(`item.${status}`);
  return (
    <span role="img" aria-label={label} title={label} className="inline-flex shrink-0" data-files-sync-item={status}>
      <Icon className={cn("w-3.5 h-3.5", iconClass, className)} aria-hidden="true" />
    </span>
  );
}

/** "On this computer: Synced", a row of the details panel's list. */
export function FilesSyncDetailsRow({ nodeId }: { nodeId: string }) {
  const t = useTranslations("files_sync");
  const status = useItemStatus(nodeId);
  if (!status) return null;
  const { icon: Icon, className: iconClass } = ITEM_ICONS[status];
  return (
    <div data-files-sync-item={status}>
      <dt className="text-xs text-muted-foreground">{t("item.label")}</dt>
      <dd className="flex items-center gap-1.5">
        <Icon className={cn("w-3.5 h-3.5 shrink-0", iconClass)} aria-hidden="true" />
        {t(`item.${status}`)}
      </dd>
    </div>
  );
}
