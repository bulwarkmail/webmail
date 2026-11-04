"use client";

import { useFormatter, useTranslations } from "next-intl";
import { AlertCircle, AlertTriangle, CheckCircle2, CloudOff, Loader2, Lock, Pause, RefreshCw, type AppIcon } from "@/components/icons";
import { cn } from "@/lib/utils";
import type { FilesSyncRootState, FilesSyncRootStatus } from "@/lib/files-sync/types";
import { statusLineText } from "./files-sync-text";

const ICONS: Record<FilesSyncRootState, { icon: AppIcon; className: string }> = {
  starting: { icon: Loader2, className: "text-muted-foreground animate-spin motion-reduce:animate-none" },
  syncing: { icon: RefreshCw, className: "text-primary animate-spin motion-reduce:animate-none" },
  idle: { icon: CheckCircle2, className: "text-green-600 dark:text-green-400" },
  paused: { icon: Pause, className: "text-muted-foreground" },
  offline: { icon: CloudOff, className: "text-muted-foreground" },
  error: { icon: AlertCircle, className: "text-destructive" },
  "confirm-delete": { icon: AlertTriangle, className: "text-amber-600 dark:text-amber-400" },
  blocked: { icon: Lock, className: "text-muted-foreground" },
};

/** One line saying how a root is doing: up to date, syncing, paused, offline, stopped. */
export function FilesSyncStatusLine({ status, paused, className }: {
  status: FilesSyncRootStatus | undefined;
  /** The root says it's paused; the engine may not have said so yet. */
  paused?: boolean;
  className?: string;
}) {
  const t = useTranslations("files_sync");
  const format = useFormatter();
  const state: FilesSyncRootState = status?.state ?? (paused ? "paused" : "starting");

  const text = statusLineText(t, (date, options) => format.dateTime(date, options), status, state);
  const { icon: Icon, className: iconClass } = ICONS[state];
  return (
    <p className={cn("flex items-center gap-1.5 text-xs", state === "error" ? "text-destructive" : "text-muted-foreground", className)} data-files-sync-state={state}>
      <Icon className={cn("w-3.5 h-3.5 shrink-0", iconClass)} aria-hidden="true" />
      <span>{text}</span>
    </p>
  );
}
