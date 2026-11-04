"use client";

import { useTranslations } from "next-intl";
import { AlertCircle, CheckCircle2, Clock, Cloud, FolderOpen, RefreshCw, type AppIcon } from "@/components/icons";
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
